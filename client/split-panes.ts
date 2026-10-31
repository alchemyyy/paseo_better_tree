import { chooseSlot } from "./git-model";
import { findPaneBridge } from "./host-bridge";
import { findLayoutStore, findPanelTabs, openPanelInNewSplit } from "./layout-guard";
import { DIFF_PANEL_IDS } from "./panel-ids";

// The client entry has no plugin id; our own panels learn it from their tab and record it here
const DEFAULT_PLUGIN_ID = "better-tree";
let knownPluginId: string | null = null;

export function rememberPluginId(pluginId: string): void {
  knownPluginId = pluginId;
}

export function currentPluginId(): string {
  return knownPluginId ?? DEFAULT_PLUGIN_ID;
}

/** Tab state of the pane showing a split diff's original (HEAD) side */
export interface OriginalSideState {
  side: "original";
  /** Absolute file path */
  path: string;
  pairKey: string;
  openedAt: number;
}

function isOriginalSide(state: unknown): state is OriginalSideState {
  if (!state || typeof state !== "object") return false;
  const record = state as Record<string, unknown>;
  return record.side === "original" && typeof record.pairKey === "string" && typeof record.path === "string";
}

/** Opens the original side of a split diff in a new pane right of the pane holding `anchor` */
export function openOriginalSide(anchor: unknown, pairKey: string, absolutePath: string): void {
  const bridge = findPaneBridge(anchor);
  const store = findLayoutStore(anchor);
  if (!bridge || !store) return;
  const workspaceKey = `${bridge.serverId}:${bridge.workspaceId}`;
  const pluginId = currentPluginId();
  const tabs = findPanelTabs(store, workspaceKey, pluginId, DIFF_PANEL_IDS).map((tab) => ({
    panelId: tab.panelId,
    key: isOriginalSide(tab.state) ? `original\n${tab.state.pairKey}` : null,
    openedAt: isOriginalSide(tab.state) ? tab.state.openedAt : 0,
  }));
  const panelId = chooseSlot(DIFF_PANEL_IDS, tabs, `original\n${pairKey}`);
  const state: OriginalSideState = { side: "original", path: absolutePath, pairKey, openedAt: Date.now() };
  openPanelInNewSplit(store, workspaceKey, pluginId, panelId, state, bridge.tabId, "right");
}

/** Closes the pane showing a split diff's original side */
export function closeOriginalSide(anchor: unknown, pairKey: string): void {
  const bridge = findPaneBridge(anchor);
  const store = findLayoutStore(anchor);
  if (!bridge || !store) return;
  const workspaceKey = `${bridge.serverId}:${bridge.workspaceId}`;
  for (const tab of findPanelTabs(store, workspaceKey, currentPluginId(), DIFF_PANEL_IDS)) {
    if (isOriginalSide(tab.state) && tab.state.pairKey === pairKey) store.getState().closeTab(workspaceKey, tab.tabId);
  }
}
