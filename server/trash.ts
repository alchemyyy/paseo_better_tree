import { lstat, unlink } from "node:fs/promises";
import path from "node:path";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { execCommand } from "@getpaseo/plugin/server";
import type { trashEntryRpc } from "../shared/contracts";
import { resolveInsideRoot } from "./workspace-path";

const TRASH_TIMEOUT_MS = 120_000;
const TARGETS_VARIABLE = "BETTER_TREE_TRASH";

/**
 * Windows has no command-line tool for the Recycle Bin, so .NET's FileSystem API does it. The
 * paths arrive through the environment, one per line (Windows names cannot hold a line break),
 * so they are never parsed as part of a command line.
 */
const WINDOWS_RECYCLE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "try {",
  "  Add-Type -AssemblyName Microsoft.VisualBasic",
  "  $ui = [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs",
  "  $recycle = [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin",
  `  foreach ($target in ($env:${TARGETS_VARIABLE} -split "\`n")) {`,
  "    if ([System.IO.Directory]::Exists($target)) {",
  "      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($target, $ui, $recycle)",
  "    } else {",
  "      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($target, $ui, $recycle)",
  "    }",
  "  }",
  "} catch {",
  "  [Console]::Error.WriteLine($_.Exception.Message)",
  "  exit 1",
  "}",
].join("\n");

/** Moves a file or folder to the daemon host's Recycle Bin or Trash; never deletes permanently */
export async function trashEntry({
  root,
  path: relativePath,
}: RpcInput<typeof trashEntryRpc>): Promise<RpcOutput<typeof trashEntryRpc>> {
  const target = resolveInsideRoot(root, relativePath);
  if (target === path.resolve(root)) throw new Error("The tree root cannot be deleted here");
  await moveToTrash([target]);
  return {};
}

/**
 * Moves absolute paths to the daemon host's Recycle Bin or Trash; never deletes permanently.
 * A symbolic link is removed itself, since that loses nothing and trashing it could take its
 * target's contents with it.
 */
export async function moveToTrash(targets: readonly string[]): Promise<void> {
  const toTrash: string[] = [];
  for (const target of targets) {
    if ((await lstat(target)).isSymbolicLink()) await unlink(target);
    else toTrash.push(target);
  }
  if (toTrash.length === 0) return;
  switch (process.platform) {
    case "win32":
      await runTrashCommand(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_RECYCLE_SCRIPT, "utf16le").toString("base64")],
        { [TARGETS_VARIABLE]: toTrash.join("\n") },
      );
      break;
    case "darwin":
      for (const target of toTrash) {
        await runTrashCommand("osascript", [
          "-e",
          "on run argv",
          "-e",
          'tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)',
          "-e",
          "end run",
          target,
        ]);
      }
      break;
    default:
      await trashOnLinux(toTrash);
  }
}

async function trashOnLinux(targets: readonly string[]): Promise<void> {
  const failures: string[] = [];
  for (const [command, args] of [
    ["gio", ["trash", "--", ...targets]],
    ["trash-put", ["--", ...targets]],
  ] as const) {
    try {
      await runTrashCommand(command, [...args]);
      return;
    } catch (error) {
      failures.push(`${command}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`Could not move to Trash; nothing was deleted. Install gio or trash-cli. ${failures.join("; ")}`);
}

async function runTrashCommand(command: string, args: string[], env?: Record<string, string>): Promise<void> {
  try {
    await execCommand(command, args, {
      timeout: TRASH_TIMEOUT_MS,
      env: env ? { ...process.env, ...env } : undefined,
    });
  } catch (error) {
    const stderr =
      typeof error === "object" && error !== null && "stderr" in error && typeof error.stderr === "string"
        ? error.stderr.trim()
        : "";
    throw new Error(stderr || (error instanceof Error ? error.message : String(error)));
  }
}
