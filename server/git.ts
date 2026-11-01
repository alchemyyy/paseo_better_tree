import { existsSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type {
  GitFile,
  Worktree,
  gitCheckoutRpc,
  gitCommitDetailsRpc,
  gitCommitFileDiffRpc,
  gitCommitFileRpc,
  gitCommitRpc,
  gitDiffRpc,
  gitIgnoreRpc,
  gitRemoteRpc,
  gitUncommitRpc,
  gitLogRpc,
  gitRevertRpc,
  gitStageRpc,
  gitStatusRpc,
  gitWorktreeSummaryRpc,
  gitWorktreesRpc,
} from "../shared/git-contracts";
import {
  COMMIT_HEADER_FORMAT,
  countBufferLines,
  LOG_FORMAT,
  parseCommitHeader,
  parseLog,
  parseNameStatusZ,
  parseNumstatZ,
  parseRenamesZ,
  parseStatusZ,
  parseWorktreeList,
} from "./git-parse";
import { appendGitignoreLine, gitignorePattern } from "../shared/gitignore";
import { createCoalescer } from "./coalesce";
import { isText, MAX_TEXT_BYTES, normalizeLineEndings } from "./diff-sources";
import { mapLimited } from "./file-work";
import { fileIconId } from "./file-icons";
import { runGitProcess } from "./git-process";
import { type GitObject, prepareGitObjects, readGitObjects } from "./object-reader";
import { isInsideRepository } from "./repositories";
import { createSerialQueue } from "./serial-queue";
import { moveToTrash } from "./trash";
import { resolveInsideRoot } from "./workspace-path";

const GIT_MAX_BUFFER = 64 * 1024 * 1024;
// Status polling must not take index.lock away from the user's own git commands
const GIT_ENVIRONMENT = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
const DIFF_DIFFERENCES_EXIT_CODE = 1;
const UNTRACKED_LINE_COUNT_LIMIT_BYTES = 2 * 1024 * 1024;
// shortcut: caps per-refresh untracked file reads, raise if large untracked trees undercount
const UNTRACKED_FILE_LIMIT = 2000;
// shortcut: forgets every cached count past this many files, raise if huge untracked trees reread
const UNTRACKED_LINE_CACHE_LIMIT = 20_000;
const DEFAULT_LOG_LIMIT = 200;
const NULL_DEVICE = "/dev/null";
const STAGE_BATCH_SIZE = 100;

// Remote commands fail fast instead of waiting on a credential prompt nobody can answer
const REMOTE_ENVIRONMENT = { ...GIT_ENVIRONMENT, GIT_TERMINAL_PROMPT: "0" };
const REMOTE_TIMEOUT_MS = 120_000;

// Index writes in one worktree run one at a time, in arrival order: git refuses a second writer
// while index.lock exists, and a commit queued behind a stage must include what was staged
const indexWrites = createSerialQueue();
// Status, summary, worktree, and log reads asked for while the same read runs share the one after it
const sharedReads = createCoalescer();

/** Which of git-process's lanes a read waits in: polling reads of a shown panel, or a row's totals */
interface ReadLane {
  background?: boolean;
  low?: boolean;
}
const POLLING_READ: ReadLane = { background: true };
const SECONDARY_READ: ReadLane = { background: true, low: true };

function queuedIndexWrite<Input extends { worktree: string }, Output>(
  write: (input: Input) => Promise<Output>,
): (input: Input) => Promise<Output> {
  return (input) => indexWrites(pathKey(input.worktree), () => write(input));
}

async function runGit(
  cwd: string,
  args: string[],
  allowedExitCodes: number[] = [],
  options: { env?: NodeJS.ProcessEnv; timeout?: number } & ReadLane = {},
): Promise<string> {
  const result = await runGitProcess(cwd, args, {
    env: options.env ?? GIT_ENVIRONMENT,
    timeout: options.timeout,
    maxBuffer: GIT_MAX_BUFFER,
    background: options.background,
    low: options.low,
  });
  if (result.error === null) return result.stdout;
  if (result.exitCode !== null && allowedExitCodes.includes(result.exitCode)) return result.stdout;
  // Some refusals ("nothing to commit") are printed to stdout, not stderr
  throw new Error(result.stderr.trim() || result.stdout.trim() || result.error);
}

async function hasHead(worktree: string, background = false): Promise<boolean> {
  try {
    await runGit(worktree, ["rev-parse", "--verify", "--quiet", "HEAD"], [], { background });
    return true;
  } catch {
    return false;
  }
}

async function assertDirectory(directory: string): Promise<string> {
  const resolved = path.resolve(directory);
  if (!(await stat(resolved).catch(() => null))) throw new Error(`Worktree does not exist: ${directory}`);
  return resolved;
}

/** Line counts of untracked files by absolute path, reused while a file's size and mtime hold */
const untrackedLineCounts = new Map<string, { size: number; mtimeMs: number; lines: number }>();

async function countUntrackedLines(file: string): Promise<number> {
  const stats = await stat(file).catch(() => null);
  if (!stats || !stats.isFile() || stats.size > UNTRACKED_LINE_COUNT_LIMIT_BYTES) return 0;
  const cached = untrackedLineCounts.get(file);
  if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs) return cached.lines;
  const content = await readFile(file).catch(() => null);
  if (!content) return 0;
  const lines = countBufferLines(content);
  if (untrackedLineCounts.size >= UNTRACKED_LINE_CACHE_LIMIT) untrackedLineCounts.clear();
  untrackedLineCounts.set(file, { size: stats.size, mtimeMs: stats.mtimeMs, lines });
  return lines;
}

