import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyArrangement,
  arrangementSignature,
  extractArrangement,
  healStoredSizes,
  type LayoutNode,
  type LayoutPaneNode,
  type PaneRole,
  keepSavedPlacements,
  remapSizes,
} from "./layout-model.ts";
import { createLayoutSync, type LayoutPreferences } from "./layout-sync.ts";

const plugin = (panelId: string) => ({ tabId: panelId, target: { kind: "plugin", pluginId: "p", panelId } });
const other = (tabId: string) => ({ tabId, target: { kind: "agent" } });
const paneNode = (id: string, tabs: { tabId: string; target: { kind: string; panelId?: string } }[] = []): LayoutNode => ({
  kind: "pane",
  pane: { id, tabIds: tabs.map((tab) => tab.tabId), tabs },
});
const groupNode = (id: string, direction: "horizontal" | "vertical", children: LayoutNode[], sizes: number[]): LayoutNode => ({
  kind: "group",
  group: { id, direction, children, sizes },
});

// The user's workspace as persisted: chat | tree over a pinned view | Explorer (docked), then Git.
// group.sizes are stale; the stored sizes are what the user dragged
function arrangedWorkspace(): LayoutNode {
  return groupNode(
    "outer",
    "horizontal",
    [
      groupNode(
        "workspace-root",
        "horizontal",
        [
          paneNode("main", [other("agent-1"), other("draft-1")]),
          groupNode("column", "vertical", [paneNode("tree-pane", [plugin("tree")]), paneNode("pinned", [plugin("tree-view-1")])], [0.5, 0.5]),
          paneNode("explorer", [other("files")]),
        ],
        [0.39, 0.39, 0.22],
      ),
      paneNode("git-pane", [plugin("git")]),
    ],
    [0.824, 0.176],
  );
}
const ARRANGED_SIZES = {
  outer: [0.875, 0.125],
  // Two entries: the renderer drops Explorer before sizing
  "workspace-root": [0.84, 0.16],
  column: [0.56, 0.44],
};

// A new workspace: chat | tree | git with no stored sizes, which the renderer shows as equal thirds
function newWorkspace(): LayoutNode {
  return groupNode(
    "outer-b",
    "horizontal",
    [
      groupNode("workspace-root", "horizontal", [paneNode("main-b", [other("agent-2")]), paneNode("explorer", [other("files")])], [0.78, 0.22]),
      paneNode("tree-b", [plugin("tree")]),
      paneNode("git-b", [plugin("git")]),
    ],
    [0.7, 0.15, 0.15],
  );
}

function roleOf(pane: LayoutPaneNode): PaneRole {
  const tabs = pane.tabs ?? [];
  if (tabs.length !== 1 || tabs[0].target.kind !== "plugin") return "rest";
  if (tabs[0].target.panelId === "tree") return "tree";
  if (tabs[0].target.panelId === "git") return "git";
  return tabs[0].target.panelId?.startsWith("tree-view-") ? null : "rest";
}

test("extractArrangement reads what the renderer shows: stored sizes, Explorer removed", () => {
  const extracted = extractArrangement(arrangedWorkspace(), roleOf, "explorer", ARRANGED_SIZES)!;
  // rest 0.84 * 0.875, tree 0.16 * 0.875, git 0.125; the pinned view drops out of the column
  assert.equal(arrangementSignature(extracted.arrangement), "h(rest:735,tree:140,git:125)");
  assert.equal(extracted.userSized, true);
  // Without stored sizes every split renders equal and nothing counts as user-sized
  const unsized = extractArrangement(newWorkspace(), roleOf, "explorer", undefined)!;
  assert.equal(arrangementSignature(unsized.arrangement), "h(rest:333,tree:333,git:333)");
  assert.equal(unsized.userSized, false);
});

test("applyArrangement writes stored sizes so the rebuilt workspace renders the arrangement", () => {
  const saved = extractArrangement(arrangedWorkspace(), roleOf, "explorer", ARRANGED_SIZES)!.arrangement;
  let counter = 0;
  const rebuilt = applyArrangement(newWorkspace(), saved, roleOf, "explorer", undefined, () => `new-${++counter}`)!;
  const stored: Record<string, number[]> = {};
  for (const [groupId, sizes] of Object.entries(rebuilt.sizeUpdates)) if (sizes) stored[groupId] = sizes;
  assert.equal(
    arrangementSignature(extractArrangement(rebuilt.root, roleOf, "explorer", stored)!.arrangement),
    arrangementSignature(saved),
  );
});

