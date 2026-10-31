import { execFile } from "node:child_process";
import { existsSync, type FSWatcher, watch } from "node:fs";
import path from "node:path";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { gitChangesRpc } from "../shared/git-contracts";

const GIT_COMMAND = process.platform === "win32" ? "git.exe" : "git";
// Plugin RPCs time out at 30s (packages/server/src/server/plugins/runtime.ts REQUEST_TIMEOUT_MS)
const LONG_POLL_MS = 20_000;
// A burst of writes (a save, a checkout, a build) settles into one change
const SETTLE_MS = 250;
// shortcut: watchers live while polled and close after this idle time, raise if reopening is slow
const IDLE_CLOSE_MS = 120_000;
const SWEEP_INTERVAL_MS = 30_000;

interface WorktreeWatch {
  version: number;
  watchers: FSWatcher[];
  waiters: Set<() => void>;
  lastPolled: number;
  settleTimer: ReturnType<typeof setTimeout> | null;
}

const watches = new Map<string, WorktreeWatch>();
const pending = new Map<string, Promise<WorktreeWatch>>();
let sweepTimer: ReturnType<typeof setInterval> | null = null;

function absoluteGitDirectory(worktree: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(GIT_COMMAND, ["rev-parse", "--absolute-git-dir"], { cwd: worktree, windowsHide: true, encoding: "utf8" }, (error, stdout) =>
      resolve(error ? null : stdout.trim()),
    );
  });
}

function closeWatch(key: string, entry: WorktreeWatch): void {
  for (const watcher of entry.watchers) watcher.close();
  if (entry.settleTimer) clearTimeout(entry.settleTimer);
  for (const wake of entry.waiters) wake();
  entry.waiters.clear();
  watches.delete(key);
}

function changed(entry: WorktreeWatch): void {
  if (entry.settleTimer) clearTimeout(entry.settleTimer);
  entry.settleTimer = setTimeout(() => {
    entry.settleTimer = null;
    entry.version++;
    for (const wake of entry.waiters) wake();
    entry.waiters.clear();
  }, SETTLE_MS);
}

/**
 * Watches a worktree's files and its git directory (index, HEAD, refs), which for a linked
 * worktree lives outside it, so staging and commits count as changes too
 */
async function openWatch(key: string): Promise<WorktreeWatch> {
  const entry: WorktreeWatch = {
    // Start from the clock so a restarted daemon never repeats a version a client holds
    version: Date.now(),
    watchers: [],
    waiters: new Set(),
    lastPolled: Date.now(),
    settleTimer: null,
  };
  const directories = [key];
  const gitDirectory = await absoluteGitDirectory(key);
  if (gitDirectory && path.relative(key, gitDirectory).startsWith("..")) directories.push(gitDirectory);
  for (const directory of directories) {
    try {
      const watcher = watch(directory, { recursive: true }, () => changed(entry));
      // A watcher that dies (directory removed) ends the watch; the next poll reopens it
      watcher.on("error", () => closeWatch(key, entry));
      entry.watchers.push(watcher);
    } catch {
      // Unwatchable directory; polls still return on the long-poll timeout
    }
  }
  watches.set(key, entry);
  sweepTimer ??= setInterval(() => {
    const now = Date.now();
    for (const [watchKey, watchEntry] of watches) {
      if (watchEntry.waiters.size === 0 && now - watchEntry.lastPolled > IDLE_CLOSE_MS) closeWatch(watchKey, watchEntry);
    }
  }, SWEEP_INTERVAL_MS);
  return entry;
}

async function ensureWatch(worktree: string): Promise<WorktreeWatch> {
  const key = path.resolve(worktree);
  const existing = watches.get(key);
  if (existing) return existing;
  let opening = pending.get(key);
  if (!opening) {
    opening = openWatch(key).finally(() => pending.delete(key));
    pending.set(key, opening);
  }
  return opening;
}

/**
 * Long-poll: returns as soon as the worktree's change version differs from `version`, or after
 * LONG_POLL_MS. Callers loop, refreshing whenever the returned version moves.
 */
export async function waitForChanges({
  worktree,
  version,
}: RpcInput<typeof gitChangesRpc>): Promise<RpcOutput<typeof gitChangesRpc>> {
  if (!existsSync(worktree)) throw new Error(`Worktree does not exist: ${worktree}`);
  const entry = await ensureWatch(worktree);
  entry.lastPolled = Date.now();
  if (version !== entry.version) return { version: entry.version };
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      entry.waiters.delete(wake);
      resolve();
    }, LONG_POLL_MS);
    const wake = () => {
      clearTimeout(timer);
      resolve();
    };
    entry.waiters.add(wake);
  });
  entry.lastPolled = Date.now();
  return { version: entry.version };
}

/** Closes every watcher; the plugin's cleanup calls this */
export function stopGitWatches(): void {
  for (const [key, entry] of watches) closeWatch(key, entry);
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}
