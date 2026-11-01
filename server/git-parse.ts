import type { CommitFileStatus } from "../shared/git-contracts";

export interface WorktreeRecord {
  path: string;
  head: string;
  /** Short branch name, or null when detached */
  branch: string | null;
  bare: boolean;
  /** Git flagged it prunable: its directory or gitdir no longer exists */
  prunable: boolean;
}

const LOCAL_BRANCH_PREFIX = "refs/heads/";
const HEAD_POINTER_PREFIX = "HEAD -> ";

/** Parses `git worktree list --porcelain` */
export function parseWorktreeList(output: string): WorktreeRecord[] {
  const records: WorktreeRecord[] = [];
  let current: WorktreeRecord | null = null;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      current = {
        path: line.slice("worktree ".length),
        head: "",
        branch: null,
        bare: false,
        prunable: false,
      };
      records.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length);
    else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length);
      current.branch = ref.startsWith(LOCAL_BRANCH_PREFIX) ? ref.slice(LOCAL_BRANCH_PREFIX.length) : ref;
    } else if (line === "bare") current.bare = true;
    else if (line === "prunable" || line.startsWith("prunable ")) current.prunable = true;
  }
  return records;
}

export interface StatusRecord {
  path: string;
  /** Index status letter (X) */
  index: string;
  /** Working-tree status letter (Y) */
  worktree: string;
}

/** Parses `git status --porcelain=v1 -z`; renames report their new path */
export function parseStatusZ(output: string): StatusRecord[] {
  const records: StatusRecord[] = [];
  const parts = output.split("\0");
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (part.length < 4) continue;
    const indexStatus = part[0];
    const worktreeStatus = part[1];
    records.push({ path: part.slice(3), index: indexStatus, worktree: worktreeStatus });
    // Renames and copies are followed by their original path
    if (indexStatus === "R" || indexStatus === "C") index++;
  }
  return records;
}

/** New path -> original path of each rename in `git diff --name-status -z` output */
export function parseRenamesZ(output: string): Map<string, string> {
  const renames = new Map<string, string>();
  const parts = output.split("\0");
  for (let index = 0; index < parts.length; index++) {
    const status = parts[index];
    if (!status) continue;
    // Renames and copies carry two paths, original first; everything else one
    if (status[0] === "R" || status[0] === "C") {
      const original = parts[index + 1];
      const renamed = parts[index + 2];
      if (status[0] === "R" && original && renamed) renames.set(renamed, original);
      index += 2;
    } else {
      index += 1;
    }
  }
  return renames;
}

export interface NumstatRecord {
  path: string;
  additions: number;
  deletions: number;
  /** Git counted no lines ("-"), as it does for binary content */
  binary: boolean;
}

/** Parses `git diff --numstat -z`; binary files count as zero lines */
export function parseNumstatZ(output: string): NumstatRecord[] {
  const records: NumstatRecord[] = [];
  const parts = output.split("\0");
  for (let index = 0; index < parts.length; index++) {
    const fields = parts[index].split("\t");
    if (fields.length < 3) continue;
    let path = fields[2];
    // Renames leave the path field empty and append old\0new
    if (path === "") {
      path = parts[index + 2] ?? "";
      index += 2;
    }
    if (!path) continue;
    records.push({
      path,
      additions: Number.parseInt(fields[0], 10) || 0,
      deletions: Number.parseInt(fields[1], 10) || 0,
      binary: fields[0] === "-",
    });
  }
  return records;
}

export interface NameStatusRecord {
  status: CommitFileStatus;
  path: string;
  /** The original path of a rename or copy */
  previousPath: string | null;
}

const CHANGE_STATUS_BY_LETTER: Readonly<Record<string, CommitFileStatus>> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "type-changed",
};

