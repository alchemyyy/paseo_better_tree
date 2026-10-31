// Pure helpers over the app's split layout tree (packages/app/src/stores/workspace-layout-actions.ts)
//
// NOTE: What is on screen is not the persisted tree. The renderer (`removePaneFromSplitTree` in
// packages/app/src/components/split-container.tsx) drops the docked Explorer pane, collapses
// single-child groups, and gives every group equal sizes unless `splitSizesByWorkspace` holds an
// entry with one size per rendered child. `group.sizes` never reaches the screen. Everything
// here works on that rendered view.

import type { ArrangementNode, ArrangementSlot } from "../shared/arrangement.ts";

export type { ArrangementNode, ArrangementSlot };

export interface LayoutTabNode {
  tabId: string;
  target: { kind: string; pluginId?: string; panelId?: string };
}
export interface LayoutPaneNode {
  id: string;
  tabIds: string[];
  tabs?: LayoutTabNode[];
  hidden?: boolean;
}
export interface LayoutGroupNode {
  id: string;
  direction: "horizontal" | "vertical";
  children: LayoutNode[];
  sizes: number[];
}
export type LayoutNode = { kind: "pane"; pane: LayoutPaneNode } | { kind: "group"; group: LayoutGroupNode };

/** How a pane counts in an arrangement; null leaves it out (pinned views) */
export type PaneRole = ArrangementSlot | null;

export type StoredSizes = Record<string, number[]> | undefined;

/** Post-order fold over any tree, iteratively */
export function foldTree<Node, Result>(
  root: Node,
  childrenOf: (node: Node) => readonly Node[],
  combine: (node: Node, childResults: Result[]) => Result,
): Result {
  const stack: { node: Node; results: Result[]; next: number }[] = [{ node: root, results: [], next: 0 }];
  let finished: Result | undefined;
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    const children = childrenOf(frame.node);
    if (frame.next < children.length) {
      stack.push({ node: children[frame.next], results: [], next: 0 });
      frame.next++;
      continue;
    }
    stack.pop();
    const result = combine(frame.node, frame.results);
    if (stack.length > 0) stack[stack.length - 1].results.push(result);
    else finished = result;
  }
  return finished as Result;
}

const layoutChildren = (node: LayoutNode): readonly LayoutNode[] =>
  node.kind === "group" ? node.group.children : [];
const arrangementChildren = (node: ArrangementNode): readonly ArrangementNode[] =>
  node.kind === "group" ? node.children : [];

function normalize(sizes: readonly number[]): number[] {
  const total = sizes.reduce((sum, size) => sum + size, 0);
  return total > 0 ? sizes.map((size) => size / total) : sizes.map(() => 1 / sizes.length);
}

/** The sizes the renderer uses for a group with `renderedCount` visible children */
export function renderedSizes(groupId: string, renderedCount: number, storedSizes: StoredSizes): {
  sizes: number[];
  stored: boolean;
} {
  const stored = storedSizes?.[groupId];
  if (stored && stored.length === renderedCount) return { sizes: stored, stored: true };
  return { sizes: Array.from({ length: renderedCount }, () => 1 / renderedCount), stored: false };
}

export interface HealResult {
  /** Corrected stored sizes by group id */
  updates: Record<string, number[]>;
  /** Rendered child keys per multi-child group, to compare against on the next pass */
  children: Map<string, string[]>;
}

const childKey = (node: LayoutNode): string => (node.kind === "pane" ? `pane:${node.pane.id}` : `group:${node.group.id}`);

/**
 * Repairs stored sizes whose length no longer matches a group's rendered children. Paseo's
 * splitPane and closeTab change a group's children without touching its stored sizes, and the
 * renderer then sizes the extra child with flex 1 (`sizes[index] ?? 1`), which blows it up.
 * With the previous pass's children known, a new child takes half of the sibling it was split
 * from and a removed child's share goes to its neighbour; otherwise the persisted sizes are used.
 */
