// NOTE: App-internal, like host-bridge.ts. The SDK cannot restrict what opens in a pane, so this
// reads the workspace layout zustand store (packages/app/src/stores/workspace-layout-store.ts).
// zustand 5 `useStore` keeps `useCallback(..., [api, selector])`, so any ancestor component that
// subscribes to the store holds the store API in its hook deps.

// NOTE: Explicit extension so `node --test` can load this module directly
import { COMMIT_PANEL_IDS, DIFF_PANEL_IDS, EXCLUSIVE_PANEL_IDS, GIT_PANEL_ID, TREE_PANEL_ID } from "./panel-ids.ts";
import { chainSome } from "./layout-wrap.ts";

/** This plugin's panels that open where files open: diff and commit tabs */
const FILE_VIEW_PANEL_IDS: ReadonlySet<string> = new Set([...DIFF_PANEL_IDS, ...COMMIT_PANEL_IDS]);
const TREE_PANEL_ID_SET: ReadonlySet<string> = new Set([TREE_PANEL_ID]);
// Paseo's built-in Explorer views (Files, Changes, pull request); the tree and Git panel stand in
// for the first two
const STOCK_EXPLORER_KINDS: Record<string, true> = { files: true, changes_tree: true, pull_request: true };
// Paseo's default Explorer pane (EXPLORER_SIDEBAR_PANE_ID), used when none is registered
const DEFAULT_EXPLORER_PANE_ID = "explorer";

interface LayoutTab {
  tabId: string;
  target: { kind: string; pluginId?: string; panelId?: string; context?: string; path?: string };
  createdAt?: number;
  state?: unknown;
}
interface SplitPane {
  id: string;
  tabIds: string[];
  focusedTabId: string | null;
  hidden?: boolean;
  /** Present on the store's internal layout nodes */
  tabs?: LayoutTab[];
}
type SplitNode =
  | { kind: "pane"; pane: SplitPane }
  | { kind: "group"; group: { children: SplitNode[] } };

type SplitPosition = "left" | "right" | "top" | "bottom";

/** Paseo's openTab input, as far as this plugin reads and writes it */
export interface OpenTabInput {
  workspaceKey: string;
  target: LayoutTab["target"];
  intent: "reveal";
  /** Ours always name a pane; Paseo's also prefer one or follow focus */
  placement?: { mode: string; paneId?: string };
  state?: unknown;
}

export type OpenTab = (input: OpenTabInput) => string | null;

interface LayoutState {
  /** "compact" on phones, where Explorer is an overlay instead of a dock */
  layoutMode?: string;
  layoutByWorkspace: Record<string, { root: SplitNode } | undefined>;
  explorerSidebarPaneIdByWorkspace: Record<string, string | null | undefined>;
  sidePaneIdByWorkspace: Record<string, string | null | undefined>;
  moveTabToPane(workspaceKey: string, tabId: string, toPaneId: string): void;
  focusTab(workspaceKey: string, tabId: string): void;
  splitPane(
    workspaceKey: string,
    input: { tabId: string; targetPaneId: string; position: SplitPosition },
  ): string | null;
  openTab: OpenTab;
  setTabState(workspaceKey: string, tabId: string, state: unknown): void;
  /** Closing a pane's only tab also removes the pane unless it is the last visible one */
  closeTab(workspaceKey: string, tabId: string): void;
  /** The remembered side pane, created as a full-height right split when there is none */
  ensureSidePane(workspaceKey: string): string | null;
  /** Creates the Explorer dock pane if needed and unhides it; returns its pane id */
  showExplorerSidebar(workspaceKey: string): string | null;
  hideExplorerSidebar(workspaceKey: string): void;
}

// better-chat-management marks the layout store actions it wraps; its openTab wrapper sends every
// new file tab to the side pane, its "file area" (paseo_better_chat_management/client/controller.ts).
// The mark keeps that plugin's former id, which it still writes
const CHAT_MANAGEMENT_WRAPPED_MARK = "__betterChatDisplayWrapped";
// COMPAT(legacyWrappers): its wrappers from before the shared link protocol (layout-wrap.ts)
const CHAT_MANAGEMENT_LEGACY_ORIGINAL = "__betterChatDisplayOriginal";

