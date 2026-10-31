import type { GitFile } from "../shared/git-contracts";
import { normalizeAbsolute } from "./tree-model";

// Latest git status per worktree, published by whichever panel loaded it, for readers outside
// React (diff tab labels)
const filesByWorktree = new Map<string, ReadonlyMap<string, GitFile>>();
const listeners = new Set<() => void>();

export function publishGitStatus(worktree: string, files: readonly GitFile[]): void {
  filesByWorktree.set(normalizeAbsolute(worktree), new Map(files.map((file) => [file.path, file])));
  for (const listener of listeners) listener();
}

/** The file's status; null when the worktree is known and the file is clean, undefined when unknown */
export function lookupChange(worktree: string, path: string): GitFile | null | undefined {
  const files = filesByWorktree.get(normalizeAbsolute(worktree));
  if (!files) return undefined;
  return files.get(path) ?? null;
}

export function subscribeGitStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
