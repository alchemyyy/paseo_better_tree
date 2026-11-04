import { execCommand } from "@getpaseo/plugin/server";

// PowerShell starts in about a quarter second and Explorer lists its windows in a few hundred
// milliseconds more; past this, Explorer is not answering and a new window opens instead
const SHOW_TIMEOUT_MS = 10_000;
const FOLDER_VARIABLE = "BETTER_TREE_SHOW_FOLDER";
const ITEM_VARIABLE = "BETTER_TREE_SHOW_ITEM";

/**
 * Finds the Explorer windows (and Windows 11 tabs, which share their window's handle) showing the
 * folder on this virtual desktop, takes the one used last, switches to its tab, selects the item,
 * and brings the window to the front; should Windows still keep it back, it flashes the window's
 * taskbar button instead. Prints `shown`, or `none` when no window shows the folder. The folder
 * and item arrive through the environment, so they are never parsed as part of a command line.
 */
const SHOW_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
# Module auto-loading reports progress on stderr otherwise
$ProgressPreference = 'SilentlyContinue'
$wanted = $env:BETTER_TREE_SHOW_FOLDER.TrimEnd('\')
$item = $env:BETTER_TREE_SHOW_ITEM
function Test-Same([string]$left, [string]$right) { [string]::Equals($left, $right, [StringComparison]::OrdinalIgnoreCase) }

$shell = New-Object -ComObject Shell.Application
$tabs = @{}
$candidates = [Collections.Generic.List[object]]::new()
foreach ($window in @($shell.Windows())) {
  try {
    if ([IO.Path]::GetFileName($window.FullName) -ne 'explorer.exe') { continue }
    $folder = $window.Document.Folder.Self.Path.TrimEnd('\')
    $key = [long]$window.HWND
    if (-not $tabs.ContainsKey($key)) { $tabs[$key] = [Collections.Generic.List[object]]::new() }
    $tabs[$key].Add(@($window.LocationName, $folder))
    if (Test-Same $folder $wanted) { $candidates.Add($window) }
  } catch {}
}
if ($candidates.Count -eq 0) { 'none'; exit }

# user32 through reflection emit: Add-Type would start the C# compiler, about half a second
$type = [AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('BetterTreeWindows'), 'Run').DefineDynamicModule('BetterTreeWindows').DefineType('Native', 'Public, Class')
foreach ($import in @(
  @('user32', 'GetForegroundWindow', [IntPtr], [Type[]]@()),
  @('user32', 'SetForegroundWindow', [bool], [Type[]]@([IntPtr])),
  @('user32', 'BringWindowToTop', [bool], [Type[]]@([IntPtr])),
  @('user32', 'IsIconic', [bool], [Type[]]@([IntPtr])),
  @('user32', 'ShowWindow', [bool], [Type[]]@([IntPtr], [int])),
  @('user32', 'GetTopWindow', [IntPtr], [Type[]]@([IntPtr])),
  @('user32', 'GetWindow', [IntPtr], [Type[]]@([IntPtr], [uint32])),
  @('user32', 'GetWindowThreadProcessId', [uint32], [Type[]]@([IntPtr], [IntPtr])),
  @('user32', 'AttachThreadInput', [bool], [Type[]]@([uint32], [uint32], [bool])),
  @('user32', 'SwitchToThisWindow', [void], [Type[]]@([IntPtr], [bool])),
  @('kernel32', 'GetCurrentThreadId', [uint32], [Type[]]@()),
  @('dwmapi', 'DwmGetWindowAttribute', [int], [Type[]]@([IntPtr], [uint32], [int].MakeByRefType(), [uint32]))
)) {
  $type.DefinePInvokeMethod($import[1], $import[0] + '.dll', 'Public, Static, PinvokeImpl', 'Standard', $import[2], $import[3], 'Winapi', 'Auto').SetImplementationFlags('PreserveSig')
}
$native = $type.CreateType()

function Show-Window([IntPtr]$hwnd) {
  # 9: SW_RESTORE
  if ($native::IsIconic($hwnd)) { [void]$native::ShowWindow($hwnd, 9) }
  if ($native::SetForegroundWindow($hwnd) -and $native::GetForegroundWindow() -eq $hwnd) { return }
  # Windows keeps a process the user did not just use from taking the foreground; sharing the
  # foreground window's input state lifts that
  $foregroundThread = $native::GetWindowThreadProcessId($native::GetForegroundWindow(), [IntPtr]::Zero)
  $thisThread = $native::GetCurrentThreadId()
  if ($foregroundThread -ne 0 -and $native::AttachThreadInput($thisThread, $foregroundThread, $true)) {
    [void]$native::BringWindowToTop($hwnd)
    [void]$native::SetForegroundWindow($hwnd)
    [void]$native::AttachThreadInput($thisThread, $foregroundThread, $false)
  }
  if ($native::GetForegroundWindow() -ne $hwnd) { $native::SwitchToThisWindow($hwnd, $true) }
}

# The window used last: nearest the top of the z-order (2: GW_HWNDNEXT)
$depth = @{}
$next = $native::GetTopWindow([IntPtr]::Zero)
for ($index = 0; $next -ne [IntPtr]::Zero -and $index -lt 100000; $index++) {
  $depth[[long]$next] = $index
  $next = $native::GetWindow($next, 2)
}
$ordered = $candidates | Sort-Object { $z = $depth[[long]$_.HWND]; if ($null -eq $z) { [int]::MaxValue } else { $z } }

foreach ($window in $ordered) {
  $hwnd = [IntPtr][long]$window.HWND
  # A window on another virtual desktop is hidden here (14: DWMWA_CLOAKED); one opens here instead
  $cloaked = 0
  if ($native::DwmGetWindowAttribute($hwnd, 14, [ref]$cloaked, 4) -eq 0 -and $cloaked -ne 0) { continue }
  $siblings = $tabs[[long]$window.HWND]
  if ($siblings.Count -gt 1) {
    # One of several tabs: switch to it by its title, unless another of the window's tabs has that title
    if (@($siblings | Where-Object { $_[0] -eq $window.LocationName -and -not (Test-Same $_[1] $wanted) }).Count -gt 0) { continue }
    try {
      Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
      $isTab = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::TabItem)
      $tab = [Windows.Automation.AutomationElement]::FromHandle($hwnd).FindAll('Descendants', $isTab) | Where-Object { $_.Current.Name -eq $window.LocationName } | Select-Object -First 1
      if (-not $tab) { continue }
      $selection = $tab.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern)
      if (-not $selection.Current.IsSelected) { $selection.Select() }
    } catch { continue }
  }
  if ($item) {
    try {
      $entry = $window.Document.Folder.ParseName($item)
      # 29: select it, deselect the rest, scroll to it, focus it
      if ($entry) { $window.Document.SelectItem($entry, 29) }
    } catch {}
  }
  Show-Window $hwnd
  'shown'
  exit
}
'none'
`;
const ENCODED_SHOW_SCRIPT = Buffer.from(SHOW_SCRIPT, "utf16le").toString("base64");

/**
 * Brings the Explorer window (or Windows 11 tab) already showing `folder` on this virtual desktop
 * to the front, with `item`, a name in that folder, selected; resolves whether there was one.
 * Windows only.
 */
export async function showInOpenExplorerWindow(folder: string, item: string | null): Promise<boolean> {
  try {
    const { stdout } = await execCommand(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", ENCODED_SHOW_SCRIPT],
      { timeout: SHOW_TIMEOUT_MS, env: { ...process.env, [FOLDER_VARIABLE]: folder, [ITEM_VARIABLE]: item ?? "" } },
    );
    return stdout.trim() === "shown";
  } catch {
    // PowerShell failed or Explorer did not answer: a new window opens, as without this
    return false;
  }
}