/** Parses `git diff-tree --name-status -z`; a status letter it does not know reads as a modification */
export function parseNameStatusZ(output: string): NameStatusRecord[] {
  const records: NameStatusRecord[] = [];
  const parts = output.split("\0");
  for (let index = 0; index < parts.length; index++) {
    const letter = parts[index][0];
    if (!letter) continue;
    const status = CHANGE_STATUS_BY_LETTER[letter] ?? "modified";
    // Renames and copies carry two paths, original first (with a similarity score after the letter)
    if (letter === "R" || letter === "C") {
      const previousPath = parts[index + 1];
      const path = parts[index + 2];
      index += 2;
      if (previousPath && path) records.push({ status, path, previousPath });
    } else {
      const path = parts[index + 1];
      index += 1;
      if (path) records.push({ status, path, previousPath: null });
    }
  }
  return records;
}

export const LOG_FIELD_SEPARATOR = "\x1f";
export const LOG_RECORD_SEPARATOR = "\x1e";
/** `git log --decorate=full` format matching parseLog */
export const LOG_FORMAT = ["%H", "%h", "%an", "%ct", "%s", "%D"].join("%x1f") + "%x1e";

export interface LogRecord {
  sha: string;
  shortSha: string;
  author: string;
  time: string;
  subject: string;
  branches: string[];
  isHead: boolean;
}

/** Parses `git log --decorate=full --format=LOG_FORMAT` */
export function parseLog(output: string): LogRecord[] {
  const records: LogRecord[] = [];
  for (const record of output.split(LOG_RECORD_SEPARATOR)) {
    const fields = record.replace(/^\r?\n/, "").split(LOG_FIELD_SEPARATOR);
    if (fields.length < 6 || !fields[0]) continue;
    const branches: string[] = [];
    let isHead = false;
    for (const rawDecoration of fields[5].split(", ")) {
      let decoration = rawDecoration.trim();
      if (decoration === "HEAD") {
        isHead = true;
        continue;
      }
      if (decoration.startsWith(HEAD_POINTER_PREFIX)) {
        isHead = true;
        decoration = decoration.slice(HEAD_POINTER_PREFIX.length);
      }
      if (decoration.startsWith(LOCAL_BRANCH_PREFIX)) {
        branches.push(decoration.slice(LOCAL_BRANCH_PREFIX.length));
      }
    }
    records.push({
      sha: fields[0],
      shortSha: fields[1],
      author: fields[2],
      time: new Date(Number.parseInt(fields[3], 10) * 1000).toISOString(),
      subject: fields[4],
      branches,
      isHead,
    });
  }
  return records;
}

/** `git show -s` format matching parseCommitHeader; the body goes last, since it may hold anything */
export const COMMIT_HEADER_FORMAT = ["%H", "%h", "%P", "%an", "%at", "%s", "%b"].join("%x1f");

export interface CommitHeaderRecord {
  sha: string;
  shortSha: string;
  parents: string[];
  author: string;
  /** Author date, ISO 8601 */
  time: string;
  subject: string;
  /** Trimmed; empty when the message is only a subject */
  body: string;
}

/** Parses `git show -s --format=COMMIT_HEADER_FORMAT` */
export function parseCommitHeader(output: string): CommitHeaderRecord {
  const fields = output.split(LOG_FIELD_SEPARATOR);
  if (fields.length < 7 || !fields[0]) throw new Error("git did not describe the commit");
  return {
    sha: fields[0],
    shortSha: fields[1],
    parents: fields[2].split(" ").filter(Boolean),
    author: fields[3],
    time: new Date(Number.parseInt(fields[4], 10) * 1000).toISOString(),
    subject: fields[5],
    body: fields.slice(6).join(LOG_FIELD_SEPARATOR).trim(),
  };
}

/** Line count of text content, or 0 for binary content */
export function countTextLines(content: string): number {
  if (content.length === 0 || content.includes("\0")) return 0;
  let lines = 0;
  for (let index = 0; index < content.length; index++) {
    if (content.charCodeAt(index) === 10) lines++;
  }
  return content.endsWith("\n") ? lines : lines + 1;
}