export function healStoredSizes(
  root: LayoutNode,
  explorerPaneId: string | null,
  storedSizes: StoredSizes,
  previousChildren: ReadonlyMap<string, readonly string[]>,
): HealResult {
  const updates: Record<string, number[]> = {};
  const children = new Map<string, string[]>();
  foldTree<LayoutNode, boolean>(root, layoutChildren, (node, results) => {
    if (node.kind === "pane") return node.pane.id !== explorerPaneId;
    const renderedIndexes = results.flatMap((rendered, index) => (rendered ? [index] : []));
    if (renderedIndexes.length < 2) return renderedIndexes.length > 0;
    const keys = renderedIndexes.map((index) => childKey(node.group.children[index]));
    children.set(node.group.id, keys);
    const stored = storedSizes?.[node.group.id];
    if (!stored || stored.length === keys.length) return true;
    const previous = previousChildren.get(node.group.id);
    updates[node.group.id] =
      previous && previous.length === stored.length
        ? remapSizes(previous, stored, keys)
        : normalize(renderedIndexes.map((index) => node.group.sizes[index] ?? 0));
    return true;
  });
  return { updates, children };
}

/** Carries sizes from `previousKeys` to `keys`: removed shares go to a neighbour, new keys split one */
export function remapSizes(previousKeys: readonly string[], previousSizes: readonly number[], keys: readonly string[]): number[] {
  const sizeByKey = new Map<string, number>();
  previousKeys.forEach((key, index) => sizeByKey.set(key, previousSizes[index] ?? 0));
  const surviving = new Set(keys.filter((key) => sizeByKey.has(key)));
  // A removed child's share goes to the nearest surviving earlier sibling, else a later one
  previousKeys.forEach((key, index) => {
    if (surviving.has(key)) return;
    const neighbours = [...previousKeys.slice(0, index).reverse(), ...previousKeys.slice(index + 1)];
    const heir = neighbours.find((candidate) => surviving.has(candidate));
    if (heir) sizeByKey.set(heir, (sizeByKey.get(heir) ?? 0) + (sizeByKey.get(key) ?? 0));
  });
  const sizes = keys.map((key) => (surviving.has(key) ? (sizeByKey.get(key) ?? 0) : -1));
  // A new child splits the nearest existing sibling in half, preferring the one before it
  sizes.forEach((size, index) => {
    if (size >= 0) return;
    let donor = -1;
    for (let offset = 1; offset < sizes.length && donor < 0; offset++) {
      if (index - offset >= 0 && sizes[index - offset] > 0) donor = index - offset;
      else if (index + offset < sizes.length && sizes[index + offset] > 0) donor = index + offset;
    }
    if (donor < 0) {
      sizes[index] = 1;
      return;
    }
    sizes[donor] /= 2;
    sizes[index] = sizes[donor];
  });
  return normalize(sizes);
}

export interface ExtractedArrangement {
  arrangement: ArrangementNode;
  /** Every split that shapes it has sizes the user dragged, not the renderer's equal default */
  userSized: boolean;
}

interface ExtractFold {
  rendered: boolean;
  arrangement: ArrangementNode | null;
  userSized: boolean;
}

/**
 * The arrangement on screen: plain panes merge into one "rest" slot, same-direction nesting
 * flattens, single-child groups collapse. Null when no tree pane is placed in the workspace, or
 * when other content sits in more than one place (no single "rest").
 */
export function extractArrangement(
  root: LayoutNode,
  roleOf: (pane: LayoutPaneNode) => PaneRole,
  explorerPaneId: string | null,
  storedSizes: StoredSizes,
): ExtractedArrangement | null {
  const folded = foldTree<LayoutNode, ExtractFold>(root, layoutChildren, (node, results) => {
    if (node.kind === "pane") {
      if (node.pane.id === explorerPaneId) return { rendered: false, arrangement: null, userSized: true };
      const role = roleOf(node.pane);
      return { rendered: true, arrangement: role ? { kind: "slot", slot: role } : null, userSized: true };
    }
    const rendered = results.filter((result) => result.rendered);
    if (rendered.length === 0) return { rendered: false, arrangement: null, userSized: true };
    // The renderer replaces a group holding one visible child with that child
    if (rendered.length === 1) return rendered[0];
    const { sizes, stored } = renderedSizes(node.group.id, rendered.length, storedSizes);
    const children: ArrangementNode[] = [];
    const childSizes: number[] = [];
    let childrenUserSized = true;
    // A pane outside the arrangement (a pinned tree view) counts toward the rest, so the panes in
    // it are recorded at the sizes they show
    let outside = 0;
    rendered.forEach((child, index) => {
      if (!child.arrangement) {
        outside += sizes[index] ?? 0;
        return;
      }
      childrenUserSized &&= child.userSized;
      const size = sizes[index] ?? 0;
      const arrangement = child.arrangement;
      // Same-direction nesting looks identical on screen, so it flattens
      if (arrangement.kind === "group" && arrangement.direction === node.group.direction) {
        arrangement.children.forEach((grandchild, grandIndex) => {
          children.push(grandchild);
          childSizes.push(size * arrangement.sizes[grandIndex]);
        });
        return;
      }
      const previous = children[children.length - 1];
      if (arrangement.kind === "slot" && arrangement.slot === "rest" && previous?.kind === "slot" && previous.slot === "rest") {
        childSizes[childSizes.length - 1] += size;
        return;
      }
      children.push(arrangement);
      childSizes.push(size);
    });
    if (children.length === 0) return { rendered: true, arrangement: null, userSized: true };
    if (children.length === 1) return { rendered: true, arrangement: children[0], userSized: childrenUserSized };
    const restIndex = children.findIndex((child) => countSlots(child).rest > 0);
    if (restIndex >= 0) childSizes[restIndex] += outside;
    return {
      rendered: true,
      arrangement: { kind: "group", direction: node.group.direction, children, sizes: normalize(childSizes) },
      userSized: stored && childrenUserSized,
    };
  });
  if (!folded.arrangement) return null;
  const counts = countSlots(folded.arrangement);
  if (counts.rest !== 1 || counts.tree !== 1 || counts.git > 1 || counts.files > 1) return null;
  return { arrangement: folded.arrangement, userSized: folded.userSized };
}

