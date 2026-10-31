import { stat } from "node:fs/promises";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { openTerminalRpc } from "../shared/contracts";
import { launchFirst } from "./launch";
import { linuxTerminalCandidates, macTerminalCommand, windowsTerminalCandidates } from "./launch-targets";
import type { LaunchCommand } from "./windows-command";
import { resolveInsideRoot } from "./workspace-path";

/** Opens the daemon host's terminal app in a folder */
export async function openTerminal({
  root,
  path: relativePath,
}: RpcInput<typeof openTerminalRpc>): Promise<RpcOutput<typeof openTerminalRpc>> {
  const directory = resolveInsideRoot(root, relativePath);
  if (!(await stat(directory)).isDirectory()) throw new Error(`Not a folder: ${relativePath}`);
  const { command } = await launchFirst(terminalCandidates(directory), "terminal");
  return { terminal: command };
}

function terminalCandidates(directory: string): LaunchCommand[] {
  switch (process.platform) {
    case "win32":
      return windowsTerminalCandidates(directory);
    case "darwin":
      return [macTerminalCommand(directory)];
    default:
      return linuxTerminalCandidates(directory);
  }
}
