import { type RefObject, useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { chooseSlot } from "./git-model";
import { findPaneBridge, type PaneBridge } from "./host-bridge";
import {
  findLayoutStore,
  findPanelTabs,
  type LayoutStoreApi,
  openPanelInNewSplit,
} from "./layout-guard";
import { TREE_PANEL_ID, TREE_VIEW_PANEL_IDS } from "./panel-ids";
import { normalizeAbsolute } from "./tree-model";

export const TreeTabStateSchema = z.object({
  /** Expanded folders, relative to the view's folder */
  expanded: z.array(z.string()),
  /** Absolute folder this view shows; absent or null means the workspace directory */
  viewRoot: z.string().nullable().optional(),
  /** When a pinned view was last pointed at its folder; picks which pooled view to reuse */
  openedAt: z.number().optional(),
  /** Filter text; kept here because Paseo re-creates the panel whenever panes are added or removed */
  filter: z.string().optional(),
});
export type TreeTabState = z.infer<typeof TreeTabStateSchema>;

/** Folders (normalized absolute) that currently have an open pinned tree view in this workspace */
export function usePinnedFolders(rootRef: RefObject<unknown>): ReadonlySet<string> {
  // A joined string keeps re-renders to actual changes, not every layout store update
  const [joined, setJoined] = useState("");
  useEffect(() => {
    const bridge = findPaneBridge(rootRef.current);
    const store = findLayoutStore(rootRef.current);
    if (!bridge || !store || bridge.target.kind !== "plugin") return;
    const workspaceKey = `${bridge.serverId}:${bridge.workspaceId}`;
    const { pluginId } = bridge.target;
    const update = () => {
      const roots: string[] = [];
      for (const tab of findPanelTabs(store, workspaceKey, pluginId, TREE_VIEW_PANEL_IDS)) {
        const parsed = TreeTabStateSchema.safeParse(tab.state);
        if (parsed.success && parsed.data.viewRoot) roots.push(normalizeAbsolute(parsed.data.viewRoot));
      }
      setJoined(roots.sort().join("\n"));
    };
    update();
    return store.subscribe(update);
  }, [rootRef]);
  return useMemo(() => new Set(joined ? joined.split("\n") : []), [joined]);
}

/**
 * The folder the workspace's main file tree shows, null for the workspace directory; undefined
 * until the layout has been read
 */
export function useMainTreeRoot(rootRef: RefObject<unknown>): string | null | undefined {
  const [viewRoot, setViewRoot] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const bridge = findPaneBridge(rootRef.current);
    const store = findLayoutStore(rootRef.current);
    if (!bridge || !store || bridge.target.kind !== "plugin") {
      setViewRoot(null);
      return;
    }
    const workspaceKey = `${bridge.serverId}:${bridge.workspaceId}`;
    const { pluginId } = bridge.target;
    const update = () => {
      const tab = findPanelTabs(store, workspaceKey, pluginId, [TREE_PANEL_ID])[0];
      const parsed = TreeTabStateSchema.safeParse(tab?.state);
      setViewRoot(parsed.success ? (parsed.data.viewRoot ?? null) : null);
    };
    update();
    return store.subscribe(update);
  }, [rootRef]);
  return viewRoot;
}

/** Closes every pinned tree view showing `folder`; their panes go with them */
export function closeTreeViews(store: LayoutStoreApi, bridge: PaneBridge, folder: string): void {
  if (bridge.target.kind !== "plugin") return;
  const workspaceKey = `${bridge.serverId}:${bridge.workspaceId}`;
  const key = normalizeAbsolute(folder);
  for (const tab of findPanelTabs(store, workspaceKey, bridge.target.pluginId, TREE_VIEW_PANEL_IDS)) {
    const parsed = TreeTabStateSchema.safeParse(tab.state);
    if (parsed.success && parsed.data.viewRoot && normalizeAbsolute(parsed.data.viewRoot) === key) {
      store.getState().closeTab(workspaceKey, tab.tabId);
    }
  }
}

/** Opens `folder` in its own tree view pane, split off the pane of the tree that pinned it */
export function openTreeView(store: LayoutStoreApi, bridge: PaneBridge, folder: string): void {
  if (bridge.target.kind !== "plugin") return;
  const workspaceKey = `${bridge.serverId}:${bridge.workspaceId}`;
  const { pluginId } = bridge.target;
  const views = findPanelTabs(store, workspaceKey, pluginId, TREE_VIEW_PANEL_IDS).map((tab) => {
    const parsed = TreeTabStateSchema.safeParse(tab.state);
    return {
      panelId: tab.panelId,
      state: parsed.success ? parsed.data : null,
      key: parsed.success && parsed.data.viewRoot ? normalizeAbsolute(parsed.data.viewRoot) : null,
      openedAt: parsed.success ? (parsed.data.openedAt ?? 0) : 0,
    };
  });
  const key = normalizeAbsolute(folder);
  const panelId = chooseSlot(TREE_VIEW_PANEL_IDS, views, key);
  const showing = views.find((view) => view.panelId === panelId && view.key === key);
  // A view already on this folder keeps its expanded folders
  const state: TreeTabState = {
    expanded: showing?.state?.expanded ?? [],
    viewRoot: folder,
    openedAt: Date.now(),
  };
  openPanelInNewSplit(store, workspaceKey, pluginId, panelId, state, bridge.tabId);
}
