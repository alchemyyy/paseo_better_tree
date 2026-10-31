import { z } from "zod";
import { chooseDiffSlot, type DiffSpec } from "./git-model";
import { findPanelTabs, type LayoutStoreApi, openPanelInMainPane } from "./layout-guard";
import { DIFF_PANEL_IDS } from "./panel-ids";

export const DiffTabStateSchema = z.object({
  worktree: z.string(),
  path: z.string(),
  openedAt: z.number(),
  /** The tab's chosen view; unified when absent */
  mode: z.enum(["unified", "changes", "split"]).optional(),
  /** The change when the tab opened; colors its label until live status is known */
  category: z.enum(["tracked", "untracked", "staged"]).optional(),
});
export type DiffTabState = z.infer<typeof DiffTabStateSchema>;

/** Shows one file's diff in the main pane, in its own Diff tab while slots last */
export function openDiffTab(
  store: LayoutStoreApi,
  workspaceKey: string,
  pluginId: string,
  spec: DiffSpec,
  category?: DiffTabState["category"],
): void {
  const tabs = findPanelTabs(store, workspaceKey, pluginId, DIFF_PANEL_IDS).map((tab) => {
    const parsed = DiffTabStateSchema.safeParse(tab.state);
    return { panelId: tab.panelId, spec: parsed.success ? parsed.data : null };
  });
  const panelId = chooseDiffSlot(DIFF_PANEL_IDS, tabs, spec);
  const state: DiffTabState = { ...spec, category, openedAt: Date.now() };
  openPanelInMainPane(store, workspaceKey, pluginId, panelId, state);
}
