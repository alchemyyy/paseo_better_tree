// NOTE: App-internal, like layout-guard.ts: watches and rewrites the workspace layout store directly
import {
  applyArrangement,
  type ArrangementNode,
  arrangementSignature,
  extractArrangement,
  healStoredSizes,
  keepSavedPlacements,
  type LayoutNode,
  type LayoutPaneNode,
  type PaneRole,
} from "./layout-model.ts";
import { GIT_PANEL_ID, TREE_PANEL_ID, TREE_VIEW_PANEL_IDS } from "./panel-ids.ts";

export interface LayoutPreferences {
  arrangement: ArrangementNode | null;
  explorerWidth: number | null;
}

interface SyncLayout {
  root: unknown;
}

interface SyncState {
  layoutByWorkspace: Record<string, SyncLayout | undefined>;
  splitSizesByWorkspace: Record<string, Record<string, number[]> | undefined>;
  explorerSidebarPaneIdByWorkspace: Record<string, string | null | undefined>;
  sidePaneIdByWorkspace: Record<string, string | null | undefined>;
  explorerSidebarWidthByWorkspace: Record<string, number | undefined>;
  resizeExplorerSidebar(workspaceKey: string, width: number): void;
}

export interface SyncStore {
  getState(): SyncState;
  setState(partial: Partial<SyncState>): void;
  subscribe(listener: () => void): () => void;
}

export interface PreferenceAccess {
  /** Current global layout, or null while settings load */
  read(): LayoutPreferences | null;
  save(patch: Partial<LayoutPreferences>): void;
}

const WIDTH_EPSILON = 0.5;
const UNSET_WIDTH = -1;

function paneRole(explorerPaneId: string | null, sidePaneId: string | null): (pane: LayoutPaneNode) => PaneRole {
  return (pane) => {
    // Explorer is handled by the renderer-aware callers; it never takes a slot
    if (pane.id === explorerPaneId) return null;
    const tabs = pane.tabs ?? [];
    // Only a pane the tab owns alone is placed; Git briefly shares the chat pane before it
    // splits itself out, and moving that pane would carry the chat along
    if (tabs.length === 1 && tabs[0].target.kind === "plugin") {
      const panelId = tabs[0].target.panelId ?? "";
      if (panelId === TREE_PANEL_ID) return "tree";
      if (panelId === GIT_PANEL_ID) return "git";
      // Pinned tree views are transient, so they are not part of the arrangement
      if (TREE_VIEW_PANEL_IDS.includes(panelId)) return null;
    }
    // The remembered side pane is where new files open (better-chat-management's file area)
    if (pane.id === sidePaneId) return "files";
    return "rest";
  };
}

function rolesFor(state: SyncState, workspaceKey: string) {
  const explorerPaneId = state.explorerSidebarPaneIdByWorkspace[workspaceKey] ?? null;
  const sidePaneId = state.sidePaneIdByWorkspace[workspaceKey] ?? null;
  return { explorerPaneId, roleOf: paneRole(explorerPaneId, sidePaneId) };
}

/** Which of the plugin's panes a workspace currently has outside Explorer */
function presentPanes(
  root: LayoutNode,
  roleOf: (pane: LayoutPaneNode) => PaneRole,
  explorerPaneId: string | null,
): string {
  const present = new Set<string>();
  const pending: LayoutNode[] = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.kind === "group") pending.push(...node.group.children);
    else if (node.pane.id !== explorerPaneId) {
      const role = roleOf(node.pane);
      if (role && role !== "rest") present.add(role);
    }
  }
  return [...present].sort().join(",");
}

let groupCounter = 0;
function createGroupId(): string {
  groupCounter++;
  return `group_better_tree_${Date.now().toString(36)}_${groupCounter}`;
}

/**
 * Keeps the file tree and Git panes in the same arrangement and sizes in every workspace, and the
 * Explorer width with them. A workspace seen for the first time, or one whose tree/Git panes just
 * appeared, is rebuilt to the saved arrangement; any other change there is the user's and becomes
 * the new global arrangement, which every other workspace takes on in the same pass.
 */
