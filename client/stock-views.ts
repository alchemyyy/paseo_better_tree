// NOTE: App-internal, like layout-guard.ts. Paseo's stock file tree and Changes view are Explorer
// tabs ({ kind: "files" } and { kind: "changes_tree" }). Every way Paseo opens them (folder links in
// chats and terminals, keyboard shortcuts, the command palette, the new-tab menu) ends in the
// layout store's openTab, after packages/app's openExplorerSidebarView revealed Explorer. This
// plugin's tree and Git panel stand in for them, so those opens are rerouted; and since Explorer
// opens on Changes by default, its Changes tab is closed whenever the dock is on screen. A folder
// link first asks the stock tree to expand to the folder through the panel store's
// setExpandedPathsForWorkspace, keyed "workspace:<workspace id>".
import { type RefObject, useEffect } from "react";
import type { PaneBridge } from "./host-bridge";
import {
  closeVisibleStockChanges,
  findLayoutStore,
  findStoreAbove,
  hideStockOnlyExplorer,
  isExplorerPane,
  isPanelStoreApi,
  type LayoutStoreApi,
  type OpenTab,
  type OpenTabInput,
  type PanelStoreApi,
  showGitTab,
  showTreeTab,
} from "./layout-guard";
import { wrapStoreAction } from "./layout-wrap";
import { currentPluginId } from "./split-panes";

const WRAP_OWNER = "better-tree";
const EXPLORER_KEY_PREFIX = "workspace:";
/** A folder link's expansion arrives once its folders are listed, which can take a while */
const REVEAL_WINDOW_MS = 15_000;

type SetExpandedPaths = (explorerKey: string, paths: unknown) => void;

let layoutStore: LayoutStoreApi | null = null;
let panelStore: PanelStoreApi | null = null;
let removeLayoutHooks: (() => void) | null = null;
let removeSetExpanded: (() => void) | null = null;
/** Workspace keys whose stock tree open was rerouted, with when, awaiting the folder to reveal */
const awaitingFolder = new Map<string, number>();
/** An entry the workspace's main tree should show */
export interface TreeReveal {
  /** Workspace-relative or absolute */
  path: string;
  kind: "file" | "directory";
  /** Gives the tree the keyboard, for a command aimed at the tree rather than a link */
  focus: boolean;
}

/** What each workspace's main tree should show next */
const pendingReveals = new Map<string, TreeReveal>();
const revealListeners = new Set<() => void>();

/**
 * Sends stock file tree and Changes opens to this plugin's tree and Git panel; installs once per
 * store, from any mounted panel
 */
export function useStockViews(rootRef: RefObject<unknown>): void {
  useEffect(() => {
    const node = rootRef.current;
    installStockViews(findLayoutStore(node), panelStore ? null : findStoreAbove(node, isPanelStoreApi));
  }, [rootRef]);
}

/** Hooks the stores not hooked yet; either may be null when not found */
export function installStockViews(layout: LayoutStoreApi | null, panel: PanelStoreApi | null): void {
  if (layout && layout !== layoutStore) installLayoutHooks(layout);
  if (panel && panel !== panelStore) installSetExpanded(panel);
}

export function stopStockViews(): void {
  removeLayoutHooks?.();
  removeSetExpanded?.();
  removeLayoutHooks = removeSetExpanded = null;
  layoutStore = panelStore = null;
  awaitingFolder.clear();
  pendingReveals.clear();
}

/** What this workspace's tree should show next, removed once taken */
export function takeTreeReveal(workspaceKey: string): TreeReveal | null {
  const reveal = pendingReveals.get(workspaceKey) ?? null;
  pendingReveals.delete(workspaceKey);
  return reveal;
}

/**
 * Selects `path` (absolute) in the workspace's main file tree and gives the tree the keyboard,
 * bringing the tree into view and opening it when it is closed
 */
export function revealInTree(store: LayoutStoreApi, bridge: PaneBridge, path: string, kind: TreeReveal["kind"]): void {
  if (bridge.target.kind !== "plugin") return;
  const workspaceKey = `${bridge.serverId}:${bridge.workspaceId}`;
  if (showTreeTab(store, workspaceKey, bridge.target.pluginId) === null) return;
  // A tree opened just now takes the request once it mounts
  pendingReveals.set(workspaceKey, { path, kind, focus: true });
  for (const listener of revealListeners) listener();
}

