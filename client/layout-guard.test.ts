import assert from "node:assert/strict";
import { test } from "node:test";
import {
  closeVisibleStockChanges,
  findLayoutStore,
  findPanelHost,
  findPanelTabs,
  guardExclusivePane,
  hideStockOnlyExplorer,
  openFileInFileArea,
  openPanelInMainPane,
  openPanelInNewSplit,
  showGitTab,
  showTreeTab,
  splitIntoOwnPane,
} from "./layout-guard.ts";

const KEY = "server:workspace";
const PLUGIN = "better-tree";

interface FakePane {
  id: string;
  tabIds: string[];
  focusedTabId: string | null;
  hidden?: boolean;
  tabs: { tabId: string; target: Record<string, string>; state?: unknown }[];
}

const pluginTab = (tabId: string, panelId: string, state?: unknown) => ({
  tabId,
  target: { kind: "plugin", pluginId: PLUGIN, panelId, context: "workspace" },
  state,
});
const plainTab = (tabId: string) => ({ tabId, target: { kind: "file", path: tabId } });

function pane(id: string, tabs: FakePane["tabs"]): FakePane {
  return { id, tabIds: tabs.map((tab) => tab.tabId), focusedTabId: tabs[0]?.tabId ?? null, tabs };
}

function createFakeStore(panes: FakePane[]) {
  const listeners = new Set<() => void>();
  const focused: string[] = [];
  const splits: unknown[] = [];
  const opened: unknown[] = [];
  const tabStates = new Map<string, unknown>();
  const findTab = (tabId: string) => panes.flatMap((item) => item.tabs).find((tab) => tab.tabId === tabId)!;
  let state: any = {
    layoutByWorkspace: {
      [KEY]: { root: { kind: "group", group: { children: panes.map((item) => ({ kind: "pane", pane: item })) } } },
    },
    explorerSidebarPaneIdByWorkspace: { [KEY]: "explorer" },
    sidePaneIdByWorkspace: { [KEY]: "tree-pane" },
    moveTabToPane(_key: string, tabId: string, toPaneId: string) {
      const tab = findTab(tabId);
      for (const item of panes) {
        item.tabIds = item.tabIds.filter((id) => id !== tabId);
        item.tabs = item.tabs.filter((candidate) => candidate.tabId !== tabId);
      }
      const destination = panes.find((item) => item.id === toPaneId)!;
      destination.tabIds.push(tabId);
      destination.tabs.push(tab);
      store.setState({});
    },
    focusTab(_key: string, tabId: string) {
      focused.push(tabId);
    },
    splitPane(_key: string, input: unknown) {
      splits.push(input);
      return "new-pane";
    },
    openTab(input: { placement?: { paneId: string } }) {
      opened.push(input);
      return "opened-tab";
    },
    ensureSidePane(_key: string) {
      return state.sidePaneIdByWorkspace[KEY] ?? null;
    },
    setTabState(_key: string, tabId: string, tabState: unknown) {
      tabStates.set(tabId, tabState);
    },
  };
  const store = {
    getState: () => state,
    setState(partial: object) {
      state = { ...state, ...partial };
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { store, panes, focused, splits, opened, tabStates };
}

test("showTreeTab focuses the tree where it lives and shows Explorer only when it is there", () => {
  const inExplorer = createFakeStore([pane("explorer", [plainTab("changes"), pluginTab("tree", "tree")]), pane("main", [])]);
  const shown: string[] = [];
  inExplorer.store.getState().showExplorerSidebar = (key: string) => (shown.push(key), "explorer");
  assert.equal(showTreeTab(inExplorer.store, KEY, PLUGIN), "tree");
  assert.deepEqual([inExplorer.focused, shown], [["tree"], [KEY]]);

  const inPane = createFakeStore([pane("explorer", [plainTab("changes")]), pane("tree-pane", [pluginTab("tree", "tree")])]);
  inPane.store.getState().showExplorerSidebar = () => assert.fail("Explorer must stay as it is");
  assert.equal(showTreeTab(inPane.store, KEY, PLUGIN), "tree");
  assert.deepEqual(inPane.focused, ["tree"]);
});

test("showTreeTab opens a missing tree in Explorer", () => {
  const fake = createFakeStore([pane("explorer", [plainTab("changes")]), pane("main", [plainTab("chat")])]);
  fake.store.getState().showExplorerSidebar = () => "explorer";
  assert.equal(showTreeTab(fake.store, KEY, PLUGIN), "opened-tab");
  assert.deepEqual(fake.opened, [
    {
      workspaceKey: KEY,
      target: { kind: "plugin", pluginId: PLUGIN, panelId: "tree", context: "workspace" },
      intent: "reveal",
      placement: { mode: "pane", paneId: "explorer" },
    },
  ]);
  assert.deepEqual(fake.focused, ["opened-tab"]);
});

test("guardExclusivePane evicts strays into a pane without exclusive panels", () => {
  const { store, panes, focused } = createFakeStore([
    pane("explorer", [plainTab("changes")]),
    pane("git-pane", [pluginTab("git", "git")]),
    pane("main", [plainTab("chat")]),
    pane("tree-pane", [pluginTab("tree", "tree")]),
  ]);
  const stop = guardExclusivePane(store, KEY, "tree", PLUGIN);
  assert.equal(store.getState().sidePaneIdByWorkspace[KEY], null);

  panes[3].tabIds.push("file-a");
  panes[3].tabs.push(plainTab("file-a"));
  panes[3].focusedTabId = "file-a";
  store.setState({});
  assert.deepEqual(panes[3].tabIds, ["tree"]);
  assert.deepEqual(panes[2].tabIds, ["chat", "file-a"]);
  assert.deepEqual(panes[1].tabIds, ["git"]);
  assert.deepEqual(focused, ["file-a"]);

  stop();
  panes[3].tabIds.push("file-b");
  store.setState({});
  assert.deepEqual(panes[3].tabIds, ["tree", "file-b"]);
});

test("guardExclusivePane ignores a panel hosted in Explorer", () => {
  const { store, panes } = createFakeStore([
    pane("explorer", [pluginTab("tree", "tree"), plainTab("changes")]),
    pane("main", [plainTab("chat")]),
  ]);
  guardExclusivePane(store, KEY, "tree", PLUGIN);
  assert.deepEqual(panes[0].tabIds, ["tree", "changes"]);
});

test("splitIntoOwnPane splits below the anchor panel's pane only when sharing", () => {
  const shared = createFakeStore([
    pane("main", [plainTab("chat"), pluginTab("git", "git")]),
    pane("tree-pane", [pluginTab("tree", "tree")]),
  ]);
  assert.equal(splitIntoOwnPane(shared.store, KEY, "git", PLUGIN, { panelId: "tree", position: "bottom" }), true);
  assert.deepEqual(shared.splits, [{ tabId: "git", targetPaneId: "tree-pane", position: "bottom" }]);

  const alone = createFakeStore([pane("main", [plainTab("chat")]), pane("git-pane", [pluginTab("git", "git")])]);
  assert.equal(splitIntoOwnPane(alone.store, KEY, "git", PLUGIN, { panelId: "tree", position: "bottom" }), false);
  assert.deepEqual(alone.splits, []);
});

test("openPanelInMainPane targets the main pane and writes the tab state", () => {
  const { store, opened, tabStates, focused } = createFakeStore([
    pane("tree-pane", [pluginTab("tree", "tree")]),
    pane("main", [plainTab("chat"), pluginTab("d1", "diff-1", { path: "a" })]),
  ]);
  assert.deepEqual(
    findPanelTabs(store, KEY, PLUGIN, ["diff-1", "diff-2"]).map((tab) => [tab.panelId, tab.tabId]),
    [["diff-1", "d1"]],
  );
  openPanelInMainPane(store, KEY, PLUGIN, "diff-2", { path: "b" });
  assert.equal((opened[0] as { placement: { paneId: string } }).placement.paneId, "main");
  assert.deepEqual(tabStates.get("opened-tab"), { path: "b" });
  assert.deepEqual(focused, ["opened-tab"]);
});

test("openPanelInNewSplit splits below a workspace-pane anchor and right of main for Explorer", () => {
  const fromSide = createFakeStore([
    pane("explorer", [plainTab("changes")]),
    pane("main", [plainTab("chat")]),
    pane("tree-pane", [pluginTab("tree", "tree")]),
  ]);
  openPanelInNewSplit(fromSide.store, KEY, PLUGIN, "tree-view-1", { viewRoot: "/r/src" }, "tree");
  assert.equal((fromSide.opened[0] as { placement: { paneId: string } }).placement.paneId, "main");
  assert.deepEqual(fromSide.splits, [{ tabId: "opened-tab", targetPaneId: "tree-pane", position: "bottom" }]);
  assert.deepEqual(fromSide.tabStates.get("opened-tab"), { viewRoot: "/r/src" });

  const fromExplorer = createFakeStore([
    pane("explorer", [pluginTab("tree", "tree")]),
    pane("main", [plainTab("chat")]),
  ]);
  openPanelInNewSplit(fromExplorer.store, KEY, PLUGIN, "tree-view-1", { viewRoot: "/r" }, "tree");
  assert.deepEqual(fromExplorer.splits, [{ tabId: "opened-tab", targetPaneId: "main", position: "right" }]);

  const existing = createFakeStore([
    pane("main", [plainTab("chat")]),
    pane("view-pane", [pluginTab("v1", "tree-view-1", { viewRoot: "/old" })]),
  ]);
  openPanelInNewSplit(existing.store, KEY, PLUGIN, "tree-view-1", { viewRoot: "/new" }, "tree");
  assert.deepEqual(existing.opened, []);
  assert.deepEqual(existing.splits, []);
  assert.deepEqual(existing.tabStates.get("v1"), { viewRoot: "/new" });
  assert.deepEqual(existing.focused, ["v1"]);
});

test("findPanelHost reports where a panel lives, from any plugin", () => {
  const { store } = createFakeStore([
    pane("explorer", [pluginTab("tree", "tree")]),
    pane("git-pane", [pluginTab("git", "git")]),
  ]);
  assert.equal(findPanelHost(store, KEY, "tree"), "explorer");
  assert.equal(findPanelHost(store, KEY, "git"), "main");
  assert.equal(findPanelHost(store, KEY, "diff-1"), null);
});

test("findLayoutStore reads the store from useCallback deps on an ancestor fiber", () => {
  const { store } = createFakeStore([pane("main", [])]);
  const ancestor = {
    return: null,
    memoizedState: { memoizedState: [() => 0, [store, () => 0]], next: null },
  };
  const node = { __reactFiber$abc: { return: ancestor, memoizedState: null } };
  assert.equal(findLayoutStore(node), store);
});

/** Marks the fake store's openTab the way better-chat-management marks its wrapper */
function withChatManagement(fake: ReturnType<typeof createFakeStore>, filesPaneId: string) {
  const state = fake.store.getState();
  state.openTab = Object.assign(state.openTab, { __betterChatDisplayWrapped: true });
  fake.store.setState({ sidePaneIdByWorkspace: { [KEY]: filesPaneId } });
}

test("with better-chat-management, stray file views go to its file area and other tabs to the chat", () => {
  const fake = createFakeStore([
    pane("main", [plainTab("chat")]),
    pane("files", [plainTab("file-a")]),
    pane("tree-pane", [pluginTab("tree", "tree")]),
  ]);
  withChatManagement(fake, "files");
  guardExclusivePane(fake.store, KEY, "tree", PLUGIN);

  // plainTab makes file tabs; a draft chat is not a file view
  const draftTab = { tabId: "draft", target: { kind: "draft" } };
  fake.panes[2].tabIds.push("file-b", "draft");
  fake.panes[2].tabs.push(plainTab("file-b"), draftTab);
  fake.store.setState({});
  assert.deepEqual(fake.panes[2].tabIds, ["tree"]);
  assert.deepEqual(fake.panes[1].tabIds, ["file-a", "file-b"]);
  assert.deepEqual(fake.panes[0].tabIds, ["chat", "draft"]);
});

test("with better-chat-management, a stray that is not a file view calls up no file area", () => {
  const fake = createFakeStore([pane("main", [plainTab("chat")]), pane("tree-pane", [pluginTab("tree", "tree")])]);
  withChatManagement(fake, "files");
  fake.store.setState({ sidePaneIdByWorkspace: { [KEY]: null } });
  // Paseo creates the side pane on demand; one created here would stand empty
  const created: string[] = [];
  fake.store.getState().ensureSidePane = (key: string) => (created.push(key), "files");
  guardExclusivePane(fake.store, KEY, "tree", PLUGIN);

  // Opening the Git panel while the tree's pane has focus puts it there first
  fake.panes[1].tabIds.push("git");
  fake.panes[1].tabs.push(pluginTab("git", "git"));
  fake.store.setState({});
  assert.deepEqual(fake.panes[1].tabIds, ["tree"]);
  assert.deepEqual(fake.panes[0].tabIds, ["chat", "git"]);
  assert.deepEqual(created, []);
});

test("with better-chat-management, tree file opens carry no placement so its wrapper picks the file area", () => {
  const fake = createFakeStore([pane("main", [plainTab("chat")]), pane("files", [plainTab("file-a")])]);
  assert.equal(openFileInFileArea(fake.store, KEY, "src/a.ts"), false);
  assert.deepEqual(fake.opened, []);
  withChatManagement(fake, "files");
  assert.equal(openFileInFileArea(fake.store, KEY, "src/a.ts"), true);
  assert.deepEqual(fake.opened, [{ workspaceKey: KEY, target: { kind: "file", path: "src/a.ts" }, intent: "reveal" }]);
  assert.deepEqual(fake.focused, ["opened-tab"]);
});

test("with better-chat-management, diff tabs open in its file area", () => {
  const fake = createFakeStore([pane("main", [plainTab("chat")]), pane("files", [plainTab("file-a")])]);
  withChatManagement(fake, "files");
  openPanelInMainPane(fake.store, KEY, PLUGIN, "diff-1", { path: "a" });
  assert.equal((fake.opened[0] as { placement: { paneId: string } }).placement.paneId, "files");

  const without = createFakeStore([pane("main", [plainTab("chat")]), pane("files", [plainTab("file-a")])]);
  openPanelInMainPane(without.store, KEY, PLUGIN, "diff-1", { path: "a" });
  assert.equal((without.opened[0] as { placement: { paneId: string } }).placement.paneId, "main");
});

const stockTab = (kind: string) => ({ tabId: kind, target: { kind } });

/** Records closeTab and hideExplorerSidebar calls on a fake store */
function recordExplorerActions(fake: ReturnType<typeof createFakeStore>) {
  const closed: string[] = [];
  const hidden: string[] = [];
  const state = fake.store.getState();
  state.closeTab = (_key: string, tabId: string) => closed.push(tabId);
  state.hideExplorerSidebar = (key: string) => hidden.push(key);
  return { closed, hidden };
}

test("closeVisibleStockChanges closes Explorer's Changes tab only while the dock is on screen, and not on phones", () => {
  const visible = createFakeStore([pane("explorer", [stockTab("files"), stockTab("changes_tree")]), pane("main", [plainTab("chat")])]);
  const visibleCalls = recordExplorerActions(visible);
  closeVisibleStockChanges(visible.store);
  assert.deepEqual(visibleCalls.closed, ["changes_tree"]);

  const hiddenDock = createFakeStore([{ ...pane("explorer", [stockTab("files"), stockTab("changes_tree")]), hidden: true }]);
  const hiddenCalls = recordExplorerActions(hiddenDock);
  closeVisibleStockChanges(hiddenDock.store);
  assert.deepEqual(hiddenCalls.closed, []);

  const phone = createFakeStore([pane("explorer", [stockTab("files"), stockTab("changes_tree")])]);
  const phoneCalls = recordExplorerActions(phone);
  phone.store.getState().layoutMode = "compact";
  closeVisibleStockChanges(phone.store);
  assert.deepEqual(phoneCalls.closed, []);
});

test("hideStockOnlyExplorer hides a dock left with Paseo's own views, never one holding the tree", () => {
  const stockOnly = createFakeStore([pane("explorer", [stockTab("files"), stockTab("pull_request")]), pane("main", [plainTab("chat")])]);
  const stockCalls = recordExplorerActions(stockOnly);
  hideStockOnlyExplorer(stockOnly.store, KEY);
  assert.deepEqual(stockCalls.hidden, [KEY]);

  const withTree = createFakeStore([pane("explorer", [stockTab("files"), pluginTab("tree", "tree")]), pane("main", [plainTab("chat")])]);
  const treeCalls = recordExplorerActions(withTree);
  hideStockOnlyExplorer(withTree.store, KEY);
  assert.deepEqual(treeCalls.hidden, []);
});

test("showGitTab focuses an open Git panel, else opens one in the main pane", () => {
  const open = createFakeStore([pane("main", [plainTab("chat")]), pane("git-pane", [pluginTab("git", "git")])]);
  assert.equal(showGitTab(open.store, KEY, PLUGIN), "git");
  assert.deepEqual([open.focused, open.opened], [["git"], []]);

  const missing = createFakeStore([pane("explorer", [stockTab("files")]), pane("main", [plainTab("chat")])]);
  assert.equal(showGitTab(missing.store, KEY, PLUGIN), "opened-tab");
  assert.deepEqual(missing.opened, [
    {
      workspaceKey: KEY,
      target: { kind: "plugin", pluginId: PLUGIN, panelId: "git", context: "workspace" },
      intent: "reveal",
      placement: { mode: "pane", paneId: "main" },
    },
  ]);
  assert.deepEqual(missing.focused, ["opened-tab"]);
});