/** Whether the better-chat-management plugin is running and routing file tabs to its file area */
export function isChatManagementActive(store: LayoutStoreApi): boolean {
  return chainSome(
    store.getState().openTab,
    (fn) => CHAT_MANAGEMENT_WRAPPED_MARK in fn,
    (fn) => (CHAT_MANAGEMENT_LEGACY_ORIGINAL in fn ? (fn[CHAT_MANAGEMENT_LEGACY_ORIGINAL] as never) : undefined),
  );
}

export interface LayoutStoreApi {
  getState(): LayoutState;
  setState(partial: Partial<LayoutState>): void;
  subscribe(listener: () => void): () => void;
}

interface FiberLike {
  return: FiberLike | null;
  memoizedState?: unknown;
}

interface HookLike {
  memoizedState?: unknown;
  next?: HookLike | null;
}

const FIBER_KEY_PREFIX = "__reactFiber$";
const MAX_FIBER_DEPTH = 400;
const MAX_HOOKS_PER_FIBER = 200;

let cachedStore: LayoutStoreApi | null = null;

function getFiber(node: unknown): FiberLike | null {
  if (!node || typeof node !== "object") return null;
  const record = node as Record<string, unknown>;
  if (record.__internalInstanceHandle) return record.__internalInstanceHandle as FiberLike;
  for (const key of Object.keys(record)) {
    if (key.startsWith(FIBER_KEY_PREFIX)) return record[key] as FiberLike;
  }
  return null;
}

interface StoreApiLike {
  getState(): unknown;
  setState(partial: object): void;
  subscribe(listener: () => void): () => void;
}

function isStoreApi(value: unknown): value is StoreApiLike {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.getState === "function" &&
    typeof candidate.setState === "function" &&
    typeof candidate.subscribe === "function"
  );
}

function isLayoutStoreApi(value: unknown): value is LayoutStoreApi {
  if (!isStoreApi(value)) return false;
  const state = value.getState();
  if (!state || typeof state !== "object") return false;
  const record = state as Record<string, unknown>;
  return (
    typeof record.layoutByWorkspace === "object" &&
    typeof record.sidePaneIdByWorkspace === "object" &&
    typeof record.moveTabToPane === "function" &&
    typeof record.focusTab === "function"
  );
}

function findStoreInHooks<Store>(firstHook: unknown, isStore: (value: unknown) => value is Store): Store | null {
  let hook = firstHook as HookLike | null;
  for (let index = 0; hook && typeof hook === "object" && index < MAX_HOOKS_PER_FIBER; index++) {
    const memoized = hook.memoizedState;
    // useCallback/useMemo store [value, deps]
    if (Array.isArray(memoized) && memoized.length === 2 && Array.isArray(memoized[1])) {
      for (const dependency of memoized[1] as unknown[]) {
        if (isStore(dependency)) return dependency;
      }
    }
    hook = hook.next ?? null;
  }
  return null;
}

/** The first zustand store `isStore` accepts that a component above a host node subscribes to */
export function findStoreAbove<Store>(node: unknown, isStore: (value: unknown) => value is Store): Store | null {
  let fiber = getFiber(node);
  for (let depth = 0; fiber && depth < MAX_FIBER_DEPTH; depth++) {
    const store = findStoreInHooks(fiber.memoizedState, isStore);
    if (store) return store;
    fiber = fiber.return;
  }
  return null;
}

/** The workspace layout store found above a host node, or null */
export function findLayoutStore(node: unknown): LayoutStoreApi | null {
  cachedStore ??= findStoreAbove(node, isLayoutStoreApi);
  return cachedStore;
}

/** Paseo's panel store (packages/app/src/stores/panel-store.ts): Explorer file tree expansion */
export interface PanelStoreApi {
  getState(): { setExpandedPathsForWorkspace(explorerKey: string, paths: unknown): void };
  setState(partial: object): void;
}

