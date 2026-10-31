import { useRpc } from "@getpaseo/plugin/client";
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { gitChangesRpc, gitStatusRpc, gitWorktreesRpc } from "../shared/git-contracts";
import { changeColorsByPath } from "./change-list";
import { publishGitStatus } from "./change-registry";

export const GIT_QUERY_KEY = ["better-tree", "git"] as const;
// File events drive refreshes; these slower polls only catch what the watcher cannot see, such as
// other worktrees changing. They keep running while the window is unfocused
export const GIT_REFRESH_MS = 30_000;
const CHANGE_RETRY_MS = 2000;

type WaitForChanges = (input: { worktree: string; version: number }) => Promise<{ version: number }>;

// One long-poll per worktree however many panels watch it, so a change refreshes the cache once
const changeLoops = new Map<string, { subscribers: number; stop(): void }>();

function startChangeLoop(worktree: string, waitForChanges: WaitForChanges, queryClient: QueryClient): () => void {
  let stopped = false;
  void (async () => {
    let version = 0;
    while (!stopped) {
      try {
        const result = await waitForChanges({ worktree, version });
        if (stopped) return;
        // The first answer only establishes the version; later ones mean something changed
        if (version !== 0 && result.version !== version) {
          await queryClient.invalidateQueries({ queryKey: GIT_QUERY_KEY });
        }
        version = result.version;
      } catch {
        if (stopped) return;
        await new Promise((resolve) => setTimeout(resolve, CHANGE_RETRY_MS));
      }
    }
  })();
  return () => {
    stopped = true;
  };
}

/**
 * Event-driven refresh: the daemon watches the worktree and answers this long-poll as soon as a
 * file (or the index, HEAD, refs) changes; every Git query is then refetched
 */
export function useGitChangeRefresh(worktree: string | null): void {
  const waitForChanges = useRpc(gitChangesRpc);
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!worktree) return;
    let loop = changeLoops.get(worktree);
    if (!loop) {
      loop = { subscribers: 0, stop: startChangeLoop(worktree, waitForChanges, queryClient) };
      changeLoops.set(worktree, loop);
    }
    loop.subscribers++;
    const subscribed = loop;
    return () => {
      subscribed.subscribers--;
      if (subscribed.subscribers > 0) return;
      subscribed.stop();
      changeLoops.delete(worktree);
    };
  }, [worktree, waitForChanges, queryClient]);
}

/**
 * Change colors for the worktree holding `directory`, keyed by normalizeAbsolute path; empty
 * while `enabled` is off. Shares the Git panel's query cache
 */
export function useGitChangeColors(directory: string | null, enabled: boolean): ReadonlyMap<string, string> {
  const loadWorktrees = useRpc(gitWorktreesRpc);
  const loadStatus = useRpc(gitStatusRpc);
  const worktrees = useQuery({
    queryKey: [...GIT_QUERY_KEY, "worktrees", directory],
    queryFn: () => loadWorktrees({ root: directory ?? "" }),
    enabled: enabled && directory !== null,
    refetchInterval: GIT_REFRESH_MS,
    refetchIntervalInBackground: true,
  });
  const worktree = enabled
    ? (worktrees.data?.worktrees.find((candidate) => candidate.current && !candidate.missing)?.path ?? null)
    : null;
  const status = useQuery({
    queryKey: [...GIT_QUERY_KEY, "status", worktree],
    queryFn: () => loadStatus({ worktree: worktree ?? "" }),
    enabled: worktree !== null,
    refetchInterval: GIT_REFRESH_MS,
    refetchIntervalInBackground: true,
  });
  useGitChangeRefresh(worktree);
  const files = status.data?.files;
  useEffect(() => {
    if (worktree && files) publishGitStatus(worktree, files);
  }, [worktree, files]);
  return useMemo(
    () => (worktree && files ? changeColorsByPath(files, worktree) : new Map<string, string>()),
    [worktree, files],
  );
}
