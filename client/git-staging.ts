import { useRpc } from "@getpaseo/plugin/client";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useState } from "react";
import { type GitFile, gitStageRpc } from "../shared/git-contracts";
import { GIT_QUERY_KEY } from "./git-live";
import { createStageTracker, type StageTracker, withStaged } from "./git-model";

type Overrides = ReadonlyMap<string, ReadonlyMap<string, boolean>>;

const NO_OVERRIDES: ReadonlyMap<string, boolean> = new Map();

/** `current` with `paths` of `worktree` set to `staged`, or dropped for null */
function patchOverrides(current: Overrides, worktree: string, paths: readonly string[], staged: boolean | null): Overrides {
  if (paths.length === 0) return current;
  const inWorktree = new Map(current.get(worktree));
  for (const path of paths) {
    if (staged === null) inWorktree.delete(path);
    else inWorktree.set(path, staged);
  }
  const next = new Map(current);
  if (inWorktree.size === 0) next.delete(worktree);
  else next.set(worktree, inWorktree);
  return next;
}

/**
 * Staging that shows at once. A toggled file keeps its new state until the server answers with
 * the status it read right after the change; that answer replaces the cached status, and a status
 * read still running from before the change is cancelled, so the old state never comes back.
 */
export function useStaging(
  worktree: string | null,
  serverFiles: readonly GitFile[],
  onError: (error: unknown) => void,
): { files: readonly GitFile[]; setStaged(paths: readonly string[], staged: boolean): void } {
  const stage = useRpc(gitStageRpc);
  const queryClient = useQueryClient();
  // What the user set and no status read shows yet, by worktree, then path
  const [overrides, setOverrides] = useState<Overrides>(new Map());
  const trackersRef = useRef(new Map<string, StageTracker>());
  const pending = (worktree !== null && overrides.get(worktree)) || NO_OVERRIDES;
  const files = useMemo(() => {
    if (pending.size === 0) return serverFiles;
    return serverFiles.map((file) => {
      const staged = pending.get(file.path);
      return staged === undefined ? file : withStaged(file, staged);
    });
  }, [serverFiles, pending]);

  const setStaged = useCallback(
    (paths: readonly string[], staged: boolean) => {
      if (!worktree || paths.length === 0) return;
      let tracker = trackersRef.current.get(worktree);
      if (!tracker) {
        tracker = createStageTracker();
        trackersRef.current.set(worktree, tracker);
      }
      const ownTracker = tracker;
      const id = ownTracker.begin(paths);
      setOverrides((current) => patchOverrides(current, worktree, paths, staged));
      const statusKey = [...GIT_QUERY_KEY, "status", worktree];
      void (async () => {
        let result: GitFile[] | null = null;
        try {
          result = (await stage({ worktree, paths: [...paths], staged })).files;
        } catch (error) {
          onError(error);
        }
        if (result) await queryClient.cancelQueries({ queryKey: statusKey, exact: true });
        // No await from here on, so a newer answer cannot be overwritten by this one
        const { apply, released } = ownTracker.finish(id, paths, result !== null);
        if (result && apply) queryClient.setQueryData(statusKey, { files: result });
        setOverrides((current) => patchOverrides(current, worktree, released, null));
        // git refused the change: show the index as it really is
        if (!result) void queryClient.invalidateQueries({ queryKey: statusKey, exact: true });
      })();
    },
    [worktree, stage, queryClient, onError],
  );

  return { files, setStaged };
}
