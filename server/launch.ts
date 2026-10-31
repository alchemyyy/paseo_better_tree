import { spawn } from "node:child_process";
import type { LaunchCommand } from "./windows-command";

/**
 * Starts a GUI program detached from the plugin process. Uses `child_process.spawn` directly:
 * the SDK's `spawnProcess` forces `windowsHide`, which starts Windows GUI apps with SW_HIDE.
 */
export function launchDetached({ command, args, windowsVerbatimArguments = false, cwd }: LaunchCommand): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      detached: true,
      stdio: "ignore",
      windowsHide: false,
      windowsVerbatimArguments,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

/** Starts the first candidate that launches; `what` names the program in the error when none does */
export async function launchFirst(candidates: readonly LaunchCommand[], what: string): Promise<LaunchCommand> {
  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      await launchDetached(candidate);
      return candidate;
    } catch (error) {
      failures.push(`${candidate.command}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`No ${what} could be started. ${failures.join("; ")}`);
}
