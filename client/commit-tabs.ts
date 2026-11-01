import { z } from "zod";
import { chooseSlot } from "./git-model";
import { findPanelTabs, type LayoutStoreApi, openPanelInMainPane } from "./layout-guard";
import { COMMIT_PANEL_IDS } from "./panel-ids";

export const CommitViewModeSchema = z.enum(["unified", "changes", "split", "file"]);
/** How the editor view shows the selected file: diff modes as in Diff tabs, or the file itself */
export type CommitViewMode = z.infer<typeof CommitViewModeSchema>;

export const CommitTabStateSchema = z.object({
  /** A worktree of the commit's repository, where git runs */
  worktree: z.string(),
  sha: z.string(),
  // Label the tab before the commit's details load
  shortSha: z.string(),
  subject: z.string(),
  openedAt: z.number(),
  /** The file shown; the tree's first when absent or not in the commit */
  file: z.string().optional(),
  /** Unified when absent */
  mode: CommitViewModeSchema.optional(),
});
export type CommitTabState = z.infer<typeof CommitTabStateSchema>;

export type CommitSpec = Pick<CommitTabState, "worktree" | "sha" | "shortSha" | "subject">;

/**
 * Shows a commit in the main pane, in its own Commit tab while slots last. A commit already open
 * is revealed where it is, keeping the file and view its tab shows.
 */
export function openCommitTab(store: LayoutStoreApi, workspaceKey: string, pluginId: string, commit: CommitSpec): void {
  const tabs = findPanelTabs(store, workspaceKey, pluginId, COMMIT_PANEL_IDS).map((tab) => {
    const parsed = CommitTabStateSchema.safeParse(tab.state);
    return { panelId: tab.panelId, state: parsed.success ? parsed.data : null };
  });
  // A commit is the same in every worktree and clone, so its id alone tells tabs apart
  const panelId = chooseSlot(
    COMMIT_PANEL_IDS,
    tabs.map(({ panelId, state }) => ({ panelId, key: state?.sha ?? null, openedAt: state?.openedAt ?? 0 })),
    commit.sha,
  );
  const shown = tabs.find((tab) => tab.panelId === panelId && tab.state?.sha === commit.sha)?.state;
  const state: CommitTabState = { ...shown, ...commit, openedAt: Date.now() };
  openPanelInMainPane(store, workspaceKey, pluginId, panelId, state);
}
