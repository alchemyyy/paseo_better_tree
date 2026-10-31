import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { TreeEntry, listDirectoryRpc } from "../shared/contracts";
// NOTE: Explicit extensions so `node --test` can load this module through tree-search.ts
import { mapLimited } from "./file-work.ts";
import { fileIconId } from "./file-icons.ts";
import { normalizeRelativePath, resolveInsideRoot } from "./workspace-path.ts";

/** Names the tree never shows */
export const HIDDEN_NAMES: ReadonlySet<string> = new Set([".git"]);
/** Folders found by name but never searched through, as in VS Code's default search.exclude */
export const UNSEARCHED_FOLDERS: ReadonlySet<string> = new Set(["node_modules", "bower_components"]);
const NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Natural name order, ignoring case */
export function compareNames(left: string, right: string): number {
  return NAME_COLLATOR.compare(left, right);
}

/** Tree order within a folder: directories first, then natural name order */
export function compareTreeEntries(left: TreeEntry, right: TreeEntry): number {
  if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
  return compareNames(left.name, right.name);
}

/** Whether a folder is the top level of a Git repository or worktree: it holds a `.git` folder or file */
export function isRepositoryFolder(directory: string): Promise<boolean> {
  return stat(path.join(directory, ".git")).then(
    () => true,
    () => false,
  );
}

/** Lists one directory level, directories first, then natural name order */
export async function listDirectory({
  root,
  path: relativePath,
}: RpcInput<typeof listDirectoryRpc>): Promise<RpcOutput<typeof listDirectoryRpc>> {
  const directory = resolveInsideRoot(root, relativePath);
  const prefix = normalizeRelativePath(relativePath);
  const dirents = await readdir(directory, { withFileTypes: true });
  // Each folder costs a check for `.git`, so a big folder's are spread over the thread pool
  const entries = await mapLimited(
    dirents.filter((dirent) => !HIDDEN_NAMES.has(dirent.name)),
    async (dirent): Promise<TreeEntry> => {
      const absolute = path.join(directory, dirent.name);
      const isDirectory = dirent.isDirectory() || (dirent.isSymbolicLink() && (await isDirectoryTarget(absolute)));
      return {
        name: dirent.name,
        path: prefix ? `${prefix}/${dirent.name}` : dirent.name,
        kind: isDirectory ? "directory" : "file",
        icon: isDirectory ? undefined : fileIconId(dirent.name),
        repository: isDirectory ? await isRepositoryFolder(absolute) : undefined,
      };
    },
  );
  entries.sort(compareTreeEntries);
  return { entries };
}

async function isDirectoryTarget(linkPath: string): Promise<boolean> {
  try {
    return (await stat(linkPath)).isDirectory();
  } catch {
    // NOTE: broken links list as files
    return false;
  }
}