test("extractArrangement refuses a layout without a placed tree, and Git sharing the chat pane is rest", () => {
  const treeInExplorer = groupNode("root", "horizontal", [paneNode("main", [other("a")]), paneNode("explorer", [plugin("tree")])], [0.7, 0.3]);
  assert.equal(extractArrangement(treeInExplorer, roleOf, "explorer", undefined), null);
  const shared = groupNode("root", "horizontal", [paneNode("main", [other("a"), plugin("git")]), paneNode("tree", [plugin("tree")])], [0.7, 0.3]);
  assert.equal(
    arrangementSignature(extractArrangement(shared, roleOf, "explorer", { root: [0.7, 0.3] })!.arrangement),
    "h(rest:700,tree:300)",
  );
});

test("remapSizes: a split takes half its neighbour, a close returns the share", () => {
  const round = (sizes: number[]) => sizes.map((size) => Math.round(size * 1000) / 1000);
  // Your case: chat | tree column, then "split right" from the chat pane
  assert.deepEqual(round(remapSizes(["main", "column"], [0.684, 0.316], ["main", "new", "column"])), [0.342, 0.342, 0.316]);
  assert.deepEqual(round(remapSizes(["main", "new", "column"], [0.342, 0.342, 0.316], ["main", "column"])), [0.684, 0.316]);
  assert.deepEqual(round(remapSizes(["a", "b"], [0.5, 0.5], ["new", "a", "b"])), [0.25, 0.25, 0.5]);
});

test("healStoredSizes repairs stale stored sizes after Paseo inserts a pane into a sized group", () => {
  const before = groupNode("workspace-root", "horizontal", [paneNode("main", [other("a")]), paneNode("tree", [plugin("tree")]), paneNode("explorer")], [0.39, 0.39, 0.22]);
  const first = healStoredSizes(before, "explorer", { "workspace-root": [0.684, 0.316] }, new Map());
  assert.deepEqual(first.updates, {});
  const after = groupNode(
    "workspace-root",
    "horizontal",
    [paneNode("main", [other("a")]), paneNode("new", [other("b")]), paneNode("tree", [plugin("tree")]), paneNode("explorer")],
    [0.195, 0.195, 0.39, 0.22],
  );
  const second = healStoredSizes(after, "explorer", { "workspace-root": [0.684, 0.316] }, first.children);
  assert.deepEqual(second.updates["workspace-root"].map((size) => Math.round(size * 1000) / 1000), [0.342, 0.342, 0.316]);
  // With no memory of the old children, the persisted sizes stand in
  const cold = healStoredSizes(after, "explorer", { "workspace-root": [0.684, 0.316] }, new Map());
  assert.deepEqual(cold.updates["workspace-root"], [0.25, 0.25, 0.5]);
});