export function countSlots(arrangement: ArrangementNode): Record<ArrangementSlot, number> {
  const counts: Record<ArrangementSlot, number> = { rest: 0, tree: 0, git: 0, files: 0 };
  foldTree<ArrangementNode, void>(arrangement, arrangementChildren, (node) => {
    if (node.kind === "slot") counts[node.slot]++;
  });
  return counts;
}

const SIGNATURE_PRECISION = 1000;

/** Stable comparison key; sizes are rounded so float noise does not count as a change */
export function arrangementSignature(arrangement: ArrangementNode | null | undefined): string {
  if (!arrangement) return "";
  return foldTree<ArrangementNode, string>(arrangement, arrangementChildren, (node, results) => {
    if (node.kind === "slot") return node.slot;
    const sizes = node.sizes.map((size) => Math.round(size * SIGNATURE_PRECISION));
    return `${node.direction[0]}(${results.map((result, index) => `${result}:${sizes[index]}`).join(",")})`;
  });
}

/** The slots under a node as an order-free comparison key */
function slotKey(node: ArrangementNode): string {
  const slots: ArrangementSlot[] = [];
  foldTree<ArrangementNode, void>(node, arrangementChildren, (child) => {
    if (child.kind === "slot") slots.push(child.slot);
  });
  return slots.sort().join(",");
}

/** A group whose same-direction child groups are merged in, as the screen shows it */
function flatGroup(direction: "horizontal" | "vertical", children: readonly ArrangementNode[], sizes: readonly number[]): ArrangementNode {
  const flatChildren: ArrangementNode[] = [];
  const flatSizes: number[] = [];
  children.forEach((child, index) => {
    const size = sizes[index] ?? 0;
    if (child.kind === "group" && child.direction === direction) {
      const childSizes = normalize(child.sizes);
      child.children.forEach((grandchild, grandIndex) => {
        flatChildren.push(grandchild);
        flatSizes.push(size * (childSizes[grandIndex] ?? 0));
      });
      return;
    }
    flatChildren.push(child);
    flatSizes.push(size);
  });
  return { kind: "group", direction, children: flatChildren, sizes: normalize(flatSizes) };
}

/**
 * The children of an arrangement group that a workspace has, with their sizes. A missing child's
 * share goes to the child holding the rest, so the panes that are there keep their sizes; with no
 * such child the others share it out.
 */
function presentChildren<Child>(
  group: Extract<ArrangementNode, { kind: "group" }>,
  results: readonly (Child | null)[],
): { children: Child[]; sizes: number[] } {
  const children: Child[] = [];
  const sizes: number[] = [];
  let missing = 0;
  let restIndex = -1;
  results.forEach((child, index) => {
    const size = group.sizes[index] ?? 0;
    if (child === null) {
      missing += size;
      return;
    }
    if (countSlots(group.children[index]).rest > 0) restIndex = children.length;
    children.push(child);
    sizes.push(size);
  });
  if (restIndex >= 0) sizes[restIndex] += missing;
  return { children, sizes: normalize(sizes) };
}

