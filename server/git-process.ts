import { type ChildProcess, execFile, type ExecFileException } from "node:child_process";
import { SHARE_ENV, Worker } from "node:worker_threads";

// Running git.exe directly on Windows avoids cmd.exe argument expansion
const GIT_COMMAND = process.platform === "win32" ? "git.exe" : "git";
// The daemon gives up on an RPC after 30 s; a polling read stops there too
const BACKGROUND_TIMEOUT_MS = 30_000;
/** Polling reads git runs at once; the rest wait their turn, so a user's own git call starts at once */
const BACKGROUND_CONCURRENCY = 4;
/** Low-priority reads take at most this many of those slots, so a shown panel's reads find one free */
const LOW_CONCURRENCY = 2;
// execFile's own default
const DEFAULT_MAX_BUFFER = 1024 * 1024;

export interface GitProcessOptions {
  env?: NodeJS.ProcessEnv;
  /** Kills git after this many ms; background runs default to 30_000 */
  timeout?: number;
  maxBuffer?: number;
  /** Polling reads: wait for one of a few background slots; interactive runs never wait */
  background?: boolean;
  /** A background read for something secondary (a worktree row's totals): starts only while no other background read waits */
  low?: boolean;
}

export interface GitProcessResult {
  stdout: string;
  stderr: string;
  /** Exit code, or null when git did not exit on its own (killed, failed to start) */
  exitCode: number | null;
  /** Why git failed (failed to start, timed out, too much output, non-zero exit); null on success */
  error: string | null;
}

interface RunOptions {
  env: NodeJS.ProcessEnv | undefined;
  timeout: number;
  maxBuffer: number;
}

type Lane = "interactive" | "background" | "low";

interface Run {
  cwd: string;
  args: string[];
  options: RunOptions;
  lane: Lane;
  resolve: (result: GitProcessResult) => void;
}

interface WorkerReply {
  id: number;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error: string | null;
}