function createFakeStore(
  layouts: Record<string, LayoutNode>,
  sizes: Record<string, Record<string, number[]>>,
  sidePanes: Record<string, string | null> = {},
) {
  const listeners = new Set<() => void>();
  let state = {
    layoutByWorkspace: Object.fromEntries(Object.entries(layouts).map(([key, root]) => [key, { root }])) as Record<string, { root: unknown }>,
    splitSizesByWorkspace: sizes,
    explorerSidebarPaneIdByWorkspace: Object.fromEntries(Object.keys(layouts).map((key) => [key, "explorer"])) as Record<string, string>,
    sidePaneIdByWorkspace: sidePanes,
    explorerSidebarWidthByWorkspace: {} as Record<string, number>,
    resizeExplorerSidebar(workspaceKey: string, width: number) {
      store.setState({ explorerSidebarWidthByWorkspace: { ...state.explorerSidebarWidthByWorkspace, [workspaceKey]: width } });
    },
  };
  const store = {
    getState: () => state,
    setState(partial: Partial<typeof state>) {
      state = { ...state, ...partial };
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { store, get state() { return state; } };
}

function renderedSignature(fake: ReturnType<typeof createFakeStore>, key: string): string {
  const root = fake.state.layoutByWorkspace[key].root as LayoutNode;
  return arrangementSignature(extractArrangement(root, roleOf, "explorer", fake.state.splitSizesByWorkspace[key])?.arrangement);
}

test("layout sync seeds from the hand-sized workspace and spreads it, and later edits, to the others at once", () => {
  const fake = createFakeStore({ a: arrangedWorkspace(), b: newWorkspace() }, { a: { ...ARRANGED_SIZES } });
  let preferences: LayoutPreferences = { arrangement: null, explorerWidth: null };
  const saved: Partial<LayoutPreferences>[] = [];
  const sync = createLayoutSync(fake.store, {
    read: () => preferences,
    save: (patch) => {
      saved.push(patch);
      preferences = { ...preferences, ...patch };
    },
  });
  sync.sync();
  // Workspace a was sized by hand, so it seeds the global arrangement, and workspace b, which had
  // only the renderer's equal thirds, is rebuilt to it in the same pass
  assert.equal(saved.length, 1);
  assert.equal(arrangementSignature(saved[0].arrangement ?? null), "h(rest:735,tree:140,git:125)");
  assert.equal(renderedSignature(fake, "b"), "h(rest:735,tree:140,git:125)");

  // Dragging in workspace b becomes global and reaches workspace a with no further store change
  fake.store.setState({ splitSizesByWorkspace: { ...fake.state.splitSizesByWorkspace, b: Object.fromEntries(
    Object.entries(fake.state.splitSizesByWorkspace.b).map(([groupId, sizes]) => [groupId, sizes.length === 3 ? [0.6, 0.2, 0.2] : sizes]),
  ) } });
  assert.equal(saved.length, 2);
  assert.equal(renderedSignature(fake, "a"), "h(rest:600,tree:200,git:200)");
  sync.stop();
});

test("a split inside the chat area is healed and leaves the global arrangement alone", () => {
  const fake = createFakeStore({ a: arrangedWorkspace() }, { a: { ...ARRANGED_SIZES } });
  let preferences: LayoutPreferences = { arrangement: null, explorerWidth: null };
  const saved: Partial<LayoutPreferences>[] = [];
  const sync = createLayoutSync(fake.store, {
    read: () => preferences,
    save: (patch) => {
      saved.push(patch);
      preferences = { ...preferences, ...patch };
    },
  });
  sync.sync();
  assert.equal(saved.length, 1);
  const before = renderedSignature(fake, "a");

  // "Split right" from the chat pane: Paseo inserts a pane into workspace-root, stored sizes untouched
  const root = fake.state.layoutByWorkspace.a.root as LayoutNode;
  if (root.kind !== "group") throw new Error("expected a group");
  const workspaceRoot = root.group.children[0];
  if (workspaceRoot.kind !== "group") throw new Error("expected a group");
  workspaceRoot.group.children.splice(1, 0, paneNode("new", [other("terminal")]));
  workspaceRoot.group.sizes = [0.195, 0.195, 0.39, 0.22];
  fake.store.setState({ layoutByWorkspace: { a: { root: { ...root } } } });

  assert.equal(fake.state.splitSizesByWorkspace.a["workspace-root"].length, 3);
  assert.equal(renderedSignature(fake, "a"), before);
  assert.equal(saved.length, 1);
  sync.stop();
});

// better-chat-management's file area: the remembered side pane, which Paseo creates as a
// full-height split around the whole layout, so it lands right of the tree and Git
function workspaceWithFileArea(): LayoutNode {
  return groupNode(
    "side-wrap",
    "horizontal",
    [arrangedWorkspace(), paneNode("file-area", [other("file-a"), other("file-b")])],
    [0.75, 0.25],
  );
}

test("the file area is its own slot, so a file pane right of the tree keeps the rest whole", () => {
  const sideAwareRole = (pane: LayoutPaneNode): PaneRole => (pane.id === "file-area" ? "files" : roleOf(pane));
  const extracted = extractArrangement(workspaceWithFileArea(), sideAwareRole, "explorer", {
    ...ARRANGED_SIZES,
    "side-wrap": [0.75, 0.25],
  })!;
  assert.equal(arrangementSignature(extracted.arrangement), "h(rest:551,tree:105,git:94,files:250)");
  // Without the slot, the file pane would be a second "rest" and nothing could be recorded
  assert.equal(extractArrangement(workspaceWithFileArea(), roleOf, "explorer", ARRANGED_SIZES), null);
});

test("layout sync places another workspace's file area where the user keeps theirs", () => {
  const otherWithFiles = groupNode(
    "wrap-b",
    "horizontal",
    [newWorkspace(), paneNode("files-b", [other("file-c")])],
    [0.5, 0.5],
  );
  const fake = createFakeStore(
    { a: workspaceWithFileArea(), b: otherWithFiles },
    { a: { ...ARRANGED_SIZES, "side-wrap": [0.75, 0.25] } },
    { a: "file-area", b: "files-b" },
  );
  let preferences: LayoutPreferences = { arrangement: null, explorerWidth: null };
  const sync = createLayoutSync(fake.store, {
    read: () => preferences,
    save: (patch) => {
      preferences = { ...preferences, ...patch };
    },
  });
  sync.sync();
  fake.store.setState({});
  const roleB = (pane: LayoutPaneNode): PaneRole => (pane.id === "files-b" ? "files" : roleOf(pane));
  const rootB = fake.state.layoutByWorkspace.b.root as LayoutNode;
  assert.equal(
    arrangementSignature(extractArrangement(rootB, roleB, "explorer", fake.state.splitSizesByWorkspace.b)?.arrangement),
    "h(rest:551,tree:105,git:94,files:250)",
  );
  sync.stop();
});

test("a workspace without a file area keeps the tree and Git at their saved sizes, and a drag there keeps the file area's place", () => {
  const fake = createFakeStore(
    { a: workspaceWithFileArea(), b: newWorkspace() },
    { a: { ...ARRANGED_SIZES, "side-wrap": [0.75, 0.25] } },
    { a: "file-area" },
  );
  let preferences: LayoutPreferences = { arrangement: null, explorerWidth: null };
  const sync = createLayoutSync(fake.store, {
    read: () => preferences,
    save: (patch) => {
      preferences = { ...preferences, ...patch };
    },
  });
  sync.sync();
  assert.equal(arrangementSignature(preferences.arrangement), "h(rest:551,tree:105,git:94,files:250)");
  // The file area's share goes to the chat side, so the tree and Git are as wide as in workspace a
  assert.equal(renderedSignature(fake, "b"), "h(rest:801,tree:105,git:94)");

  // Dragging the tree wider in workspace b moves it everywhere at once, the file area unchanged
  fake.store.setState({ splitSizesByWorkspace: { ...fake.state.splitSizesByWorkspace, b: Object.fromEntries(
    Object.entries(fake.state.splitSizesByWorkspace.b).map(([groupId, sizes]) => [groupId, sizes.length === 3 ? [0.6, 0.25, 0.15] : sizes]),
  ) } });
  assert.equal(arrangementSignature(preferences.arrangement), "h(rest:350,tree:250,git:150,files:250)");
  const roleA = (pane: LayoutPaneNode): PaneRole => (pane.id === "file-area" ? "files" : roleOf(pane));
  const rootA = fake.state.layoutByWorkspace.a.root as LayoutNode;
  assert.equal(
    arrangementSignature(extractArrangement(rootA, roleA, "explorer", fake.state.splitSizesByWorkspace.a)?.arrangement),
    "h(rest:350,tree:250,git:150,files:250)",
  );
  sync.stop();
});

test("resizing a workspace without a Git pane keeps Git's saved place below the tree", () => {
  // Workspace a has Git below the tree; workspace c (no repository) has only the tree
  const withGit = groupNode(
    "outer-a",
    "horizontal",
    [
      groupNode("workspace-root", "horizontal", [paneNode("main-a", [other("agent-a")]), paneNode("explorer", [other("files")])], [0.8, 0.2]),
      groupNode("col-a", "vertical", [paneNode("tree-a", [plugin("tree")]), paneNode("git-a", [plugin("git")])], [0.5, 0.5]),
    ],
    [0.5, 0.5],
  );
  const withoutGit = groupNode(
    "outer-c",
    "horizontal",
    [
      groupNode("workspace-root", "horizontal", [paneNode("main-c", [other("agent-c")]), paneNode("explorer", [other("files")])], [0.8, 0.2]),
      paneNode("tree-c", [plugin("tree")]),
    ],
    [0.5, 0.5],
  );
  const fake = createFakeStore({ a: withGit, c: withoutGit }, { a: { "outer-a": [0.7, 0.3], "col-a": [0.6, 0.4] } });
  let preferences: LayoutPreferences = { arrangement: null, explorerWidth: null };
  const sync = createLayoutSync(fake.store, {
    read: () => preferences,
    save: (patch) => {
      preferences = { ...preferences, ...patch };
    },
  });
  sync.sync();
  fake.store.setState({});
  assert.equal(arrangementSignature(preferences.arrangement), "h(rest:700,v(tree:600,git:400):300)");
  assert.equal(renderedSignature(fake, "c"), "h(rest:700,tree:300)");

  // Dragging the tree wider in workspace c
  fake.store.setState({ splitSizesByWorkspace: { ...fake.state.splitSizesByWorkspace, c: Object.fromEntries(
    Object.entries(fake.state.splitSizesByWorkspace.c).map(([groupId, sizes]) => [groupId, sizes.length === 2 ? [0.6, 0.4] : sizes]),
  ) } });
  assert.equal(arrangementSignature(preferences.arrangement), "h(rest:600,v(tree:600,git:400):400)");

  // Workspace c already shows that arrangement, so it is left as dragged; workspace a follows with Git below the tree
  const rootC = fake.state.layoutByWorkspace.c.root;
  fake.store.setState({});
  assert.equal(fake.state.layoutByWorkspace.c.root, rootC);
  assert.equal(renderedSignature(fake, "a"), "h(rest:600,v(tree:600,git:400):400)");
  sync.stop();
});

test("keepSavedPlacements: missing Git and file area rejoin their saved neighbours from the rest, or are left out when those split apart", () => {
  const slot = (name: "rest" | "tree" | "git" | "files") => ({ kind: "slot" as const, slot: name });
  // Git beside the tree in one flat row keeps its share, which the rest gives up
  const flat = keepSavedPlacements(
    { kind: "group", direction: "horizontal", children: [slot("rest"), slot("tree")], sizes: [0.6, 0.4] },
    { kind: "group", direction: "horizontal", children: [slot("rest"), slot("tree"), slot("git")], sizes: [0.7, 0.2, 0.1] },
  );
  assert.equal(arrangementSignature(flat), "h(rest:500,tree:400,git:100)");
  // Without both, as a workspace that never opened Git or a file shows the arrangement: both return in place
  const both = keepSavedPlacements(
    { kind: "group", direction: "horizontal", children: [slot("rest"), slot("tree")], sizes: [0.8, 0.2] },
    { kind: "group", direction: "horizontal", children: [slot("rest"), slot("files"), slot("tree"), slot("git")], sizes: [0.3, 0.4, 0.2, 0.1] },
  );
  assert.equal(arrangementSignature(both), "h(rest:300,files:400,tree:200,git:100)");
  // Git beside a block of tree and file area, which no longer exists: nothing to rejoin
  const apart = { kind: "group" as const, direction: "horizontal" as const, children: [slot("tree"), slot("rest"), slot("files")], sizes: [0.2, 0.6, 0.2] };
  const saved = {
    kind: "group" as const,
    direction: "horizontal" as const,
    children: [
      slot("rest"),
      { kind: "group" as const, direction: "vertical" as const, children: [{ kind: "group" as const, direction: "horizontal" as const, children: [slot("tree"), slot("files")], sizes: [0.5, 0.5] }, slot("git")], sizes: [0.7, 0.3] },
    ],
    sizes: [0.6, 0.4],
  };
  assert.equal(keepSavedPlacements(apart, saved), apart);
});
