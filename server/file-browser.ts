import { stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { execCommand } from "@getpaseo/plugin/server";
import type { openInFileBrowserRpc, openWithDefaultAppRpc } from "../shared/contracts";
import { launchDetached } from "./launch";
import { explorerArgument } from "./windows-command";
import { resolveInsideRoot } from "./workspace-path";

const DBUS_TIMEOUT_MS = 5000;

/**
 * Shows a folder, or a file selected in its folder, in the daemon host's file browser. A path
 * that no longer exists (a deleted file in the Git changes list) shows its nearest existing
 * folder inside the root instead.
 */
export async function openInFileBrowser({
  root,
  path: relativePath,
}: RpcInput<typeof openInFileBrowserRpc>): Promise<RpcOutput<typeof openInFileBrowserRpc>> {
  let target = resolveInsideRoot(root, relativePath);
  const rootPath = path.resolve(root);
  let stats = await stat(target).catch(() => null);
  while (!stats && target !== rootPath) {
    target = path.dirname(target);
    stats = await stat(target).catch(() => null);
  }
  if (!stats) throw new Error(`${rootPath} does not exist`);
  const isDirectory = stats.isDirectory();
  switch (process.platform) {
    case "win32":
      // Explorer parses its own command line, so the argument is passed verbatim
      await launchDetached({
        command: "explorer.exe",
        args: [explorerArgument(target, !isDirectory)],
        windowsVerbatimArguments: true,
      });
      break;
    case "darwin":
      await launchDetached({ command: "open", args: isDirectory ? [target] : ["-R", target] });
      break;
    default:
      await openOnLinux(target, isDirectory);
  }
  return {};
}

/**
 * Opens a file the way the OS shell would on double-click: documents in their default app,
 * executables and scripts by running them
 */
export async function openWithDefaultApp({
  root,
  path: relativePath,
}: RpcInput<typeof openWithDefaultAppRpc>): Promise<RpcOutput<typeof openWithDefaultAppRpc>> {
  const target = resolveInsideRoot(root, relativePath);
  switch (process.platform) {
    case "win32":
      // The shell's open verb, as on double-click. Started in the file's folder, so programs and
      // scripts run there; unlike cmd's `start`, it keeps "&", ";", and "^" in .bat paths intact
      await launchDetached({
        command: "rundll32.exe",
        args: ["shell32.dll,ShellExec_RunDLL", `"${target}"`],
        windowsVerbatimArguments: true,
        cwd: path.dirname(target),
      });
      break;
    case "darwin":
      await launchDetached({ command: "open", args: [target] });
      break;
    default:
      await launchDetached({ command: "xdg-open", args: [target] });
  }
  return {};
}

async function openOnLinux(target: string, isDirectory: boolean): Promise<void> {
  if (isDirectory) {
    await launchDetached({ command: "xdg-open", args: [target] });
    return;
  }
  try {
    // freedesktop FileManager1 selects the file in Nautilus, Dolphin, Nemo, Thunar, ...
    await execCommand(
      "dbus-send",
      [
        "--session",
        "--print-reply",
        "--dest=org.freedesktop.FileManager1",
        "/org/freedesktop/FileManager1",
        "org.freedesktop.FileManager1.ShowItems",
        `array:string:${pathToFileURL(target).href}`,
        "string:",
      ],
      { timeout: DBUS_TIMEOUT_MS },
    );
  } catch {
    // No FileManager1 service: open the containing folder without a selection
    await launchDetached({ command: "xdg-open", args: [path.dirname(target)] });
  }
}
