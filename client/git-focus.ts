import { z } from "zod";
import { CommitModeSchema } from "../shared/git-contracts";
import type { PaneBridge } from "./host-bridge";
import { findPanelTabs, type LayoutStoreApi, showGitTab } from "./layout-guard";
import { GIT_PANEL_ID } from "./panel-ids";

// Older tab states also carry `staged`; zod drops it
const FilterSchema = z.object({ tracked: z.boolean(), untracked: z.boolean() });
export type FileFilter = z.infer<typeof FilterSchema>;

export const GitTabStateSchema = z.object({
  /**
   * Absolute folder of a repository picked in the panel's list or focused from the file tree;
   * absent or null follows the main file tree's root folder
   */
  repository: z.string().nullable().optional(),
  worktree: z.string().nullable(),
  filter: FilterSchema,
  /** Unsent commit message draft */
  commitMessage: z.string().optional(),
  /** Commit mode the user picked; absent follows the staged files */
  commitMode: CommitModeSchema.nullable().optional(),
});
export type GitTabState = z.infer<typeof GitTabStateSchema>;

export const DEFAULT_GIT_TAB_STATE: GitTabState = {
  worktree: null,
  filter: { tracked: true, untracked: true },
};

/**
 * Shows `repository` (absolute) in the workspace's Git panel, opening the panel when it is closed.
 * The panel selects the repository's own worktree.
 */
export function focusGitRepository(store: LayoutStoreApi, bridge: PaneBridge, repository: string): void {
  if (bridge.target.kind !== "plugin") return;
  const workspaceKey = `${bridge.serverId}:${bridge.workspaceId}`;
  const { pluginId } = bridge.target;
  const tabId = showGitTab(store, workspaceKey, pluginId);
  if (tabId === null) return;
  // A tab opened just now has no state yet
  const tab = findPanelTabs(store, workspaceKey, pluginId, [GIT_PANEL_ID]).find((candidate) => candidate.tabId === tabId);
  const parsed = GitTabStateSchema.safeParse(tab?.state);
  const state: GitTabState = { ...(parsed.success ? parsed.data : DEFAULT_GIT_TAB_STATE), repository, worktree: null };
  store.getState().setTabState(workspaceKey, tabId, state);
}

/** Drops the Git panel's focused repository, so the panel follows the main file tree's root folder again */
export function followTreeRoot(store: LayoutStoreApi, bridge: PaneBridge): void {
  if (bridge.target.kind !== "plugin") return;
  const workspaceKey = `${bridge.serverId}:${bridge.workspaceId}`;
  const tab = findPanelTabs(store, workspaceKey, bridge.target.pluginId, [GIT_PANEL_ID])[0];
  const parsed = GitTabStateSchema.safeParse(tab?.state);
  if (tab && parsed.success && parsed.data.repository) {
    store.getState().setTabState(workspaceKey, tab.tabId, { ...parsed.data, repository: null });
  }
}
