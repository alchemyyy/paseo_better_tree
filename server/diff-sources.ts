import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { diffSourcesRpc } from "../shared/diff-contracts";

const GIT_COMMAND = process.platform === "win32" ? "git.exe" : "git";
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const GIT_ENVIRONMENT = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      GIT_COMMAND,
      args,
      { cwd, env: GIT_ENVIRONMENT, maxBuffer: MAX_TEXT_BYTES * 2, windowsHide: true, encoding: "utf8" },
      (error, stdout, stderr) => (error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout)),
    );
  });
}

function isText(content: string): boolean {
  return !content.includes("\0");
}

/**
 * Git compares with line endings normalized (core.autocrlf, .gitattributes), so a CRLF working
 * copy matches its LF blob; without this every line differs by a trailing \r
 */
function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n/g, "\n");
}

async function readCurrent(filePath: string): Promise<string | null> {
  try {
    const stats = await stat(filePath);
    if (!stats.isFile() || stats.size > MAX_TEXT_BYTES) return null;
    const content = await readFile(filePath, "utf8");
    return isText(content) ? content : null;
  } catch {
    return null;
  }
}

/** HEAD's text for the file: "" when the repository does not track it yet, null outside one */
async function readOriginal(filePath: string): Promise<string | null> {
  const directory = path.dirname(filePath);
  let topLevel: string;
  try {
    topLevel = (await git(directory, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    return null;
  }
  const relative = path.relative(topLevel, filePath).split(path.sep).join("/");
  try {
    const original = await git(topLevel, ["show", `HEAD:${relative}`]);
    return isText(original) ? original : null;
  } catch {
    // Not in HEAD: a new or untracked file, or a repository without commits
    return "";
  }
}

/** Both sides of a file's diff against HEAD */
export async function diffSources(
  { path: requestedPath, workspaceId }: RpcInput<typeof diffSourcesRpc>,
  { paseo }: PluginHandlerContext,
): Promise<RpcOutput<typeof diffSourcesRpc>> {
  let absolutePath = requestedPath;
  if (!path.isAbsolute(requestedPath)) {
    if (!workspaceId) throw new Error("A relative path needs its workspace");
    const workspace = paseo.workspaces.ref(workspaceId);
    if (!workspace.directory) await workspace.refresh();
    if (!workspace.directory) throw new Error("The workspace has no directory");
    absolutePath = path.join(workspace.directory, requestedPath);
  }
  absolutePath = path.resolve(absolutePath);
  const [current, original] = await Promise.all([readCurrent(absolutePath), readOriginal(absolutePath)]);
  return {
    absolutePath,
    current: current === null ? null : normalizeLineEndings(current),
    original: original === null ? null : normalizeLineEndings(original),
  };
}