export function isPanelStoreApi(value: unknown): value is PanelStoreApi {
  if (!isStoreApi(value)) return false;
  const state = value.getState();
  return (
    typeof state === "object" &&
    state !== null &&
    "setExpandedPathsForWorkspace" in state &&
    typeof state.setExpandedPathsForWorkspace === "function" &&
    "expandedPathsByWorkspace" in state
  );
}

function collectPanes(root: SplitNode): SplitPane[] {
  const panes: SplitPane[] = [];
  const pending: SplitNode[] = [root];
  while (pending.length > 0) {
    const node = pending.shift()!;
    if (node.kind === "pane") panes.push(node.pane);
    else pending.push(...node.group.children);
  }
  return panes;
}

function isPluginPanelTab(tab: LayoutTab, pluginId: string, panelIds: ReadonlySet<string>): boolean {
  return (
    tab.target.kind === "plugin" &&
    tab.target.pluginId === pluginId &&
    panelIds.has(tab.target.panelId ?? "")
  );
}

interface WorkspacePanes {
  state: LayoutState;
  panes: SplitPane[];
  explorerPaneId: string | null;
}

function readPanes(store: LayoutStoreApi, workspaceKey: string): WorkspacePanes | null {
  const state = store.getState();
  const layout = state.layoutByWorkspace[workspaceKey];
  if (!layout) return null;
  const panes = collectPanes(layout.root);
  // Like Paseo's resolveExplorerSidebarPaneId: the registered pane, else the default one
  const registered = state.explorerSidebarPaneIdByWorkspace[workspaceKey];
  const explorerPaneId =
    [registered, DEFAULT_EXPLORER_PANE_ID].find((id) => id && panes.some((pane) => pane.id === id)) ?? null;
  return { state, panes, explorerPaneId };
}

/** The Explorer dock's pane while it is on screen */
function visibleExplorer(workspace: WorkspacePanes): SplitPane | null {
  const explorer = workspace.panes.find((pane) => pane.id === workspace.explorerPaneId);
  return explorer && !explorer.hidden ? explorer : null;
}

export function isExplorerPane(store: LayoutStoreApi, workspaceKey: string, paneId: string): boolean {
  return readPanes(store, workspaceKey)?.explorerPaneId === paneId;
}

/** Hides the workspace's Explorer dock when all it holds is Paseo's own Files, Changes, and PR views */
export function hideStockOnlyExplorer(store: LayoutStoreApi, workspaceKey: string): void {
  const workspace = readPanes(store, workspaceKey);
  const explorer = workspace && visibleExplorer(workspace);
  if (explorer && (explorer.tabs ?? []).every((tab) => STOCK_EXPLORER_KINDS[tab.target.kind] === true)) {
    store.getState().hideExplorerSidebar(workspaceKey);
  }
}

/**
 * Closes Paseo's Changes tab in every Explorer dock on screen, so the dock shows another view.
 * Phones keep it: there Explorer is an overlay, and this plugin opens no Git pane
 */
export function closeVisibleStockChanges(store: LayoutStoreApi): void {
  if (store.getState().layoutMode === "compact") return;
  for (const workspaceKey of Object.keys(store.getState().layoutByWorkspace)) {
    const workspace = readPanes(store, workspaceKey);
    const changes = workspace && visibleExplorer(workspace)?.tabs?.find((tab) => tab.target.kind === "changes_tree");
    if (changes) store.getState().closeTab(workspaceKey, changes.tabId);
  }
}

/** First visible ordinary pane holding none of this plugin's exclusive panels */
function findMainPane(workspace: WorkspacePanes, pluginId: string, excludePaneId?: string): SplitPane | null {
  return (
    workspace.panes.find(
      (pane) =>
        pane.id !== excludePaneId &&
        pane.id !== workspace.explorerPaneId &&
        !pane.hidden &&
        !(pane.tabs ?? []).some((tab) => isPluginPanelTab(tab, pluginId, EXCLUSIVE_PANEL_IDS)),
    ) ?? null
  );
}

/**
 * Keeps the pane holding `ownerTabId` exclusive: it is never the remembered side pane, and any
 * other tab that lands in it moves to the main pane. Does nothing while the owner is in Explorer.
 * Returns the unsubscribe function.
 */
