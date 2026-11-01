import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { diffSourcesRpc } from "../shared/diff-contracts.ts";
import { readGitObjects } from "./object-reader.ts";

/** Files and blobs larger than this show no diff */
export const MAX_TEXT_BYTES = 4 * 1024 * 1024;

export function isText(content: string): boolean {
  return !content.includes("\0");
}

/**
 * Git compares with line endings normalized (core.autocrlf, .gitattributes), so a CRLF working
 * copy matches its LF blob; without this every line differs by a trailing \r
 */
export function normalizeLineEndings(content: string): string {
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

/** The nearest directory holding a `.git` entry: a directory, or a file in linked worktrees and submodules */
async function findTopLevel(directory: string): Promise<string | null> {
  let current = directory;
  for (;;) {
    try {
      await stat(path.join(current, ".git"));
      return current;
    } catch {
      // Not here; try the parent
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** HEAD's text for the file: "" when the repository does not track it yet, null outside one */
async function readOriginal(filePath: string): Promise<string | null> {
  const topLevel = await findTopLevel(path.dirname(filePath));
  if (!topLevel) return null;
  // cat-file reads `HEAD:<path>` relative to the top level, with forward slashes
  const relative = path.relative(topLevel, filePath).split(path.sep).join("/");
  try {
    const [object] = await readGitObjects(topLevel, [`HEAD:${relative}`], MAX_TEXT_BYTES);
    // Not in HEAD: a new or untracked file, or a repository without commits
    if (!object.found || object.type !== "blob") return "";
    if (!object.content) return null;
    const original = object.content.toString("utf8");
    return isText(original) ? original : null;
  } catch {
    return "";
  }
}

/** Both sides of a file's diff against HEAD */
export async function readDiffSources(absolutePath: string): Promise<RpcOutput<typeof diffSourcesRpc>> {
  const [current, original] = await Promise.all([readCurrent(absolutePath), readOriginal(absolutePath)]);
  return {
    absolutePath,
    current: current === null ? null : normalizeLineEndings(current),
    original: original === null ? null : normalizeLineEndings(original),
  };
}

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
  return readDiffSources(path.resolve(absolutePath));
}
