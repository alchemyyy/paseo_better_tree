import type { CommitMode, GitFile } from "../shared/git-contracts";

/** Commit mode when the user has not picked one: staged changes win, like Zed */
export function defaultCommitMode(files: readonly GitFile[]): CommitMode {
  return files.some((file) => file.staged) ? "staged" : "tracked";
}

/** Whether `mode` has something to commit; an amend can always rewrite the last commit */
export function canCommit(mode: CommitMode, files: readonly GitFile[], message: string): boolean {
  switch (mode) {
    case "staged":
      return message.trim() !== "" && files.some((file) => file.staged);
    case "tracked":
      return message.trim() !== "" && files.some((file) => file.staged || file.modified);
    case "amend":
      return true;
  }
}

export type DiffLineKind = "meta" | "hunk" | "add" | "delete" | "context";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldNumber: number | null;
  newNumber: number | null;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Splits a unified diff into display lines with old/new line numbers */
export function parseUnifiedDiff(diff: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldNumber = 0;
  let newNumber = 0;
  let inHunk = false;
  const rawLines = diff.replace(/\r?\n$/, "").split(/\r?\n/);
  for (const text of rawLines) {
    const hunk = HUNK_HEADER.exec(text);
    if (hunk) {
      oldNumber = Number.parseInt(hunk[1], 10);
      newNumber = Number.parseInt(hunk[2], 10);
      inHunk = true;
      lines.push({ kind: "hunk", text, oldNumber: null, newNumber: null });
      continue;
    }
    if (!inHunk || text.startsWith("diff --git ")) {
      inHunk = false;
      if (text !== "") lines.push({ kind: "meta", text, oldNumber: null, newNumber: null });
      continue;
    }
    if (text.startsWith("+")) {
      lines.push({ kind: "add", text: text.slice(1), oldNumber: null, newNumber: newNumber++ });
    } else if (text.startsWith("-")) {
      lines.push({ kind: "delete", text: text.slice(1), oldNumber: oldNumber++, newNumber: null });
    } else if (text.startsWith("\\")) {
      // "\ No newline at end of file"
      lines.push({ kind: "meta", text, oldNumber: null, newNumber: null });
    } else {
      lines.push({
        kind: "context",
        text: text.slice(1),
        oldNumber: oldNumber++,
        newNumber: newNumber++,
      });
    }
  }
  return lines;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MONTH_MS = 30 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;

/** "just now", "5m ago", "3h ago", "2d ago", "4mo ago", "1y ago" */
export function formatRelativeTime(iso: string | null, now: number): string {
  if (!iso) return "";
  const elapsed = Math.max(0, now - Date.parse(iso));
  if (elapsed < MINUTE_MS) return "just now";
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m ago`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)}h ago`;
  if (elapsed < MONTH_MS) return `${Math.floor(elapsed / DAY_MS)}d ago`;
  if (elapsed < YEAR_MS) return `${Math.floor(elapsed / MONTH_MS)}mo ago`;
  return `${Math.floor(elapsed / YEAR_MS)}y ago`;
}

/**
 * Moves the divider after section `index` by `delta` of the total height. Either neighbour can
 * shrink to nothing; the divider only stops where a section would become negative.
 */
export function resizeFractions(start: readonly number[], index: number, delta: number): number[] {
  const next = [...start];
  const pair = start[index] + start[index + 1];
  const resized = Math.max(0, Math.min(pair, start[index] + delta));
  next[index] = resized;
  next[index + 1] = pair - resized;
  return next;
}

export interface DiffSpec {
  worktree: string;
  path: string;
}

export interface DiffSlotTab {
  panelId: string;
  spec: (DiffSpec & { openedAt: number }) | null;
}

/**
 * The diff panel to show `spec` in: the tab already showing it, else an unused slot,
 * else the slot whose file was opened longest ago
 */
export function chooseDiffSlot(
  slotIds: readonly string[],
  tabs: readonly DiffSlotTab[],
  spec: DiffSpec,
): string {
  return chooseSlot(
    slotIds,
    tabs.map((tab) => ({
      panelId: tab.panelId,
      key: tab.spec ? `${tab.spec.worktree}\n${tab.spec.path}` : null,
      openedAt: tab.spec?.openedAt ?? 0,
    })),
    `${spec.worktree}\n${spec.path}`,
  );
}

export interface SlotTab {
  panelId: string;
  /** What the tab shows, or null when unknown */
  key: string | null;
  openedAt: number;
}

/** A pooled panel for `key`: the tab already showing it, else an unused slot, else the oldest */
export function chooseSlot(slotIds: readonly string[], tabs: readonly SlotTab[], key: string): string {
  const showing = tabs.find((tab) => tab.key === key);
  if (showing) return showing.panelId;
  const used = new Set(tabs.map((tab) => tab.panelId));
  const unused = slotIds.find((slotId) => !used.has(slotId));
  if (unused) return unused;
  let oldest = tabs[0];
  for (const tab of tabs) {
    if (tab.openedAt < oldest.openedAt) oldest = tab;
  }
  return oldest?.panelId ?? slotIds[0];
}

/**
 * `file` as git lists it right after the whole file is staged or unstaged: staging leaves nothing
 * unstaged and makes an untracked file new in the index; unstaging a new file untracks it again
 */
export function withStaged(file: GitFile, staged: boolean): GitFile {
  if (staged) {
    if (file.staged && !file.modified && !file.untracked) return file;
    return { ...file, staged: true, modified: false, untracked: false, added: file.added || file.untracked };
  }
  if (!file.staged) return file;
  if (file.added) return { ...file, staged: false, added: false, untracked: true, modified: false };
  return { ...file, staged: false, modified: true };
}

export interface StageTracker {
  /** Numbers a new toggle of `paths`; each of them now belongs to it */
  begin(paths: readonly string[]): number;
  /**
   * Ends toggle `id`. `apply`: it succeeded and its status read is newer than any shown so far.
   * `released`: its paths that no later toggle took over, whose optimistic state can now go
   */
  finish(id: number, paths: readonly string[], succeeded: boolean): { apply: boolean; released: string[] };
}

/** Orders staging toggles that overlap in one worktree, whose answers can arrive in any order */
export function createStageTracker(): StageTracker {
  let lastId = 0;
  let appliedId = 0;
  const ownerByPath = new Map<string, number>();
  return {
    begin(paths) {
      lastId++;
      for (const path of paths) ownerByPath.set(path, lastId);
      return lastId;
    },
    finish(id, paths, succeeded) {
      const apply = succeeded && id > appliedId;
      if (apply) appliedId = id;
      const released = paths.filter((path) => ownerByPath.get(path) === id);
      for (const path of released) ownerByPath.delete(path);
      return { apply, released };
    },
  };
}