export function guardExclusivePane(
  store: LayoutStoreApi,
  workspaceKey: string,
  ownerTabId: string,
  pluginId: string,
): () => void {
  let enforcing = false;
  const enforce = () => {
    if (enforcing) return;
    enforcing = true;
    try {
      const workspace = readPanes(store, workspaceKey);
      if (!workspace) return;
      const { state, panes, explorerPaneId } = workspace;
      const ownerPane = panes.find((pane) => pane.tabIds.includes(ownerTabId));
      if (!ownerPane || ownerPane.id === explorerPaneId) return;
      if (state.sidePaneIdByWorkspace[workspaceKey] === ownerPane.id) {
        // A later side open then creates its own pane instead of reusing this one
        store.setState({
          sidePaneIdByWorkspace: { ...state.sidePaneIdByWorkspace, [workspaceKey]: null },
        });
      }
      const strays = ownerPane.tabIds.filter((tabId) => tabId !== ownerTabId);
      if (strays.length === 0) return;
      const mainPane = findMainPane(workspace, pluginId, ownerPane.id);
      const strayTabs = new Map((ownerPane.tabs ?? []).map((tab) => [tab.tabId, tab]));
      // With better-chat-management, file views follow its rule and go to its file area. Paseo
      // creates that pane on demand, so only a stray file view may call it up: another stray,
      // such as the Git panel opened into the tree's pane, would leave it standing empty
      const strayFileView = strays.some((tabId) => {
        const tab = strayTabs.get(tabId);
        return tab !== undefined && isFileView(tab, pluginId);
      });
      const fileArea =
        strayFileView && isChatManagementActive(store) ? fileAreaPane(store, workspaceKey, pluginId) : null;
      const focused =
        ownerPane.focusedTabId && ownerPane.focusedTabId !== ownerTabId
          ? ownerPane.focusedTabId
          : strays[strays.length - 1];
      let moved = false;
      for (const tabId of strays) {
        const tab = strayTabs.get(tabId);
        const destination = fileArea && tab && isFileView(tab, pluginId) ? fileArea : mainPane?.id;
        if (!destination) continue;
        state.moveTabToPane(workspaceKey, tabId, destination);
        moved = true;
      }
      if (moved) store.getState().focusTab(workspaceKey, focused);
    } finally {
      enforcing = false;
    }
  };
  enforce();
  return store.subscribe(enforce);
}

/**
 * Moves `ownerTabId` into its own split when it shares a pane: beside the pane holding
 * `anchorPanelId` when that exists, else beside its current pane. Returns true when it moved.
 */
export function splitIntoOwnPane(
  store: LayoutStoreApi,
  workspaceKey: string,
  ownerTabId: string,
  pluginId: string,
  anchor: { panelId: string; position: SplitPosition },
): boolean {
  const workspace = readPanes(store, workspaceKey);
  if (!workspace) return false;
  const ownerPane = workspace.panes.find((pane) => pane.tabIds.includes(ownerTabId));
  if (!ownerPane || ownerPane.id === workspace.explorerPaneId || ownerPane.tabIds.length <= 1) {
    return false;
  }
  const anchorPane = workspace.panes.find(
    (pane) =>
      pane.id !== ownerPane.id &&
      pane.id !== workspace.explorerPaneId &&
      (pane.tabs ?? []).some((tab) => isPluginPanelTab(tab, pluginId, new Set([anchor.panelId]))),
  );
  const target = anchorPane
    ? { targetPaneId: anchorPane.id, position: anchor.position }
    : { targetPaneId: ownerPane.id, position: "right" as const };
  return workspace.state.splitPane(workspaceKey, { tabId: ownerTabId, ...target }) !== null;
}

/**
 * Where a tab of `panelId` from any plugin currently lives in a workspace, or null when absent.
 * Matching any plugin lets the header button check before a panel has learned its plugin id.
 */