async function readNumstat(
  worktree: string,
  args: string[],
  lane: ReadLane,
): Promise<Map<string, { additions: number; deletions: number }>> {
  const totals = new Map<string, { additions: number; deletions: number }>();
  const output = await runGit(worktree, ["diff", "--numstat", "-z", ...args], [], lane);
  for (const record of parseNumstatZ(output)) {
    totals.set(record.path, { additions: record.additions, deletions: record.deletions });
  }
  return totals;
}

/**
 * Changed and untracked files of one worktree with per-file line totals, for the changes list. A
 * call made while a read of the worktree runs gets the next read, which starts after it
 */
function collectFiles(worktree: string): Promise<GitFile[]> {
  return sharedReads(`status:${pathKey(worktree)}`, () => readFiles(worktree, POLLING_READ));
}

async function readFiles(worktree: string, lane: ReadLane): Promise<GitFile[]> {
  const [statusOutput, stagedTotals, unstagedTotals] = await Promise.all([
    runGit(worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], [], lane),
    readNumstat(worktree, ["--cached"], lane),
    readNumstat(worktree, [], lane),
  ]);
  const records = parseStatusZ(statusOutput).filter((record) => record.index !== "!");
  // The first untracked files are read for their line counts
  const counted = records
    .filter((record) => record.index === "?")
    .slice(0, UNTRACKED_FILE_LIMIT)
    .map((record) => record.path);
  const lineCounts = await mapLimited(counted, (relativePath) => countUntrackedLines(path.join(worktree, relativePath)));
  const untrackedLines = new Map(counted.map((relativePath, index): [string, number] => [relativePath, lineCounts[index]]));
  const files: GitFile[] = [];
  for (const record of records) {
    const untracked = record.index === "?";
    let additions = 0;
    let deletions = 0;
    if (untracked) {
      additions = untrackedLines.get(record.path) ?? 0;
    } else {
      const staged = stagedTotals.get(record.path);
      const unstaged = unstagedTotals.get(record.path);
      additions = (staged?.additions ?? 0) + (unstaged?.additions ?? 0);
      deletions = (staged?.deletions ?? 0) + (unstaged?.deletions ?? 0);
    }
    files.push({
      path: record.path,
      staged: !untracked && record.index !== " ",
      modified: !untracked && record.worktree !== " ",
      untracked,
      added: record.index === "A",
      additions,
      deletions,
    });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

async function latestModification(worktree: string, files: readonly GitFile[]): Promise<string | null> {
  let latest = 0;
  try {
    const commitSeconds = Number.parseInt(
      (await runGit(worktree, ["log", "-1", "--format=%ct"], [], SECONDARY_READ)).trim(),
      10,
    );
    if (Number.isFinite(commitSeconds)) latest = commitSeconds * 1000;
  } catch {
    // No commits yet
  }
  const stats = await mapLimited(files.slice(0, UNTRACKED_FILE_LIMIT), (file) =>
    stat(path.join(worktree, file.path)).catch(() => null),
  );
  for (const fileStats of stats) {
    if (fileStats && fileStats.mtimeMs > latest) latest = fileStats.mtimeMs;
  }
  return latest > 0 ? new Date(latest).toISOString() : null;
}

/** Compares paths the way the file system does: resolved, and case-insensitive on Windows */
function pathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePath(left: string, right: string): boolean {
  return pathKey(left) === pathKey(right);
}

/**
 * The worktree holding `root` first, then every other worktree of its repository: two quick git
 * calls, so the Git panel shows at once. Each row's totals come from worktreeSummary
 */
export async function listWorktrees({
  root,
}: RpcInput<typeof gitWorktreesRpc>): Promise<RpcOutput<typeof gitWorktreesRpc>> {
  const directory = path.resolve(root);
  return sharedReads(`worktrees:${pathKey(directory)}`, async () => {
    // A folder that is gone or in no repository answers without running git; the Git panel then
    // lists the repositories inside it
    if (!(await stat(directory).catch(() => null)) || !(await isInsideRepository(directory))) return { worktrees: [] };
    const [topLevel, list] = await Promise.all([
      runGit(directory, ["rev-parse", "--show-toplevel"], [], { background: true }),
      runGit(directory, ["worktree", "list", "--porcelain"], [], { background: true }),
    ]);
    const records = parseWorktreeList(list).filter((record) => !record.bare);
    const present = await Promise.all(
      records.map((record) => !record.prunable && stat(record.path).then(() => true, () => false)),
    );
    const worktrees = records.map((record, index): Worktree => {
      const missing = !present[index];
      return {
        path: path.resolve(record.path),
        branch: record.branch,
        head: record.head,
        current: !missing && samePath(record.path, topLevel.trim()),
        missing,
      };
    });
    // Active first, missing last, git's order otherwise
    const rank = (worktree: Worktree) => (worktree.current ? 0 : worktree.missing ? 2 : 1);
    worktrees.sort((left, right) => rank(left) - rank(right));
    return { worktrees };
  });
}

/** A worktree's line totals and when it last changed, for its row in the Git panel; it waits behind the shown panel's reads */
export async function worktreeSummary({
  worktree,
}: RpcInput<typeof gitWorktreeSummaryRpc>): Promise<RpcOutput<typeof gitWorktreeSummaryRpc>> {
  const directory = await assertDirectory(worktree);
  return sharedReads(`summary:${pathKey(directory)}`, async () => {
    const files = await readFiles(directory, SECONDARY_READ);
    let additions = 0;
    let deletions = 0;
    for (const file of files) {
      additions += file.additions;
      deletions += file.deletions;
    }
    return { additions, deletions, modifiedAt: await latestModification(directory, files) };
  });
}

export async function listStatus({
  worktree,
}: RpcInput<typeof gitStatusRpc>): Promise<RpcOutput<typeof gitStatusRpc>> {
  return { files: await collectFiles(await assertDirectory(worktree)) };
}

/**
 * Stages (tracks) or unstages paths, in batches that stay under Windows' command-line limit, and
 * returns the status read right after, before any later queued write
 */
export const setStaged = queuedIndexWrite(async ({
  worktree,
  paths,
  staged,
}: RpcInput<typeof gitStageRpc>): Promise<RpcOutput<typeof gitStageRpc>> => {
  const directory = await assertDirectory(worktree);
  for (const relativePath of paths) resolveInsideRoot(directory, relativePath);
  // Before the first commit there is nothing to restore from; rm --cached keeps the files on disk
  let command = ["add"];
  if (!staged) command = (await hasHead(directory)) ? ["restore", "--staged"] : ["rm", "--cached", "--quiet"];
  for (let start = 0; start < paths.length; start += STAGE_BATCH_SIZE) {
    // Literal pathspecs: a file named "*.txt" must not match every text file
    await runGit(directory, ["--literal-pathspecs", ...command, "--", ...paths.slice(start, start + STAGE_BATCH_SIZE)]);
  }
  // Read now rather than behind polling reads: the panel waits on it to settle the checkbox
  return { files: await readFiles(directory, {}) };
});

/** Appends a line ignoring exactly one path to the worktree's top-level .gitignore */
export async function ignorePath({
  worktree,
  path: relativePath,
  kind,
}: RpcInput<typeof gitIgnoreRpc>): Promise<RpcOutput<typeof gitIgnoreRpc>> {
  const directory = await assertDirectory(worktree);
  if (resolveInsideRoot(directory, relativePath) === directory) throw new Error("The worktree itself cannot be ignored");
  const pattern = gitignorePattern(relativePath, kind === "directory");
  const gitignore = path.join(directory, ".gitignore");
  const content = await readFile(gitignore, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const next = appendGitignoreLine(content, pattern);
  if (next !== null) await writeFile(gitignore, next, "utf8");
  return { pattern, added: next !== null };
}

/**
 * Returns changed files to HEAD, staged and unstaged changes alike. A file new since HEAD leaves
 * the index and goes to the Recycle Bin or Trash; a staged rename also brings back its original.
 */
export const revertChanges = queuedIndexWrite(async ({
  worktree,
  paths,
}: RpcInput<typeof gitRevertRpc>): Promise<RpcOutput<typeof gitRevertRpc>> => {
  const directory = await assertDirectory(worktree);
  for (const relativePath of paths) resolveInsideRoot(directory, relativePath);
  const head = await hasHead(directory);
  const inHead = new Set<string>();
  let renames = new Map<string, string>();
  if (head) {
    for (let start = 0; start < paths.length; start += STAGE_BATCH_SIZE) {
      const batch = paths.slice(start, start + STAGE_BATCH_SIZE);
      const listed = await runGit(directory, ["ls-tree", "-r", "-z", "--name-only", "HEAD", "--", ...batch]);
      for (const listedPath of listed.split("\0")) if (listedPath) inHead.add(listedPath);
    }
    renames = parseRenamesZ(await runGit(directory, ["diff", "--cached", "-M", "--name-status", "-z", "HEAD"]));
  }
  const restore: string[] = [];
  const remove: string[] = [];
  for (const relativePath of paths) {
    if (inHead.has(relativePath)) {
      restore.push(relativePath);
      continue;
    }
    remove.push(relativePath);
    const original = renames.get(relativePath);
    if (original) restore.push(original);
  }
  for (let start = 0; start < remove.length; start += STAGE_BATCH_SIZE) {
    await runGit(directory, [
      "--literal-pathspecs",
      "rm",
      "--cached",
      "--quiet",
      "--ignore-unmatch",
      "--",
      ...remove.slice(start, start + STAGE_BATCH_SIZE),
    ]);
  }
  // Out of the index first: if trashing fails, the files are untracked but still on disk
  const onDisk = remove.map((relativePath) => path.join(directory, relativePath)).filter((file) => existsSync(file));
  if (onDisk.length > 0) await moveToTrash(onDisk);
  for (let start = 0; start < restore.length; start += STAGE_BATCH_SIZE) {
    await runGit(directory, [
      "--literal-pathspecs",
      "restore",
      "--source=HEAD",
      "--staged",
      "--worktree",
      "--",
      ...restore.slice(start, start + STAGE_BATCH_SIZE),
    ]);
  }
  return {};
});

/** Unified diff of one file against HEAD (staged and unstaged together), or as new for untracked */
export async function fileDiff({
  worktree,
  path: relativePath,
}: RpcInput<typeof gitDiffRpc>): Promise<RpcOutput<typeof gitDiffRpc>> {
  const directory = await assertDirectory(worktree);
  resolveInsideRoot(directory, relativePath);
  const tracked = (await runGit(directory, ["ls-files", "--", relativePath])).trim() !== "";
  if (!tracked) {
    const diff = await runGit(
      directory,
      ["diff", "--no-index", "--no-color", "--", NULL_DEVICE, relativePath],
      [DIFF_DIFFERENCES_EXIT_CODE],
    );
    return { diff };
  }
  if (await hasHead(directory)) {
    return { diff: await runGit(directory, ["diff", "--no-color", "HEAD", "--", relativePath]) };
  }
  const staged = await runGit(directory, ["diff", "--no-color", "--cached", "--", relativePath]);
  const unstaged = await runGit(directory, ["diff", "--no-color", "--", relativePath]);
  return { diff: `${staged}${unstaged}` };
}

export async function commitLog({
  worktree,
  limit,
}: RpcInput<typeof gitLogRpc>): Promise<RpcOutput<typeof gitLogRpc>> {
  const directory = await assertDirectory(worktree);
  const count = limit ?? DEFAULT_LOG_LIMIT;
  return sharedReads(`log:${pathKey(directory)}:${count}`, async () => {
    try {
      const output = await runGit(
        directory,
        ["log", `-n${count}`, "--decorate=full", `--format=${LOG_FORMAT}`],
        [],
        { background: true },
      );
      return { commits: parseLog(output) };
    } catch (error) {
      // A repository without commits has no history. Asked only after a failed log, so the usual
      // case costs one git call
      if (!(await hasHead(directory, true))) return { commits: [] };
      throw error;
    }
  });
}

// diff-tree is plumbing: user diff settings do not apply, so renames are asked for
const COMMIT_LISTING = ["diff-tree", "-r", "-z", "-M", "--no-commit-id"];

/** A commit's message and the files it changes against its first parent (every file of a root commit) */
export async function commitDetails({
  worktree,
  sha,
}: RpcInput<typeof gitCommitDetailsRpc>): Promise<RpcOutput<typeof gitCommitDetailsRpc>> {
  const directory = await assertDirectory(worktree);
  // The files' texts are read next; the reader starts while git lists them
  prepareGitObjects(directory);
  // Most commits have a parent, so the files are listed beside the commit's description rather
  // than after it. A first commit has none: that listing fails unawaited and runs again with --root
  const againstParent = Promise.all([
    runGit(directory, [...COMMIT_LISTING, "--name-status", `${sha}^`, sha]),
    runGit(directory, [...COMMIT_LISTING, "--numstat", `${sha}^`, sha]),
  ]);
  againstParent.catch(() => undefined);
  // A signature check (log.showSignature) would print ahead of the format
  const header = parseCommitHeader(
    await runGit(directory, ["show", "-s", "--no-show-signature", `--format=${COMMIT_HEADER_FORMAT}`, sha, "--"]),
  );
  const [nameStatus, numstat] =
    header.parents.length > 0
      ? await againstParent
      : await Promise.all([
          runGit(directory, [...COMMIT_LISTING, "--name-status", "--root", header.sha]),
          runGit(directory, [...COMMIT_LISTING, "--numstat", "--root", header.sha]),
        ]);
  const totals = new Map(parseNumstatZ(numstat).map((record) => [record.path, record]));
  const files = parseNameStatusZ(nameStatus).map((record) => {
    const total = totals.get(record.path);
    return {
      ...record,
      additions: total?.additions ?? 0,
      deletions: total?.deletions ?? 0,
      binary: total?.binary ?? false,
      icon: fileIconId(record.path.slice(record.path.lastIndexOf("/") + 1)),
    };
  });
  return { ...header, files };
}

/** The worktree directory, after checking that the file's paths stay inside it */
async function commitFileDirectory({
  worktree,
  path: relativePath,
  previousPath,
}: RpcInput<typeof gitCommitFileRpc>): Promise<string> {
  const directory = await assertDirectory(worktree);
  resolveInsideRoot(directory, relativePath);
  if (previousPath) resolveInsideRoot(directory, previousPath);
  return directory;
}

/** A file's text: empty where the commit lacks the file, null when binary, too large, or not a file */
function blobText(object: GitObject): string | null {
  if (!object.found) return "";
  if (object.type !== "blob" || object.content === null) return null;
  const text = object.content.toString("utf8");
  return isText(text) ? normalizeLineEndings(text) : null;
}

/** A file's text in its commit's first parent and in the commit, for the diff views */
export async function commitFileSources(
  input: RpcInput<typeof gitCommitFileRpc>,
): Promise<RpcOutput<typeof gitCommitFileRpc>> {
  const directory = await commitFileDirectory(input);
  const { sha, path: filePath, previousPath } = input;
  // A first commit has no parent, so its files read as new
  const [commit, original, current] = await readGitObjects(
    directory,
    [`${sha}^{commit}`, `${sha}^:${previousPath ?? filePath}`, `${sha}:${filePath}`],
    MAX_TEXT_BYTES,
  );
  if (!commit.found) throw new Error(`Not a commit: ${sha}`);
  return { original: blobText(original), current: blobText(current) };
}

/** Unified diff of one file of a commit against its first parent */
export async function commitFileDiff(
  input: RpcInput<typeof gitCommitFileDiffRpc>,
): Promise<RpcOutput<typeof gitCommitFileDiffRpc>> {
  const directory = await commitFileDirectory(input);
  const patch = ["diff-tree", "-p", "-M", "--no-color", "--no-commit-id"];
  const paths = ["--", ...(input.previousPath ? [input.previousPath, input.path] : [input.path])];
  try {
    return { diff: await runGit(directory, [...patch, `${input.sha}^`, input.sha, ...paths]) };
  } catch (error) {
    // A first commit has no parent; it compares with nothing
    const [parent] = await readGitObjects(directory, [`${input.sha}^`], 0);
    if (parent.found) throw error;
    return { diff: await runGit(directory, [...patch, "--root", input.sha, ...paths]) };
  }
}

/** Commits staged changes, every tracked change (`-a`), or amends HEAD */
export const commit = queuedIndexWrite(async ({
  worktree,
  message,
  mode,
}: RpcInput<typeof gitCommitRpc>): Promise<RpcOutput<typeof gitCommitRpc>> => {
  const directory = await assertDirectory(worktree);
  const trimmed = message.trim();
  if (!trimmed && mode !== "amend") throw new Error("Enter a commit message");
  const args = ["commit"];
  switch (mode) {
    case "staged":
      break;
    case "tracked":
      args.push("--all");
      break;
    case "amend":
      args.push("--amend");
      break;
  }
  // git starts without a shell, so the message is one argument: newlines and quotes need no escaping
  args.push(...(trimmed ? ["-m", trimmed] : ["--no-edit"]));
  await runGit(directory, args);
  const [sha, subject] = (await runGit(directory, ["log", "-1", "--format=%H%x1f%s"])).trim().split("\x1f");
  return { sha, subject: subject ?? "" };
});

/** Undoes HEAD but keeps its changes staged (`reset --soft HEAD~1`) */
export const uncommit = queuedIndexWrite(async ({
  worktree,
}: RpcInput<typeof gitUncommitRpc>): Promise<RpcOutput<typeof gitUncommitRpc>> => {
  const directory = await assertDirectory(worktree);
  try {
    await runGit(directory, ["rev-parse", "--verify", "--quiet", "HEAD~1"]);
  } catch {
    throw new Error("The first commit cannot be undone this way");
  }
  const message = await runGit(directory, ["log", "-1", "--format=%B"]);
  await runGit(directory, ["reset", "--soft", "HEAD~1"]);
  return { message: message.trim() };
});

const NO_UPSTREAM_PATTERN = /no upstream branch|has no upstream/i;

/** Fetch, fast-forward-only pull, or push; a first push sets the upstream on origin */
export async function remote({
  worktree,
  action,
}: RpcInput<typeof gitRemoteRpc>): Promise<RpcOutput<typeof gitRemoteRpc>> {
  const directory = await assertDirectory(worktree);
  const options = { env: REMOTE_ENVIRONMENT, timeout: REMOTE_TIMEOUT_MS };
  switch (action) {
    case "fetch":
      await runGit(directory, ["fetch", "--prune"], [], options);
      return { message: "Fetched" };
    case "pull":
      await runGit(directory, ["pull", "--ff-only"], [], options);
      return { message: "Pulled" };
    case "push":
      try {
        await runGit(directory, ["push"], [], options);
      } catch (error) {
        if (!(error instanceof Error) || !NO_UPSTREAM_PATTERN.test(error.message)) throw error;
        await runGit(directory, ["push", "--set-upstream", "origin", "HEAD"], [], options);
      }
      return { message: "Pushed" };
  }
}

function nextWorktreePath(topLevel: string, shortSha: string): string {
  const base = `${topLevel}-${shortSha}`;
  let candidate = base;
  for (let suffix = 2; existsSync(candidate); suffix++) candidate = `${base}-${suffix}`;
  return candidate;
}

export const checkoutCommit = queuedIndexWrite(async ({
  worktree,
  sha,
  action,
  branch,
}: RpcInput<typeof gitCheckoutRpc>): Promise<RpcOutput<typeof gitCheckoutRpc>> => {
  const directory = await assertDirectory(worktree);
  const fullSha = (await runGit(directory, ["rev-parse", "--verify", `${sha}^{commit}`])).trim();
  const shortSha = fullSha.slice(0, 8);
  switch (action) {
    case "switch-branch": {
      if (!branch) throw new Error("Choose a branch to switch to");
      // Only local branches that point at this commit are accepted
      const branchSha = (
        await runGit(directory, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`])
      ).trim();
      if (branchSha !== fullSha) throw new Error(`${branch} does not point at ${shortSha}`);
      await runGit(directory, ["switch", "--no-guess", branch]);
      return { message: `Switched to ${branch}` };
    }
    case "checkout-detached": {
      await runGit(directory, ["switch", "--detach", fullSha]);
      return { message: `Checked out ${shortSha} (detached HEAD)` };
    }
    case "new-worktree": {
      const topLevel = (await runGit(directory, ["rev-parse", "--show-toplevel"])).trim();
      const worktreePath = nextWorktreePath(path.resolve(topLevel), shortSha);
      await runGit(directory, ["worktree", "add", "--detach", worktreePath, fullSha]);
      return { message: `Checked out ${shortSha} to ${worktreePath}`, worktreePath };
    }
  }
});
