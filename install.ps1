# Installs (or reloads) the better-tree plugin into the local Paseo daemon.
# Usage: powershell -ExecutionPolicy Bypass -File install.ps1 [-PaseoCli <path to paseo.cmd>]
param(
  [string]$PaseoCli
)

$ErrorActionPreference = "Stop"
$PluginId = "better-tree"
$PluginDirectory = $PSScriptRoot

function Resolve-PaseoCli {
  if ($PaseoCli) { return $PaseoCli }
  $onPath = Get-Command paseo -ErrorAction SilentlyContinue
  if ($onPath) { return $onPath.Source }
  $candidates = @(
    (Join-Path $env:ProgramFiles "Paseo\resources\bin\paseo.cmd"),
    (Join-Path $env:LOCALAPPDATA "Programs\Paseo\resources\bin\paseo.cmd")
  )
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) { return $candidate }
  }
  throw "Paseo CLI not found. Pass -PaseoCli 'C:\path\to\Paseo\resources\bin\paseo.cmd'."
}

function Invoke-Paseo {
  & $script:Cli @args
  if ($LASTEXITCODE -ne 0) { throw "paseo $($args -join ' ') failed with exit code $LASTEXITCODE" }
}

$script:Cli = Resolve-PaseoCli
Write-Host "Using Paseo CLI: $script:Cli"

$installed = (& $script:Cli plugin ls --json | Out-String | ConvertFrom-Json) |
  Where-Object { $_.id -eq $PluginId }

if ($installed) {
  Write-Host "Reloading $PluginId from disk"
  Invoke-Paseo plugin reload $PluginId
} else {
  Write-Host "Installing $PluginId from $PluginDirectory"
  Invoke-Paseo plugin install $PluginDirectory
}

Invoke-Paseo plugin ls $PluginId

$configPath = Join-Path $HOME ".paseo\config.json"
if (Test-Path $configPath) {
  $config = Get-Content $configPath -Raw | ConvertFrom-Json
  if (-not $config.pluginsEnabled) {
    Write-Warning "Plugins are disabled. Turn on Settings > Plugins > Enable plugins, or set pluginsEnabled to true in $configPath and run: paseo reload"
  }
}