export function findPanelHost(
  store: LayoutStoreApi,
  workspaceKey: string,
  panelId: string,
): "explorer" | "main" | null {
  const workspace = readPanes(store, workspaceKey);
  if (!workspace) return null;
  for (const pane of workspace.panes) {
    const holds = (pane.tabs ?? []).some(
      (tab) => tab.target.kind === "plugin" && tab.target.panelId === panelId,
    );
    if (holds) return pane.id === workspace.explorerPaneId ? "explorer" : "main";
  }
  return null;
}

export interface SlotTab {
  panelId: string;
  tabId: string;
  state: unknown;
}

/** This plugin's tabs for the given panel ids in one workspace */
export function findPanelTabs(
  store: LayoutStoreApi,
  workspaceKey: string,
  pluginId: string,
  panelIds: readonly string[],
): SlotTab[] {
  const workspace = readPanes(store, workspaceKey);
  if (!workspace) return [];
  const wanted = new Set(panelIds);
  const tabs: SlotTab[] = [];
  for (const pane of workspace.panes) {
    for (const tab of pane.tabs ?? []) {
      if (isPluginPanelTab(tab, pluginId, wanted)) {
        tabs.push({ panelId: tab.target.panelId ?? "", tabId: tab.tabId, state: tab.state });
      }
    }
  }
  return tabs;
}

/**
 * Opens a plugin workspace panel in a new split beside the pane holding `anchorTabId`: below it
 * in a workspace pane, or right of the main pane when the anchor is in Explorer (which cannot split).
 * An already open tab of that panel is retargeted with `tabState` and revealed where it is.
 */
export function openPanelInNewSplit(
  store: LayoutStoreApi,
  workspaceKey: string,
  pluginId: string,
  panelId: string,
  tabState: unknown,
  anchorTabId: string,
  position: SplitPosition = "bottom",
): void {
  const existing = findPanelTabs(store, workspaceKey, pluginId, [panelId])[0];
  if (existing) {
    store.getState().setTabState(workspaceKey, existing.tabId, tabState);
    store.getState().focusTab(workspaceKey, existing.tabId);
    return;
  }
  const workspace = readPanes(store, workspaceKey);
  if (!workspace) return;
  const anchorPane = workspace.panes.find((pane) => pane.tabIds.includes(anchorTabId));
  const anchorInWorkspace = anchorPane && anchorPane.id !== workspace.explorerPaneId ? anchorPane : null;
  const mainPane = findMainPane(workspace, pluginId);
  const tabId = workspace.state.openTab({
    workspaceKey,
    target: { kind: "plugin", pluginId, panelId, context: "workspace" },
    intent: "reveal",
    placement: mainPane ? { mode: "pane", paneId: mainPane.id } : undefined,
    state: tabState,
  });
  if (!tabId) return;
  store.getState().setTabState(workspaceKey, tabId, tabState);
  const target = anchorInWorkspace
    ? { targetPaneId: anchorInWorkspace.id, position }
    : mainPane
      ? { targetPaneId: mainPane.id, position: "right" as const }
      : null;
  if (target) store.getState().splitPane(workspaceKey, { tabId, ...target });
  store.getState().focusTab(workspaceKey, tabId);
}

/**
 * Opens a file the way better-chat-management expects a new file to open: no placement, so its
 * openTab wrapper sends it to the file area (or reveals the tab if the file is already open).
 * Paseo's tree opens pass a `pane` placement for the focused pane, which that plugin leaves
 * alone, so files would land beside the chat. Returns false when better-chat-management is absent.
 */
export function openFileInFileArea(store: LayoutStoreApi, workspaceKey: string, path: string): boolean {
  if (!isChatManagementActive(store)) return false;
  const tabId = store.getState().openTab({ workspaceKey, target: { kind: "file", path }, intent: "reveal" });
  if (tabId) store.getState().focusTab(workspaceKey, tabId);
  return true;
}

/** A file tab, or one of this plugin's diff or commit tabs */
function isFileView(tab: LayoutTab, pluginId: string): boolean {
  return tab.target.kind === "file" || isPluginPanelTab(tab, pluginId, FILE_VIEW_PANEL_IDS);
}

