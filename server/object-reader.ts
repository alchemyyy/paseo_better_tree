// Reads git objects through one long-lived `git cat-file --batch` per worktree. Starting a process
// costs tens of milliseconds, and on Windows often several hundred; a running batch answers within
// one. It sees objects written after it started, and `git gc` replaces packs under it unhindered.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import path from "node:path";

const GIT_COMMAND = process.platform === "win32" ? "git.exe" : "git";
const GIT_ENVIRONMENT = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
// shortcut: a reader lives while a commit's files are browsed, raise if reopening shows between clicks
const IDLE_CLOSE_MS = 60_000;
// A read unanswered this long means git is wedged; failing the reader lets the next read start a new one
const OBJECT_READ_TIMEOUT_MS = 20_000;
const STDERR_LIMIT = 2000;
const LINE_FEED = 0x0a;
// "<object id> <type> <size>"; any other answer ("<name> missing", "<name> ambiguous") names nothing
const FOUND_HEADER = /^[0-9a-f]+ (\S+) (\d+)$/;

/** An object `git cat-file` looked up by name */
export type GitObject =
  | { found: false }
  | {
      found: true;
      type: string;
      size: number;
      /** Null past the size limit the read asked for */
      content: Buffer | null;
    };

export interface PendingRead {
  maxBytes: number;
  resolve(object: GitObject): void;
}

interface Contents {
  read: PendingRead;
  type: string;
  size: number;
  /** Null while skipping contents past the size limit */
  parts: Buffer[] | null;
  /** Bytes still to come, counting the line feed after the contents */
  remaining: number;
}

/**
 * Splits `git cat-file --batch` output, arriving in chunks of any size, into one answer per name
 * written, handing each to the read `nextRead` returns. Throws on an answer nothing asked for.
 */
export class BatchOutput {
  private readonly nextRead: () => PendingRead | undefined;
  private headerParts: Buffer[] = [];
  private contents: Contents | null = null;

  // NOTE: no parameter properties, so `node --test` can load this module by stripping types
  constructor(nextRead: () => PendingRead | undefined) {
    this.nextRead = nextRead;
  }

  /** The read whose contents are still arriving */
  get inProgress(): PendingRead | null {
    return this.contents?.read ?? null;
  }

  push(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      const contents = this.contents;
      if (contents) {
        const taken = Math.min(contents.remaining, chunk.length - offset);
        contents.parts?.push(chunk.subarray(offset, offset + taken));
        contents.remaining -= taken;
        offset += taken;
        if (contents.remaining > 0) continue;
        this.contents = null;
        const content = contents.parts ? Buffer.concat(contents.parts).subarray(0, contents.size) : null;
        contents.read.resolve({ found: true, type: contents.type, size: contents.size, content });
        continue;
      }
      const lineEnd = chunk.indexOf(LINE_FEED, offset);
      if (lineEnd === -1) {
        this.headerParts.push(chunk.subarray(offset));
        return;
      }
      this.headerParts.push(chunk.subarray(offset, lineEnd));
      offset = lineEnd + 1;
      const header = Buffer.concat(this.headerParts).toString("utf8");
      this.headerParts = [];
      const read = this.nextRead();
      if (!read) throw new Error(`git cat-file answered a name nobody asked for: ${header}`);
      const match = FOUND_HEADER.exec(header);
      if (!match) {
        read.resolve({ found: false });
        continue;
      }
      const size = Number(match[2]);
      this.contents = { read, type: match[1], size, parts: size <= read.maxBytes ? [] : null, remaining: size + 1 };
    }
  }
}

interface QueuedRead extends PendingRead {
  reject(error: Error): void;
}

class BatchReader {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly onStopped: () => void;
  /** Answers come back in the order names were written */
  private readonly queue: QueuedRead[] = [];
  private readonly output = new BatchOutput(() => this.queue.shift());
  private stderr = "";
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  /** Settles once git has exited, so a shutdown can wait for its working directory to be released */
  readonly closed: Promise<void>;

  constructor(directory: string, onStopped: () => void) {
    this.onStopped = onStopped;
    this.child = spawn(GIT_COMMAND, ["cat-file", "--batch"], { cwd: directory, env: GIT_ENVIRONMENT, windowsHide: true });
    this.child.stdout.on("data", (chunk: Buffer) => {
      try {
        this.output.push(chunk);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(-STDERR_LIMIT);
    });
    // A write racing the process's exit fails here; "close" says why
    this.child.stdin.on("error", () => undefined);
    // NOTE: executor form, since tsconfig's ES2023 lib has no Promise.withResolvers
    this.closed = new Promise((resolve) => {
      this.child.on("error", (error) => {
        this.fail(error);
        resolve();
      });
      this.child.on("close", () => {
        this.fail(new Error(this.stderr.trim() || "git cat-file stopped"));
        resolve();
      });
    });
    this.scheduleIdleClose();
  }

  read(name: string, maxBytes: number): Promise<GitObject> {
    // A line break would turn one name into two and misalign every later answer
    if (name.includes("\n")) return Promise.reject(new Error(`Git cannot look up a name holding a line break: ${name}`));
    if (this.stopped) return Promise.reject(new Error("git cat-file stopped"));
    // NOTE: executor form, since tsconfig's ES2023 lib has no Promise.withResolvers
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(new Error(`git cat-file did not answer within ${OBJECT_READ_TIMEOUT_MS} ms`)),
        OBJECT_READ_TIMEOUT_MS,
      );
      this.queue.push({
        maxBytes,
        resolve: (object) => {
          clearTimeout(timer);
          resolve(object);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.child.stdin.write(`${name}\n`);
      this.scheduleIdleClose();
    });
  }

  /** Ends git's input, so it exits once it has answered what was asked */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.idleTimer);
    this.child.stdin.end();
    this.onStopped();
  }

  private scheduleIdleClose(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.queue.length > 0 || this.output.inProgress) this.scheduleIdleClose();
      else this.stop();
    }, IDLE_CLOSE_MS);
  }

  private fail(error: Error): void {
    this.stop();
    this.child.kill();
    const inProgress = this.output.inProgress as QueuedRead | null;
    for (const read of [...(inProgress ? [inProgress] : []), ...this.queue.splice(0)]) read.reject(error);
  }
}

const readers = new Map<string, BatchReader>();

function readerFor(directory: string): BatchReader {
  const key = path.resolve(directory);
  const existing = readers.get(key);
  if (existing) return existing;
  const reader: BatchReader = new BatchReader(key, () => {
    if (readers.get(key) === reader) readers.delete(key);
  });
  readers.set(key, reader);
  return reader;
}

/** Starts the worktree's reader ahead of reads about to come, so the first one does not wait for git to start */
export function prepareGitObjects(directory: string): void {
  readerFor(directory);
}

/** Looks up objects by any name `git cat-file` takes, such as `<commit>:<path>`, in one round trip */
export function readGitObjects(directory: string, names: readonly string[], maxBytes: number): Promise<GitObject[]> {
  const reader = readerFor(directory);
  return Promise.all(names.map((name) => reader.read(name, maxBytes)));
}

/** Stops every reader and settles once their git processes have exited; the plugin's cleanup calls this */
export async function stopGitObjectReaders(): Promise<void> {
  const stopping = [...readers.values()];
  for (const reader of stopping) reader.stop();
  await Promise.all(stopping.map((reader) => reader.closed));
}