// Starting a process on Windows blocked the plugin's main thread for up to 1.3 s in a profile; in a
// worker it blocks only the worker. Plain source, so the bundler leaves it as written. Its exit
// mapping matches exitOf below. `{ stop: true }` kills its git processes and ends the worker.
const WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
const { execFile } = require("node:child_process");
const GIT_COMMAND = process.platform === "win32" ? "git.exe" : "git";
const children = new Set();
function exitOf(error, options) {
  if (!error) return { exitCode: 0, error: null };
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return { exitCode: null, error: "git printed more than " + options.maxBuffer + " bytes" };
  }
  if (error.killed && options.timeout > 0) return { exitCode: null, error: "git timed out after " + options.timeout + " ms" };
  if (typeof error.code === "number") return { exitCode: error.code, error: error.message };
  return { exitCode: null, error: error.message };
}
parentPort.on("message", (message) => {
  if (message.stop) {
    for (const child of children) child.kill();
    process.exit(0);
  }
  const { id, cwd, args, options } = message;
  try {
    const child = execFile(
      GIT_COMMAND,
      args,
      { cwd, env: options.env, timeout: options.timeout, maxBuffer: options.maxBuffer, windowsHide: true, encoding: "utf8" },
      (error, stdout, stderr) => {
        children.delete(child);
        parentPort.postMessage({ id, stdout, stderr, ...exitOf(error, options) });
      },
    );
    children.add(child);
  } catch (error) {
    parentPort.postMessage({ id, stdout: "", stderr: "", ...exitOf(error, options) });
  }
});
`;

interface GitWorker {
  worker: Worker;
  /** Runs posted to the worker and not answered yet, by id */
  running: Map<number, Run>;
}

let gitWorker: GitWorker | null = null;
// Set once a Worker cannot be created; git then starts from the main thread
let workerUnavailable = false;
let nextRunId = 0;
/** Runs started from the main thread, by their process */
const mainThreadRuns = new Map<ChildProcess, Run>();
let backgroundRunning = 0;
let lowRunning = 0;
const backgroundWaiting: Run[] = [];
const lowWaiting: Run[] = [];

function exitOf(error: ExecFileException | null, options: RunOptions): Pick<GitProcessResult, "exitCode" | "error"> {
  if (!error) return { exitCode: 0, error: null };
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return { exitCode: null, error: `git printed more than ${options.maxBuffer} bytes` };
  }
  if (error.killed && options.timeout > 0) return { exitCode: null, error: `git timed out after ${options.timeout} ms` };
  if (typeof error.code === "number") return { exitCode: error.code, error: error.message };
  return { exitCode: null, error: error.message };
}

function startWaiting(): void {
  while (backgroundRunning < BACKGROUND_CONCURRENCY) {
    const next = backgroundWaiting.shift() ?? (lowRunning < LOW_CONCURRENCY ? lowWaiting.shift() : undefined);
    if (!next) return;
    backgroundRunning++;
    if (next.lane === "low") lowRunning++;
    start(next);
  }
}

function finish(run: Run, result: GitProcessResult): void {
  run.resolve(result);
  if (run.lane === "interactive") return;
  backgroundRunning--;
  if (run.lane === "low") lowRunning--;
  startWaiting();
}

/** Settles every run the worker had, after it failed, exited, or was stopped */
function abandonWorker(state: GitWorker, reason: string): void {
  if (gitWorker === state) gitWorker = null;
  const runs = [...state.running.values()];
  state.running.clear();
  for (const run of runs) finish(run, { stdout: "", stderr: "", exitCode: null, error: reason });
}

function currentWorker(): GitWorker | null {
  if (gitWorker || workerUnavailable) return gitWorker;
  let worker: Worker;
  try {
    worker = new Worker(WORKER_SOURCE, { eval: true, env: SHARE_ENV });
  } catch {
    workerUnavailable = true;
    return null;
  }
  const state: GitWorker = { worker, running: new Map() };
  // Held only while git runs, so an idle worker never keeps the plugin process alive
  worker.unref();
  worker.on("message", (reply: WorkerReply) => {
    const run = state.running.get(reply.id);
    if (!run) return;
    state.running.delete(reply.id);
    if (state.running.size === 0) worker.unref();
    finish(run, { stdout: reply.stdout, stderr: reply.stderr, exitCode: reply.exitCode, error: reply.error });
  });
  worker.on("error", (error: unknown) =>
    abandonWorker(state, `git worker failed: ${error instanceof Error ? error.message : String(error)}`),
  );
  worker.on("exit", (code) => abandonWorker(state, `git worker exited with code ${code}`));
  gitWorker = state;
  return state;
}

function runOnMainThread(run: Run): void {
  const { options } = run;
  try {
    const child = execFile(
      GIT_COMMAND,
      run.args,
      {
        cwd: run.cwd,
        env: options.env,
        timeout: options.timeout,
        maxBuffer: options.maxBuffer,
        windowsHide: true,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        // A stopped run was settled already
        if (!mainThreadRuns.delete(child)) return;
        finish(run, { stdout, stderr, ...exitOf(error, options) });
      },
    );
    mainThreadRuns.set(child, run);
  } catch (error) {
    finish(run, { stdout: "", stderr: "", exitCode: null, error: error instanceof Error ? error.message : String(error) });
  }
}

function start(run: Run): void {
  const state = currentWorker();
  if (!state) {
    runOnMainThread(run);
    return;
  }
  const id = nextRunId++;
  state.running.set(id, run);
  state.worker.ref();
  try {
    state.worker.postMessage({ id, cwd: run.cwd, args: run.args, options: run.options });
  } catch (error) {
    state.running.delete(id);
    if (state.running.size === 0) state.worker.unref();
    finish(run, { stdout: "", stderr: "", exitCode: null, error: error instanceof Error ? error.message : String(error) });
  }
}

/** Runs git without a shell. Never rejects: a failure comes back as `error` and `exitCode` */
export function runGitProcess(cwd: string, args: string[], options: GitProcessOptions = {}): Promise<GitProcessResult> {
  let lane: Lane = "interactive";
  if (options.low) lane = "low";
  else if (options.background) lane = "background";
  // NOTE: executor form, since tsconfig's ES2023 lib has no Promise.withResolvers
  return new Promise((resolve) => {
    const run: Run = {
      cwd,
      args,
      options: {
        env: options.env,
        timeout: options.timeout ?? (lane === "interactive" ? 0 : BACKGROUND_TIMEOUT_MS),
        maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
      },
      lane,
      resolve,
    };
    if (lane === "interactive") {
      start(run);
      return;
    }
    (lane === "low" ? lowWaiting : backgroundWaiting).push(run);
    startWaiting();
  });
}

/** Ends every git run, waiting or running, with an error; a later run starts a new worker */
export function stopGitProcesses(): void {
  const stopped = "git was stopped";
  for (const run of [...backgroundWaiting.splice(0), ...lowWaiting.splice(0)]) {
    run.resolve({ stdout: "", stderr: "", exitCode: null, error: stopped });
  }
  const state = gitWorker;
  if (state) {
    // The worker kills its git processes and exits; held no longer, so a stuck worker cannot keep
    // the plugin process alive
    state.worker.postMessage({ stop: true });
    state.worker.unref();
    abandonWorker(state, stopped);
  }
  for (const [child, run] of [...mainThreadRuns]) {
    mainThreadRuns.delete(child);
    child.kill();
    finish(run, { stdout: "", stderr: "", exitCode: null, error: stopped });
  }
}