/** better-chat-management's file area (the side pane, created if absent), never one of our panes */
function fileAreaPane(store: LayoutStoreApi, workspaceKey: string, pluginId: string): string | null {
  const paneId = store.getState().ensureSidePane(workspaceKey);
  const workspace = readPanes(store, workspaceKey);
  const pane = workspace?.panes.find((candidate) => candidate.id === paneId);
  if (!pane || pane.id === workspace?.explorerPaneId) return null;
  const ours = (pane.tabs ?? []).some((tab) => isPluginPanelTab(tab, pluginId, EXCLUSIVE_PANEL_IDS));
  return ours ? null : pane.id;
}

/**
 * Opens (or reveals) a plugin file view with the given tab state: in better-chat-management's
 * file area when that plugin runs, else in the main pane
 */
export function openPanelInMainPane(
  store: LayoutStoreApi,
  workspaceKey: string,
  pluginId: string,
  panelId: string,
  tabState: unknown,
): void {
  const workspace = readPanes(store, workspaceKey);
  if (!workspace) return;
  const fileArea = isChatManagementActive(store) ? fileAreaPane(store, workspaceKey, pluginId) : null;
  const paneId = fileArea ?? findMainPane(workspace, pluginId)?.id;
  const tabId = store.getState().openTab({
    workspaceKey,
    target: { kind: "plugin", pluginId, panelId, context: "workspace" },
    intent: "reveal",
    placement: paneId ? { mode: "pane", paneId } : undefined,
    state: tabState,
  });
  if (!tabId) return;
  // openTab keeps an existing tab's state, so retargeting writes it explicitly
  store.getState().setTabState(workspaceKey, tabId, tabState);
  store.getState().focusTab(workspaceKey, tabId);
}

/**
 * Focuses the workspace's primary file tree tab, showing the Explorer dock when the tree lives
 * there; with no tree tab, opens one in Explorer, where the stock file tree would have opened.
 * Returns the tree's tab id, or null when the workspace has no layout.
 */
export function showTreeTab(store: LayoutStoreApi, workspaceKey: string, pluginId: string): string | null {
  const workspace = readPanes(store, workspaceKey);
  if (!workspace) return null;
  for (const pane of workspace.panes) {
    const tab = (pane.tabs ?? []).find((candidate) => isPluginPanelTab(candidate, pluginId, TREE_PANEL_ID_SET));
    if (!tab) continue;
    if (pane.id === workspace.explorerPaneId) store.getState().showExplorerSidebar(workspaceKey);
    store.getState().focusTab(workspaceKey, tab.tabId);
    return tab.tabId;
  }
  const paneId = store.getState().showExplorerSidebar(workspaceKey);
  const tabId = store.getState().openTab({
    workspaceKey,
    target: { kind: "plugin", pluginId, panelId: TREE_PANEL_ID, context: "workspace" },
    intent: "reveal",
    placement: paneId ? { mode: "pane", paneId } : undefined,
  });
  if (tabId) store.getState().focusTab(workspaceKey, tabId);
  return tabId;
}

/**
 * Focuses the workspace's Git panel tab, or opens one in the main pane, from where it splits
 * itself out below the tree. Stands in for Paseo's Changes view. Returns the tab id, or null
 * when the workspace has no layout.
 */
export function showGitTab(store: LayoutStoreApi, workspaceKey: string, pluginId: string): string | null {
  const workspace = readPanes(store, workspaceKey);
  if (!workspace) return null;
  const existing = findPanelTabs(store, workspaceKey, pluginId, [GIT_PANEL_ID])[0];
  if (existing) {
    store.getState().focusTab(workspaceKey, existing.tabId);
    return existing.tabId;
  }
  const mainPane = findMainPane(workspace, pluginId);
  const tabId = store.getState().openTab({
    workspaceKey,
    target: { kind: "plugin", pluginId, panelId: GIT_PANEL_ID, context: "workspace" },
    intent: "reveal",
    placement: mainPane ? { mode: "pane", paneId: mainPane.id } : undefined,
  });
  if (tabId) store.getState().focusTab(workspaceKey, tabId);
  return tabId;
}