export function subscribeTreeReveals(listener: () => void): () => void {
  revealListeners.add(listener);
  return () => revealListeners.delete(listener);
}

function installLayoutHooks(store: LayoutStoreApi): void {
  removeLayoutHooks?.();
  layoutStore = store;
  const removeOpenTab = wrapStoreAction<OpenTab>(store, "openTab", WRAP_OWNER, (next) => (input) => {
    switch (input?.target?.kind) {
      case "files":
        return openTreeInstead(store, input) ?? next(input);
      case "changes_tree":
        return openGitInstead(store, input) ?? next(input);
      default:
        return next(input);
    }
  });
  // Closing a tab notifies subscribers again, so a nested pass returns at once
  let closing = false;
  const closeChanges = () => {
    if (closing) return;
    closing = true;
    try {
      closeVisibleStockChanges(store);
    } catch (error) {
      console.warn("[better-tree] Could not close Paseo's Changes view", error);
    } finally {
      closing = false;
    }
  };
  closeChanges();
  const unsubscribe = store.subscribe(closeChanges);
  removeLayoutHooks = () => {
    removeOpenTab();
    unsubscribe();
  };
}

/**
 * A request aimed at Explorer revealed the dock for a stock view. The plugin's panel stands in
 * for that view, so the dock hides again when only Paseo's own views remain there
 */
function settleExplorer(store: LayoutStoreApi, input: OpenTabInput): void {
  const paneId = input.placement?.paneId;
  if (paneId && isExplorerPane(store, input.workspaceKey, paneId)) hideStockOnlyExplorer(store, input.workspaceKey);
}

/** Shows the tree for a stock tree request; null leaves the request to Paseo */
function openTreeInstead(store: LayoutStoreApi, input: OpenTabInput): string | null {
  try {
    const tabId = showTreeTab(store, input.workspaceKey, currentPluginId());
    if (tabId === null) return null;
    awaitingFolder.set(input.workspaceKey, Date.now());
    settleExplorer(store, input);
    return tabId;
  } catch (error) {
    console.warn("[better-tree] Could not show the file tree instead of Paseo's", error);
    return null;
  }
}

/** Shows the Git panel for a Changes request; null leaves the request to Paseo, as on phones */
function openGitInstead(store: LayoutStoreApi, input: OpenTabInput): string | null {
  if (store.getState().layoutMode === "compact") return null;
  try {
    const tabId = showGitTab(store, input.workspaceKey, currentPluginId());
    if (tabId === null) return null;
    settleExplorer(store, input);
    return tabId;
  } catch (error) {
    console.warn("[better-tree] Could not show the Git panel instead of Paseo's Changes", error);
    return null;
  }
}

function installSetExpanded(store: PanelStoreApi): void {
  removeSetExpanded?.();
  panelStore = store;
  removeSetExpanded = wrapStoreAction<SetExpandedPaths>(
    store,
    "setExpandedPathsForWorkspace",
    WRAP_OWNER,
    (next) => (explorerKey, paths) => {
      next(explorerKey, paths);
      try {
        noteExpansion(explorerKey, paths);
      } catch (error) {
        console.warn("[better-tree] Could not read the folder to reveal", error);
      }
    },
  );
}

/** Turns the stock tree's expansion after a rerouted open into a reveal request for our tree */
function noteExpansion(explorerKey: string, paths: unknown): void {
  const now = Date.now();
  if (!explorerKey.startsWith(EXPLORER_KEY_PREFIX)) return;
  const workspaceId = explorerKey.slice(EXPLORER_KEY_PREFIX.length);
  for (const [workspaceKey, openedAt] of awaitingFolder) {
    if (!workspaceKey.endsWith(`:${workspaceId}`)) continue;
    awaitingFolder.delete(workspaceKey);
    if (now - openedAt > REVEAL_WINDOW_MS) continue;
    // The reveal adds the folder's ancestors, then the folder, to whatever was expanded
    const requested = typeof paths === "function" ? (paths as (current: string[]) => unknown)([]) : paths;
    const folder = Array.isArray(requested) ? requested[requested.length - 1] : undefined;
    if (typeof folder !== "string" || folder === "" || folder === ".") continue;
    pendingReveals.set(workspaceKey, { path: folder, kind: "directory", focus: false });
    for (const listener of revealListeners) listener();
  }
}