/** `arrangement` as a workspace without the panes of `slots` shows it */
function withoutSlots(arrangement: ArrangementNode, slots: readonly ArrangementSlot[]): ArrangementNode | null {
  if (slots.length === 0) return arrangement;
  return foldTree<ArrangementNode, ArrangementNode | null>(arrangement, arrangementChildren, (node, results) => {
    if (node.kind === "slot") return slots.includes(node.slot) ? null : node;
    const { children, sizes } = presentChildren(node, results);
    if (children.length === 0) return null;
    if (children.length === 1) return children[0];
    return flatGroup(node.direction, children, sizes);
  });
}

/** Slots an arrangement keeps a place for while a workspace lacks the pane: Git closed, or no file opened yet */
const OPTIONAL_SLOTS = ["git", "files"] as const;
type OptionalSlot = (typeof OPTIONAL_SLOTS)[number];

/** Where a slot sits in an arrangement: its split, position, share, and the panes beside it */
interface SlotHome {
  direction: "horizontal" | "vertical";
  index: number;
  share: number;
  neighbourCount: number;
  neighbours: string;
}

function findSlotHome(arrangement: ArrangementNode, slot: OptionalSlot): SlotHome | null {
  return foldTree<ArrangementNode, SlotHome | null>(arrangement, arrangementChildren, (node, results) => {
    const found = results.find((result) => result !== null);
    if (found) return found;
    if (node.kind !== "group") return null;
    const index = node.children.findIndex((child) => child.kind === "slot" && child.slot === slot);
    if (index < 0) return null;
    const neighbours = node.children.filter((_, childIndex) => childIndex !== index);
    return {
      direction: node.direction,
      index,
      share: normalize(node.sizes)[index] ?? 0,
      neighbourCount: neighbours.length,
      neighbours: slotKey({ kind: "group", direction: node.direction, children: neighbours, sizes: [] }),
    };
  });
}

/**
 * `sizes` (summing to 1) shrunk to make room for `share`: it comes out of the child holding the
 * rest, so the other panes keep their sizes, unless the rest is too small to give it
 */
function makeRoom(sizes: readonly number[], restIndex: number, share: number): number[] {
  if (restIndex >= 0 && sizes[restIndex] > share) {
    return sizes.map((size, index) => (index === restIndex ? size - share : size));
  }
  return sizes.map((size) => size * (1 - share));
}

/** `block` with `slot` put back beside it */
function rejoinSlot(block: ArrangementNode, home: SlotHome, slot: OptionalSlot): ArrangementNode {
  const placed: ArrangementNode = { kind: "slot", slot };
  // The block is still the slot's split minus the slot: the slot returns to its index
  if (block.kind === "group" && block.direction === home.direction && block.children.length === home.neighbourCount) {
    const children = [...block.children];
    const restIndex = block.children.findIndex((child) => countSlots(child).rest > 0);
    const sizes = makeRoom(normalize(block.sizes), restIndex, home.share);
    children.splice(home.index, 0, placed);
    sizes.splice(home.index, 0, home.share);
    return { kind: "group", direction: home.direction, children, sizes };
  }
  const first = home.index === 0;
  return flatGroup(home.direction, first ? [placed, block] : [block, placed], first ? [home.share, 1 - home.share] : [1 - home.share, home.share]);
}

/** `next` with `slot` rejoining the block of panes `home` names; `next` itself when that block is gone */
function rejoinAt(next: ArrangementNode, home: SlotHome, slot: OptionalSlot): ArrangementNode {
  let rejoined = false;
  const rebuilt = foldTree<ArrangementNode, ArrangementNode>(next, arrangementChildren, (node, children) => {
    const current = node.kind === "slot" ? node : flatGroup(node.direction, children, node.sizes);
    // Slots are unique and groups have two or more children, so one node at most matches
    if (rejoined || slotKey(current) !== home.neighbours) return current;
    rejoined = true;
    return rejoinSlot(current, home, slot);
  });
  return rejoined ? rebuilt : next;
}

/**
 * `next` with the Git and file-area slots it lacks put back where `saved` has them. An arrangement
 * read from a workspace without a Git pane (Git closed there) or without a file area (no file
 * opened there yet) says nothing about where those belong, so each rejoins the panes it sits
 * beside at its saved share, taken from the rest as applyArrangement gave it there. A slot whose
 * neighbours no longer form one block is left out.
 */
export function keepSavedPlacements(next: ArrangementNode, saved: ArrangementNode | null): ArrangementNode {
  if (!saved) return next;
  const nextCounts = countSlots(next);
  const savedCounts = countSlots(saved);
  const missing = OPTIONAL_SLOTS.filter((slot) => nextCounts[slot] === 0 && savedCounts[slot] > 0);
  let result = next;
  missing.forEach((slot, index) => {
    // Each slot finds its place among the panes `result` has, so the ones still missing leave `saved` first
    const reference = withoutSlots(saved, missing.slice(index + 1));
    const home = reference && findSlotHome(reference, slot);
    if (home) result = rejoinAt(result, home, slot);
  });
  return result;
}