export function createLayoutSync(store: SyncStore, access: PreferenceAccess) {
  const seen = new Map<string, { panes: string; signature: string }>();
  // Rendered children per group from the last pass, per workspace, for healing stale sizes
  const groupChildren = new Map<string, Map<string, string[]>>();
  const seenWidths = new Map<string, number>();
  let appliedArrangement: string | null = null;
  let appliedWidth: number | null | undefined;
  let syncing = false;
  /** A user's edit was saved this pass, so the next pass carries it to the other workspaces */
  let edited = false;

  function save(patch: Partial<LayoutPreferences>): void {
    access.save(patch);
    edited = true;
  }

  /** Fixes stored sizes Paseo left stale after a split or close, before anything reads them */
  function healSizes(workspaceKey: string): void {
    const state = store.getState();
    const layout = state.layoutByWorkspace[workspaceKey];
    if (!layout) return;
    const explorerPaneId = state.explorerSidebarPaneIdByWorkspace[workspaceKey] ?? null;
    const stored = state.splitSizesByWorkspace[workspaceKey];
    const healed = healStoredSizes(
      layout.root as LayoutNode,
      explorerPaneId,
      stored,
      groupChildren.get(workspaceKey) ?? new Map(),
    );
    groupChildren.set(workspaceKey, healed.children);
    if (Object.keys(healed.updates).length === 0) return;
    store.setState({
      splitSizesByWorkspace: { ...state.splitSizesByWorkspace, [workspaceKey]: { ...stored, ...healed.updates } },
    });
  }

  function readArrangement(workspaceKey: string) {
    const state = store.getState();
    const layout = state.layoutByWorkspace[workspaceKey];
    if (!layout) return null;
    const { explorerPaneId, roleOf } = rolesFor(state, workspaceKey);
    return extractArrangement(layout.root as LayoutNode, roleOf, explorerPaneId, state.splitSizesByWorkspace[workspaceKey]);
  }

  function syncArrangement(state: SyncState, workspaceKey: string, layout: SyncLayout, saved: ArrangementNode | null): void {
    const { explorerPaneId, roleOf } = rolesFor(state, workspaceKey);
    const root = layout.root as LayoutNode;
    const storedSizes = state.splitSizesByWorkspace[workspaceKey];
    const current = extractArrangement(root, roleOf, explorerPaneId, storedSizes);
    const signature = arrangementSignature(current?.arrangement);
    const panes = presentPanes(root, roleOf, explorerPaneId);
    const previous = seen.get(workspaceKey);
    const savedSignature = arrangementSignature(saved);

    // Nothing saved yet: adopt the first arrangement the user sized by hand
    if (!saved) {
      seen.set(workspaceKey, { panes, signature });
      if (current?.userSized) save({ arrangement: current.arrangement });
      return;
    }

    // First sighting, or the tree/Git panes just came or went: follow the global arrangement.
    // A workspace without a Git pane or file area that matches it everywhere else already follows it
    const follows = current !== null && arrangementSignature(keepSavedPlacements(current.arrangement, saved)) === savedSignature;
    if (!previous || previous.panes !== panes) {
      if (!follows) {
        const rebuilt = applyArrangement(root, saved, roleOf, explorerPaneId, storedSizes, createGroupId);
        if (rebuilt) {
          const nextSizes: Record<string, number[]> = { ...storedSizes };
          for (const [groupId, sizes] of Object.entries(rebuilt.sizeUpdates)) {
            if (sizes) nextSizes[groupId] = sizes;
            else delete nextSizes[groupId];
          }
          store.setState({
            layoutByWorkspace: { ...state.layoutByWorkspace, [workspaceKey]: { ...layout, root: rebuilt.root } },
            splitSizesByWorkspace: { ...state.splitSizesByWorkspace, [workspaceKey]: nextSizes },
          });
          seen.set(workspaceKey, { panes, signature: arrangementSignature(readArrangement(workspaceKey)?.arrangement) });
          return;
        }
      }
      seen.set(workspaceKey, { panes, signature });
      return;
    }
    if (signature === previous.signature) return;
    seen.set(workspaceKey, { panes, signature });
    // Only a complete arrangement (tree placed, one block of other content) becomes global. Without
    // a Git pane or file area here, those keep their saved places instead of being dropped
    if (current && !follows) save({ arrangement: keepSavedPlacements(current.arrangement, saved) });
  }

  function syncExplorer(state: SyncState, workspaceKey: string, preferred: number | null): void {
    const width = state.explorerSidebarWidthByWorkspace[workspaceKey] ?? UNSET_WIDTH;
    const previous = seenWidths.get(workspaceKey);
    if (previous === undefined) {
      if (preferred !== null && Math.abs(preferred - width) > WIDTH_EPSILON) {
        seenWidths.set(workspaceKey, preferred);
        state.resizeExplorerSidebar(workspaceKey, preferred);
        return;
      }
      seenWidths.set(workspaceKey, width);
      return;
    }
    if (width === UNSET_WIDTH || Math.abs(previous - width) <= WIDTH_EPSILON) return;
    seenWidths.set(workspaceKey, width);
    save({ explorerWidth: width });
  }

  // A global value that changed (an edit in another workspace, another client) re-applies everywhere
  function forgetOnPreferenceChange(preferences: LayoutPreferences): void {
    const arrangement = arrangementSignature(preferences.arrangement);
    if (appliedArrangement !== null && appliedArrangement !== arrangement) seen.clear();
    appliedArrangement = arrangement;
    if (appliedWidth !== undefined && appliedWidth !== preferences.explorerWidth) seenWidths.clear();
    appliedWidth = preferences.explorerWidth;
  }

  function sync(): void {
    if (syncing) return;
    syncing = true;
    try {
      // An edit saved in the first pass reaches the other workspaces in the second, at once rather
      // than on some later store change. The second pass only rebuilds, so it saves nothing
      for (let pass = 0; pass < 2; pass++) {
        const preferences = access.read();
        // Without loaded preferences a first sighting could not apply them, so wait
        if (!preferences) return;
        edited = false;
        forgetOnPreferenceChange(preferences);
        for (const workspaceKey of Object.keys(store.getState().layoutByWorkspace)) {
          // Each step may rewrite the store, so read it fresh
          healSizes(workspaceKey);
          const state = store.getState();
          const layout = state.layoutByWorkspace[workspaceKey];
          if (!layout) continue;
          syncArrangement(state, workspaceKey, layout, preferences.arrangement);
          syncExplorer(store.getState(), workspaceKey, preferences.explorerWidth);
        }
        if (!edited) return;
      }
    } finally {
      syncing = false;
    }
  }

  return { sync, stop: store.subscribe(sync) };
}
