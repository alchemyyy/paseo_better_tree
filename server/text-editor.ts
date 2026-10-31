import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { execCommand } from "@getpaseo/plugin/server";
import type { openInTextEditorRpc } from "../shared/contracts";
import { launchFirst } from "./launch";
import { buildWindowsLaunch, parseRegistryValue, type LaunchCommand } from "./windows-command";
import { resolveInsideRoot } from "./workspace-path";

const QUERY_TIMEOUT_MS = 5000;
const WINDOWS_FALLBACK_EDITOR = "notepad.exe";
const FILE_EXTS_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.txt";
// Newer Windows 11 builds write UserChoiceLatest; older ones only UserChoice
const USER_CHOICE_KEYS = [`${FILE_EXTS_KEY}\\UserChoiceLatest`, `${FILE_EXTS_KEY}\\UserChoice`];

/** Opens a file on the daemon host with the editor registered for plain text files */
export async function openInTextEditor({
  root,
  path,
}: RpcInput<typeof openInTextEditorRpc>): Promise<RpcOutput<typeof openInTextEditorRpc>> {
  const filePath = resolveInsideRoot(root, path);
  const candidates = await resolveTextEditorCandidates(filePath);
  const { command } = await launchFirst(candidates, "text editor");
  return { editor: command };
}

async function resolveTextEditorCandidates(filePath: string): Promise<LaunchCommand[]> {
  switch (process.platform) {
    case "win32":
      return resolveWindowsCandidates(filePath);
    case "darwin":
      return [{ command: "open", args: ["-t", filePath] }];
    default:
      return resolveLinuxCandidates(filePath);
  }
}

async function resolveWindowsCandidates(filePath: string): Promise<LaunchCommand[]> {
  const candidates: LaunchCommand[] = [];
  const progId = await resolveWindowsTextProgId();
  if (progId) {
    const template = await readRegistryValue(`HKCR\\${progId}\\shell\\open\\command`, null);
    // NOTE: Store-app ProgIds (AppX...) have no command; they fall through to notepad.exe
    const launch = template
      ? buildWindowsLaunch(template, filePath, (name) => process.env[name])
      : null;
    if (launch) candidates.push(launch);
  }
  candidates.push({ command: WINDOWS_FALLBACK_EDITOR, args: [filePath] });
  return candidates;
}

async function resolveWindowsTextProgId(): Promise<string | null> {
  for (const key of USER_CHOICE_KEYS) {
    const progId = await readRegistryValue(key, "ProgId");
    if (progId) return progId;
  }
  return readRegistryValue("HKCR\\.txt", null);
}

async function readRegistryValue(key: string, valueName: string | null): Promise<string | null> {
  const valueArgs = valueName ? ["/v", valueName] : ["/ve"];
  try {
    const { stdout } = await execCommand("reg.exe", ["query", key, ...valueArgs], {
      timeout: QUERY_TIMEOUT_MS,
    });
    return parseRegistryValue(stdout);
  } catch {
    // reg.exe exits non-zero when the key or value is missing
    return null;
  }
}

async function resolveLinuxCandidates(filePath: string): Promise<LaunchCommand[]> {
  const candidates: LaunchCommand[] = [];
  try {
    const { stdout } = await execCommand("xdg-mime", ["query", "default", "text/plain"], {
      timeout: QUERY_TIMEOUT_MS,
    });
    const desktopId = stdout.trim();
    if (desktopId) candidates.push({ command: "gtk-launch", args: [desktopId, filePath] });
  } catch {
    // Falls back to xdg-open below
  }
  candidates.push({ command: "xdg-open", args: [filePath] });
  return candidates;
}