export interface RebuildResult {
  root: LayoutNode;
  /** Stored sizes to write (an array) or remove (null), by group id */
  sizeUpdates: Record<string, number[] | null>;
}

interface RestFold {
  node: LayoutNode | null;
  /** On screen after the rebuild */
  rendered: boolean;
  /** On screen before the rebuild */
  wasRendered: boolean;
}

/**
 * Rebuilds a workspace layout so its tree, Git, and file-area panes follow `arrangement`.
 * Everything else (chat, Explorer, pinned views) stays together as the "rest" and keeps its sizes.
 * Returns null when the workspace has no tree pane outside Explorer to place.
 */
export function applyArrangement(
  root: LayoutNode,
  arrangement: ArrangementNode,
  roleOf: (pane: LayoutPaneNode) => PaneRole,
  explorerPaneId: string | null,
  storedSizes: StoredSizes,
  createGroupId: () => string,
): RebuildResult | null {
  const placed: Partial<Record<Exclude<ArrangementSlot, "rest">, LayoutNode>> = {};
  const sizeUpdates: Record<string, number[] | null> = {};

  // The rest: the layout without the tree and Git panes, its remaining splits keeping their sizes
  const rest = foldTree<LayoutNode, RestFold>(root, layoutChildren, (node, results) => {
    if (node.kind === "pane") {
      if (node.pane.id === explorerPaneId) return { node, rendered: false, wasRendered: false };
      const role = roleOf(node.pane);
      // The file area moves only when the arrangement has a place for it; otherwise it stays in the rest
      const movable = role === "tree" || role === "git" || (role === "files" && countSlots(arrangement).files > 0);
      if (role && role !== "rest" && movable && !placed[role]) {
        placed[role] = node;
        return { node: null, rendered: false, wasRendered: true };
      }
      return { node, rendered: true, wasRendered: true };
    }
    const wasRendered = results.some((result) => result.wasRendered);
    const rendered = results.some((result) => result.rendered);
    if (results.every((result, index) => result.node === node.group.children[index])) {
      return { node, rendered, wasRendered };
    }
    const oldRendered = results.filter((result) => result.wasRendered);
    const { sizes: oldSizes } = renderedSizes(node.group.id, oldRendered.length, storedSizes);
    const children: LayoutNode[] = [];
    const keptSizes: number[] = [];
    results.forEach((result) => {
      if (!result.node) return;
      children.push(result.node);
      if (result.rendered) keptSizes.push(oldSizes[oldRendered.indexOf(result)] ?? 0);
    });
    sizeUpdates[node.group.id] = keptSizes.length >= 2 ? normalize(keptSizes) : null;
    if (children.length === 0) return { node: null, rendered: false, wasRendered };
    if (children.length === 1) return { node: children[0], rendered, wasRendered };
    const sizes = sizeUpdates[node.group.id] ?? normalize(children.map(() => 1));
    return { node: { kind: "group", group: { ...node.group, children, sizes } }, rendered, wasRendered };
  });
  if (!rest.node || !placed.tree) return null;
  const restNode = rest.node;

  const built = foldTree<ArrangementNode, LayoutNode | null>(arrangement, arrangementChildren, (node, results) => {
    if (node.kind === "slot") return node.slot === "rest" ? restNode : (placed[node.slot] ?? null);
    // A pane this workspace lacks leaves its share to the rest, so the panes it has keep their sizes
    const { children, sizes } = presentChildren(node, results);
    if (children.length === 0) return null;
    if (children.length === 1) return children[0];
    const id = createGroupId();
    sizeUpdates[id] = sizes;
    return { kind: "group", group: { id, direction: node.direction, children, sizes } };
  });
  if (!built) return null;
  let nextRoot = built;
  // A Git pane the arrangement has no place for goes to the right instead of disappearing
  if (placed.git && countSlots(arrangement).git === 0) {
    const id = createGroupId();
    const sizes = [0.8, 0.2];
    sizeUpdates[id] = sizes;
    nextRoot = { kind: "group", group: { id, direction: "horizontal", children: [nextRoot, placed.git], sizes } };
  }
  return { root: nextRoot, sizeUpdates };
}
