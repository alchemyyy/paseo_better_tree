import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { Repository, gitRepositoriesRpc } from "../shared/git-contracts";
// NOTE: Explicit extension so `node --test` can load this module directly
import { FILE_WORK_CONCURRENCY, mapLimited } from "./file-work.ts";
import { compareNames, HIDDEN_NAMES, isRepositoryFolder, UNSEARCHED_FOLDERS } from "./tree.ts";

// shortcut: bounds the walk for repositories, raise if large folders come back incomplete. The Git
// panel shows while it runs, so the time cap only guards against a walk that never ends; under load
// a tighter one cut lists short
const SEARCH_BUDGET_MS = 10_000;
const MAX_FOLDERS = 50_000;

/** Whether `directory` or a folder above it holds `.git`, where git would find a repository */
export async function isInsideRepository(directory: string): Promise<boolean> {
  let current = directory;
  while (!(await isRepositoryFolder(current))) {
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
  return true;
}

/** The branch checked out in a repository, read from HEAD without running git; null when detached or unreadable */
async function readBranch(repository: string): Promise<string | null> {
  try {
    let gitDirectory = path.join(repository, ".git");
    // Linked worktrees and submodules hold a `.git` file naming their git directory
    if ((await stat(gitDirectory)).isFile()) {
      const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(await readFile(gitDirectory, "utf8"));
      if (!pointer) return null;
      gitDirectory = path.resolve(repository, pointer[1]!);
    }
    const head = await readFile(path.join(gitDirectory, "HEAD"), "utf8");
    return /^ref:\s*refs\/heads\/(.+?)\s*$/.exec(head)?.[1] ?? null;
  } catch {
    return null;
  }
}

function joinRelative(prefix: string, name: string): string {
  return prefix ? `${prefix}/${name}` : name;
}

/** Tree order of folder paths: segment by segment, natural name order */
function compareFolderPaths(left: string, right: string): number {
  const leftSegments = left.split("/");
  const rightSegments = right.split("/");
  const shared = Math.min(leftSegments.length, rightSegments.length);
  for (let index = 0; index < shared; index++) {
    const order = compareNames(leftSegments[index]!, rightSegments[index]!);
    if (order !== 0) return order;
  }
  return leftSegments.length - rightSegments.length;
}

/**
 * Repositories inside `root` (which is in none), outermost only: a repository's own folders are
 * not searched. Walks breadth first without following links, and stops early in a very large folder.
 */
async function findRepositories(root: string): Promise<{ repositories: string[]; incomplete: boolean }> {
  const repositories: string[] = [];
  const deadline = Date.now() + SEARCH_BUDGET_MS;
  let visited = 0;
  let level = [""];
  while (level.length > 0) {
    const next: string[] = [];
    for (let start = 0; start < level.length; start += FILE_WORK_CONCURRENCY) {
      if (Date.now() > deadline || visited >= MAX_FOLDERS) return { repositories, incomplete: true };
      const batch = level.slice(start, start + FILE_WORK_CONCURRENCY);
      visited += batch.length;
      const listings = await Promise.all(
        batch.map((folder) => readdir(path.join(root, folder), { withFileTypes: true }).catch(() => null)),
      );
      batch.forEach((folder, index) => {
        const dirents = listings[index];
        if (!dirents) return;
        if (folder !== "" && dirents.some((dirent) => dirent.name === ".git")) {
          repositories.push(folder);
          return;
        }
        for (const dirent of dirents) {
          if (dirent.isDirectory() && !HIDDEN_NAMES.has(dirent.name) && !UNSEARCHED_FOLDERS.has(dirent.name)) {
            next.push(joinRelative(folder, dirent.name));
          }
        }
      });
    }
    level = next;
  }
  return { repositories, incomplete: false };
}

/** Outside any repository, the repositories inside `root`; in one, none, since that repository is what shows */
export async function listRepositories({
  root,
}: RpcInput<typeof gitRepositoriesRpc>): Promise<RpcOutput<typeof gitRepositoriesRpc>> {
  const directory = path.resolve(root);
  if (!(await stat(directory).catch(() => null))?.isDirectory()) throw new Error(`Folder does not exist: ${root}`);
  if (await isInsideRepository(directory)) return { repositories: [], incomplete: false };
  const { repositories, incomplete } = await findRepositories(directory);
  repositories.sort(compareFolderPaths);
  return {
    repositories: await mapLimited(repositories, async (relativePath): Promise<Repository> => {
      const absolute = path.join(directory, relativePath);
      return { path: absolute, relativePath, branch: await readBranch(absolute) };
    }),
    incomplete,
  };
}
