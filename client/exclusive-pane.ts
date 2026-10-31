import { type RefObject, useEffect } from "react";
import { findPaneBridge } from "./host-bridge";
import { findLayoutStore, guardExclusivePane, splitIntoOwnPane } from "./layout-guard";
import { rememberPluginId } from "./split-panes";

/**
 * While this panel sits in a workspace pane, it owns that pane. With `anchor`, a panel that
 * opened into a shared pane first splits itself out beside the anchor panel's pane.
 */
export function useExclusivePane(
  rootRef: RefObject<unknown>,
  anchor?: { panelId: string; position: "left" | "right" | "top" | "bottom" },
): void {
  const anchorPanelId = anchor?.panelId;
  const anchorPosition = anchor?.position;
  useEffect(() => {
    const bridge = findPaneBridge(rootRef.current);
    if (!bridge || bridge.host !== "main" || bridge.target.kind !== "plugin") return;
    const store = findLayoutStore(rootRef.current);
    if (!store) return;
    const workspaceKey = `${bridge.serverId}:${bridge.workspaceId}`;
    const { pluginId } = bridge.target;
    rememberPluginId(pluginId);
    if (anchorPanelId && anchorPosition) {
      splitIntoOwnPane(store, workspaceKey, bridge.tabId, pluginId, {
        panelId: anchorPanelId,
        position: anchorPosition,
      });
    }
    return guardExclusivePane(store, workspaceKey, bridge.tabId, pluginId);
  }, [rootRef, anchorPanelId, anchorPosition]);
}
