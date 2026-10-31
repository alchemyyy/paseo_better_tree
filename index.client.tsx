import type { PluginClientContext } from "@getpaseo/plugin/client";
import { startAutoOpen } from "./client/auto-open";
import { DiffPanel } from "./client/diff-panel";
import { GitPanel } from "./client/git-panel";
import { stopGlobalLayout } from "./client/global-layout";
import { stopStockViews } from "./client/stock-views";
import { openGitPanel, setGitPanelOpener } from "./client/panel-openers";
import { interceptChangesPill } from "./client/web";
import { startSourceDiff } from "./client/source-diff";
import { startDiffTabLabels } from "./client/diff-tab-labels";
import { currentPluginId } from "./client/split-panes";
import { diffSourcesRpc } from "./shared/diff-contracts";
import { DIFF_PANEL_IDS, GIT_PANEL_ID, TREE_PANEL_ID, TREE_VIEW_PANEL_IDS } from "./client/panel-ids";
import { PreferencesScreen } from "./client/preferences-screen";
import { createTreePanel } from "./client/tree-panel";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: TREE_PANEL_ID,
    title: "File tree",
    icon: "FolderTree",
    locations: ["workspace", "explorer"],
    Component: createTreePanel({ primary: true }),
  });
  const PinnedTreePanel = createTreePanel({ primary: false });
  for (const panelId of TREE_VIEW_PANEL_IDS) {
    client.addWorkspacePanel({ id: panelId, title: "Pinned folder", icon: "Pin", Component: PinnedTreePanel });
  }
  client.addWorkspacePanel({
    id: GIT_PANEL_ID,
    title: "Git",
    icon: "GitBranch",
    locations: ["workspace"],
    Component: GitPanel,
  });
  for (const panelId of DIFF_PANEL_IDS) {
    client.addWorkspacePanel({ id: panelId, title: "Diff", icon: "FileDiff", Component: DiffPanel });
  }
  client.addSettingsScreen({
    id: "preferences",
    title: "Better tree",
    icon: "FolderTree",
    Component: PreferencesScreen,
  });
  setGitPanelOpener((workspaceId) => client.openPanel(GIT_PANEL_ID, { workspaceId }));
  const stopAutoOpen = startAutoOpen(client);
  // The composer's Changes pill opens (or focuses) the Git panel instead of Explorer's Changes; the
  // stock-views hooks, installed from the first mounted panel, catch every other Changes request
  const stopPillIntercept = interceptChangesPill(openGitPanel);
  // Source / Unified diff / Changes only / Split diff in Paseo's own file editor toolbar
  const stopDiffTabLabels = startDiffTabLabels(currentPluginId);
  const stopSourceDiff = startSourceDiff((path, workspaceId) => client.rpc(diffSourcesRpc, { path, workspaceId }));
  return () => {
    stopStockViews();
    stopSourceDiff();
    stopDiffTabLabels();
    stopPillIntercept();
    setGitPanelOpener(null);
    stopGlobalLayout();
    stopAutoOpen();
  };
}
