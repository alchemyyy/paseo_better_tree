import { Platform } from "react-native";
import type { TreeEntry } from "../shared/contracts";
import { findPaneBridge } from "./host-bridge";
import { createShortcutMatcher, type TreeCommand } from "./shortcuts";
import { movableInto, outermostPaths, parentPath, ROOT_PATH } from "./tree-model";

// This plugin typechecks without the DOM library. Declare only what this module uses.
interface DomEventTarget {
  addEventListener(type: string, listener: (event: never) => void, options?: unknown): void;
  removeEventListener(type: string, listener: (event: never) => void, options?: unknown): void;
}
interface DomElement extends DomEventTarget {
  draggable: boolean;
  parentElement: DomElement | null;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): { left: number; top: number };
  getClientRects(): { length: number };
  closest(selector: string): DomElement | null;
  matches(selector: string): boolean;
  contains(other: DomElement | null): boolean;
  querySelectorAll(selector: string): ArrayLike<DomElement>;
  tabIndex: number;
  style: { outline: string };
  focus(): void;
}
interface DomKeyboardEvent {
  target: DomElement | null;
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}
interface DomTextArea extends DomElement {
  value: string;
  selectionStart: number | null;
  selectionEnd: number | null;
  focus(): void;
  setSelectionRange(start: number, end: number): void;
  setRangeText(text: string, start: number, end: number, mode: "end"): void;
  dispatchEvent(event: unknown): boolean;
}
interface DomMouseEvent {
  target: DomElement | null;
  clientX: number;
  clientY: number;
  preventDefault(): void;
}
interface DomWheelEvent {
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  deltaX: number;
  deltaY: number;
  preventDefault(): void;
}
interface DomButtonEvent {
  target: DomElement | null;
  button: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}
interface DomFocusEvent {
  target: DomElement | null;
}
interface DomDataTransfer {
  types: ArrayLike<string>;
  effectAllowed: string;
  dropEffect: string;
  setData(type: string, data: string): void;
  setDragImage(image: DomLabel, x: number, y: number): void;
}
/** A throwaway element for a drag image */
interface DomLabel {
  textContent: string;
  style: { cssText: string };
  remove(): void;
}
interface DomDragEvent {
  target: DomElement | null;
  dataTransfer: DomDataTransfer | null;
  preventDefault(): void;
  stopPropagation(): void;
}
declare const document: DomEventTarget & {
  querySelectorAll(selector: string): ArrayLike<DomTextArea>;
  execCommand(command: string, showUi: boolean, value: string): boolean;
  createElement(tag: "div"): DomLabel;
  body: { appendChild(node: DomLabel): void };
};
declare const Event: new (type: string, init: { bubbles: boolean }) => unknown;
declare const navigator: { platform: string; userAgent: string };

/** Whether this client runs on macOS, where shortcuts use Cmd */
export function isMacClient(): boolean {
  return Platform.OS === "ios" || (Platform.OS === "web" && /Mac/i.test(navigator.platform || navigator.userAgent));
}

/** Composer textareas carry `data-composer-input` (packages/app/src/composer/input/input.tsx) */
const COMPOSER_SELECTOR = "[data-composer-input]";
const TREE_PATH_ATTRIBUTE = "data-tree-path";
const TREE_BODY_ATTRIBUTE = "data-tree-body";
const TREE_ACTION_ATTRIBUTE = "data-tree-action";
const TREE_DRAG_MIME = "application/x-paseo-better-tree";
/** A mouse wheel notch reports ~100px; trackpad pinches report many small deltas */
const WHEEL_STEP_DELTA = 50;
const MIDDLE_BUTTON = 1;

let lastFocusedComposer: DomTextArea | null = null;
let composerTrackingInstalled = false;

/** Remembers the last composer the user typed in, so attachments follow split panes */
export function installComposerTracking(): void {
  if (Platform.OS !== "web" || composerTrackingInstalled) return;
  composerTrackingInstalled = true;
  document.addEventListener(
    "focusin",
    (event: DomFocusEvent) => {
      if (event.target?.matches(COMPOSER_SELECTOR)) {
        lastFocusedComposer = event.target as DomTextArea;
      }
    },
    true,
  );
}

export interface ComposerTarget {
  /** Agent behind the composer, when the composer belongs to a running agent */
  agentId: string | null;
  /** Working directory chosen for a draft that has not been sent yet */
  draftCwd: string | null;
  insert(text: string): void;
}

function composerTargetFor(element: DomTextArea): ComposerTarget {
  const target = findPaneBridge(element)?.target;
  let agentId: string | null = null;
  let draftCwd: string | null = null;
  if (target?.kind === "agent") agentId = target.agentId;
  if (target?.kind === "draft") draftCwd = target.setup?.cwd ?? null;
  return { agentId, draftCwd, insert: (text) => insertIntoTextArea(element, text) };
}

function isVisible(element: DomElement): boolean {
  return element.getClientRects().length > 0;
}

function findComposerElement(): DomTextArea | null {
  const visible = Array.from(document.querySelectorAll(COMPOSER_SELECTOR)).filter(isVisible);
  return lastFocusedComposer && visible.includes(lastFocusedComposer)
    ? lastFocusedComposer
    : (visible[0] ?? null);
}

/** The visible composer to attach into, preferring the last one focused; null off web */
export function findComposerTarget(): ComposerTarget | null {
  if (Platform.OS !== "web") return null;
  const element = findComposerElement();
  return element ? composerTargetFor(element) : null;
}

// Section: composer text watching

export interface ComposerSnapshot {
  text: string;
  agentId: string | null;
  draftCwd: string | null;
}

// Paseo clears the composer after a send by assigning `value`, which fires no event, so a
// slow re-read backs up the input/focus/key events
const COMPOSER_RECHECK_MS = 1500;
const composerListeners = new Set<(snapshot: ComposerSnapshot | null) => void>();
const composerContexts = new WeakMap<DomTextArea, { agentId: string | null; draftCwd: string | null }>();
let composerWatchInstalled = false;
let composerRecheckTimer: ReturnType<typeof setInterval> | null = null;
let lastComposerSnapshot: ComposerSnapshot | null = null;
let lastComposerKey = "";

function readComposerSnapshot(): ComposerSnapshot | null {
  const element = findComposerElement();
  if (!element) return null;
  // The pane walk is the costly part and an element never changes panes, so cache it
  let context = composerContexts.get(element);
  if (!context) {
    const { agentId, draftCwd } = composerTargetFor(element);
    context = { agentId, draftCwd };
    composerContexts.set(element, context);
  }
  return { text: element.value, ...context };
}

function emitComposerSnapshot(): void {
  const snapshot = readComposerSnapshot();
  const key = snapshot ? `${snapshot.agentId}\n${snapshot.draftCwd}\n${snapshot.text}` : "";
  if (key === lastComposerKey) return;
  lastComposerKey = key;
  lastComposerSnapshot = snapshot;
  for (const listener of composerListeners) listener(snapshot);
}

/** Calls `listener` with the attach-target composer's text now and whenever it changes; web only */
export function subscribeComposerText(listener: (snapshot: ComposerSnapshot | null) => void): () => void {
  if (Platform.OS !== "web") return () => {};
  installComposerTracking();
  if (!composerWatchInstalled) {
    composerWatchInstalled = true;
    for (const type of ["input", "focusin", "keyup"]) {
      // Deferred so the composer's own handlers (and a send's reset) run first
      document.addEventListener(type, () => setTimeout(emitComposerSnapshot, 0), true);
    }
  }
  composerListeners.add(listener);
  composerRecheckTimer ??= setInterval(emitComposerSnapshot, COMPOSER_RECHECK_MS);
  emitComposerSnapshot();
  listener(lastComposerSnapshot);
  return () => {
    composerListeners.delete(listener);
    if (composerListeners.size === 0 && composerRecheckTimer) {
      clearInterval(composerRecheckTimer);
      composerRecheckTimer = null;
    }
  };
}

function insertIntoTextArea(element: DomTextArea, text: string): void {
  const wasLastFocused = element === lastFocusedComposer;
  element.focus();
  if (!wasLastFocused) element.setSelectionRange(element.value.length, element.value.length);
  const start = element.selectionStart ?? element.value.length;
  const end = element.selectionEnd ?? start;
  const before = element.value.slice(0, start);
  const insertion = `${before.length > 0 && !/\s$/.test(before) ? " " : ""}${text} `;
  // execCommand keeps native undo and fires the input event the uncontrolled composer listens to
  if (document.execCommand("insertText", false, insertion)) return;
  element.setRangeText(insertion, start, end, "end");
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Props that tag a row so DOM context-menu and drag events can find its path */
export function treeRowDataProps(path: string): object {
  return Platform.OS === "web" ? { dataSet: { treePath: path } } : {};
}

/** Props that tag the area holding the rows, where right-clicking blank space opens the root's menu */
export function treeBodyDataProps(): object {
  return Platform.OS === "web" ? { dataSet: { treeBody: "true" } } : {};
}

/** Props that tag a button inside a row, which keeps its own Ctrl and Shift clicks */
export function treeActionDataProps(): object {
  return Platform.OS === "web" ? { dataSet: { treeAction: "true" } } : {};
}

// dataSet keys of the Git panel rows with their own right-click menu, and the attributes
// react-native-web renders them as
const GIT_ROW_TAGS = {
  /** A changes list row, by its row key */
  change: { dataKey: "gitChange", attribute: "data-git-change" },
  /** A worktree row, by the worktree's path */
  worktree: { dataKey: "gitWorktree", attribute: "data-git-worktree" },
} as const;

export type GitRowKind = keyof typeof GIT_ROW_TAGS;

/** Props that tag a Git panel row of `kind` with `key`, for right-click */
export function gitRowDataProps(kind: GitRowKind, key: string): object {
  return Platform.OS === "web" ? { dataSet: { [GIT_ROW_TAGS[kind].dataKey]: key } } : {};
}

/**
 * Right-click on a tagged Git panel row of `kind` inside `node` calls `onMenu` with the row's key
 * and the point relative to `node`, instead of the browser menu. No-op off web.
 */
export function attachGitRowContextMenu(
  node: unknown,
  kind: GitRowKind,
  onMenu: (key: string, x: number, y: number) => void,
): () => void {
  if (Platform.OS !== "web" || !node) return () => {};
  const element = node as DomElement;
  const { attribute } = GIT_ROW_TAGS[kind];
  const listener = (event: DomMouseEvent) => {
    const key = event.target?.closest(`[${attribute}]`)?.getAttribute(attribute);
    if (key === null || key === undefined) return;
    event.preventDefault();
    const bounds = element.getBoundingClientRect();
    onMenu(key, event.clientX - bounds.left, event.clientY - bounds.top);
  };
  element.addEventListener("contextmenu", listener);
  return () => element.removeEventListener("contextmenu", listener);
}

/** Ref callback that makes a row a native drag source on web, or not while its name is edited */
export function setRowDraggable(node: unknown, draggable: boolean): void {
  if (Platform.OS !== "web" || !node) return;
  (node as DomElement).draggable = draggable;
}

export interface TreeDomHandlers {
  /** Right-click on a row, or on blank space in the tree body (`path` null) */
  onContextMenu(path: string | null, x: number, y: number): void;
  /** A shortcut while the tree has focus; returns whether it did anything, to claim the key */
  onCommand(command: TreeCommand): boolean;
  /** Ctrl+wheel: row spacing */
  onZoomStep(direction: 1 | -1): void;
  /** Shift+wheel: text weight */
  onWeightStep(direction: 1 | -1): void;
  /** Alt+wheel: text size */
  onSizeStep(direction: 1 | -1): void;
  /** Ctrl+middle click */
  onResetZoom(): void;
  /** Shift+middle click */
  onResetWeight(): void;
  /** Alt+middle click */
  onResetSize(): void;
  /** The row under the mouse, or null when the mouse leaves the tree */
  onHoverPath(path: string | null): void;
  /** Ctrl (Cmd on macOS)+click (`toggle`) or Shift+click (`range`) on a row, which selects it instead of opening it */
  onSelectPress(path: string, modifiers: { toggle: boolean; range: boolean }): void;
  /** A plain click on blank space in the tree body */
  onBlankPress(): void;
}

/** Turns wheel deltas into +1/-1 steps: one per notch, accumulated for trackpads */
function createWheelStepper(onStep: (direction: 1 | -1) => void): (delta: number) => void {
  let remainder = 0;
  return (delta) => {
    if (Math.abs(delta) >= WHEEL_STEP_DELTA) {
      remainder = 0;
      onStep(delta < 0 ? 1 : -1);
      return;
    }
    remainder += delta;
    if (Math.abs(remainder) < WHEEL_STEP_DELTA) return;
    onStep(remainder < 0 ? 1 : -1);
    remainder = 0;
  };
}

/**
 * Right-click, shortcuts, selecting clicks, modifier+wheel, and modifier+middle-click on the tree
 * root; a no-op off web. The root becomes focusable, so clicking anywhere in the tree gives it the
 * keyboard.
 */
export function attachTreeDomEvents(node: unknown, handlers: TreeDomHandlers): () => void {
  if (Platform.OS !== "web" || !node) return () => {};
  const element = node as DomElement;
  if (element.tabIndex < 0) element.tabIndex = 0;
  element.style.outline = "none";
  const mac = isMacClient();
  const matchShortcut = createShortcutMatcher(mac);
  const zoomStepper = createWheelStepper(handlers.onZoomStep);
  const weightStepper = createWheelStepper(handlers.onWeightStep);
  const sizeStepper = createWheelStepper(handlers.onSizeStep);
  const onWheel = (event: DomWheelEvent) => {
    // Non-passive so Chromium/Electron page zoom and Shift's horizontal scroll do not also run
    if (event.ctrlKey) {
      event.preventDefault();
      zoomStepper(event.deltaY);
      return;
    }
    if (event.shiftKey) {
      event.preventDefault();
      // Chromium reports Shift+wheel as horizontal scrolling
      weightStepper(event.deltaY !== 0 ? event.deltaY : event.deltaX);
      return;
    }
    if (event.altKey) {
      event.preventDefault();
      sizeStepper(event.deltaY !== 0 ? event.deltaY : event.deltaX);
    }
  };
  /** The row a Ctrl (Cmd on macOS) or Shift click selects; a row's buttons and name editor keep theirs */
  const selectingRow = (event: DomButtonEvent): string | null => {
    if (event.button !== 0 || !(event.shiftKey || (mac ? event.metaKey : event.ctrlKey))) return null;
    if (event.target?.closest(`input, textarea, [${TREE_ACTION_ATTRIBUTE}]`)) return null;
    return event.target?.closest(`[${TREE_PATH_ATTRIBUTE}]`)?.getAttribute(TREE_PATH_ATTRIBUTE) ?? null;
  };
  const onMouseDown = (event: DomButtonEvent) => {
    if (selectingRow(event) !== null) {
      // No text selection from Shift+click; the tree still takes the keyboard
      event.preventDefault();
      element.focus();
      return;
    }
    if (event.button !== MIDDLE_BUTTON) return;
    if (event.ctrlKey) handlers.onResetZoom();
    else if (event.shiftKey) handlers.onResetWeight();
    else if (event.altKey) handlers.onResetSize();
    else return;
    // Also stops Windows middle-click autoscroll
    event.preventDefault();
  };
  // Capture phase: react-native-web presses on click, so a row clicked to select never opens
  const onClick = (event: DomButtonEvent) => {
    const path = selectingRow(event);
    if (path !== null) {
      event.preventDefault();
      event.stopPropagation();
      handlers.onSelectPress(path, { toggle: mac ? event.metaKey : event.ctrlKey, range: event.shiftKey });
      return;
    }
    const plain = event.button === 0 && !event.shiftKey && !event.ctrlKey && !event.metaKey;
    if (plain && !event.target?.closest(`[${TREE_PATH_ATTRIBUTE}]`) && event.target?.closest(`[${TREE_BODY_ATTRIBUTE}]`)) {
      handlers.onBlankPress();
    }
  };
  const onContextMenu = (event: DomMouseEvent) => {
    const row = event.target?.closest(`[${TREE_PATH_ATTRIBUTE}]`);
    const path = row?.getAttribute(TREE_PATH_ATTRIBUTE) ?? null;
    if (path === null && !event.target?.closest(`[${TREE_BODY_ATTRIBUTE}]`)) return;
    event.preventDefault();
    const bounds = element.getBoundingClientRect();
    handlers.onContextMenu(path, event.clientX - bounds.left, event.clientY - bounds.top);
  };
  const onKeyDown = (event: DomKeyboardEvent) => {
    // Typing in a name editor keeps its own keys
    if (event.target?.closest("input, textarea, [contenteditable='true']")) return;
    const match = matchShortcut(
      {
        key: event.key,
        code: event.code,
        ctrl: event.ctrlKey,
        meta: event.metaKey,
        shift: event.shiftKey,
        alt: event.altKey,
      },
      Date.now(),
    );
    if (match === null || (match !== "pending" && !handlers.onCommand(match))) return;
    event.preventDefault();
    event.stopPropagation();
  };
  // One delegated listener instead of hover state on every row
  let hoveredPath: string | null = null;
  const reportHover = (path: string | null) => {
    if (path === hoveredPath) return;
    hoveredPath = path;
    handlers.onHoverPath(path);
  };
  const onMouseOver = (event: DomMouseEvent) => {
    reportHover(event.target?.closest(`[${TREE_PATH_ATTRIBUTE}]`)?.getAttribute(TREE_PATH_ATTRIBUTE) ?? null);
  };
  const onMouseLeave = () => reportHover(null);
  const wheelOptions = { passive: false };
  element.addEventListener("wheel", onWheel, wheelOptions);
  element.addEventListener("mousedown", onMouseDown);
  element.addEventListener("click", onClick, true);
  element.addEventListener("contextmenu", onContextMenu);
  element.addEventListener("keydown", onKeyDown);
  element.addEventListener("mouseover", onMouseOver);
  element.addEventListener("mouseleave", onMouseLeave);
  return () => {
    element.removeEventListener("wheel", onWheel, wheelOptions);
    element.removeEventListener("mousedown", onMouseDown);
    element.removeEventListener("click", onClick, true);
    element.removeEventListener("contextmenu", onContextMenu);
    element.removeEventListener("keydown", onKeyDown);
    element.removeEventListener("mouseover", onMouseOver);
    element.removeEventListener("mouseleave", onMouseLeave);
  };
}

/**
 * Calls `onOutside` when a press starts outside `node`, anywhere in the window. Listens in the
 * capture phase without consuming the event, so the press still reaches its target. No-op off web.
 */
export function onPressOutside(node: unknown, onOutside: () => void): () => void {
  if (Platform.OS !== "web" || !node) return () => {};
  const element = node as DomElement;
  const listener = (event: DomMouseEvent) => {
    if (!element.contains(event.target)) onOutside();
  };
  document.addEventListener("pointerdown", listener, true);
  return () => document.removeEventListener("pointerdown", listener, true);
}

/** Calls `onEscape` when Escape is pressed anywhere in the window. No-op off web. */
export function onEscapeKey(onEscape: () => void): () => void {
  if (Platform.OS !== "web") return () => {};
  const listener = (event: DomKeyboardEvent) => {
    if (event.key === "Escape") onEscape();
  };
  document.addEventListener("keydown", listener, true);
  return () => document.removeEventListener("keydown", listener, true);
}

/** Moves keyboard focus to a view, so tree shortcuts reach it. No-op off web. */
export function focusView(node: unknown): void {
  if (Platform.OS === "web" && node) (node as DomElement).focus();
}

interface DomPointerEvent {
  pointerId: number;
  button: number;
  clientX: number;
  clientY: number;
  preventDefault(): void;
  stopPropagation(): void;
}
interface DomCaptureElement extends DomElement {
  setPointerCapture(pointerId: number): void;
  releasePointerCapture(pointerId: number): void;
}

/** x: a divider between side-by-side panes, dragged left and right; y: between stacked ones */
export type DragAxis = "x" | "y";

export interface DragHandlers {
  onStart(): void;
  /** Pixels moved along the axis since the drag started */
  onMove(delta: number): void;
  onEnd(): void;
}

/**
 * Drag along `axis` on a divider using pointer capture, so pane-level gesture handlers in the app
 * cannot take the drag over. Returns null off web, where callers use PanResponder.
 */
export function attachDrag(node: unknown, axis: DragAxis, handlers: DragHandlers): (() => void) | null {
  if (Platform.OS !== "web" || !node) return null;
  const element = node as DomCaptureElement;
  let activePointer: number | null = null;
  let start = 0;
  const onPointerDown = (event: DomPointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    activePointer = event.pointerId;
    start = axis === "x" ? event.clientX : event.clientY;
    element.setPointerCapture(event.pointerId);
    handlers.onStart();
  };
  const onPointerMove = (event: DomPointerEvent) => {
    if (event.pointerId !== activePointer) return;
    event.preventDefault();
    handlers.onMove((axis === "x" ? event.clientX : event.clientY) - start);
  };
  const onPointerEnd = (event: DomPointerEvent) => {
    if (event.pointerId !== activePointer) return;
    activePointer = null;
    element.releasePointerCapture(event.pointerId);
    handlers.onEnd();
  };
  element.addEventListener("pointerdown", onPointerDown);
  element.addEventListener("pointermove", onPointerMove);
  element.addEventListener("pointerup", onPointerEnd);
  element.addEventListener("pointercancel", onPointerEnd);
  return () => {
    element.removeEventListener("pointerdown", onPointerDown);
    element.removeEventListener("pointermove", onPointerMove);
    element.removeEventListener("pointerup", onPointerEnd);
    element.removeEventListener("pointercancel", onPointerEnd);
  };
}

// Section: composer Changes pill

declare const window: DomEventTarget;

interface DomKeyEvent {
  target: DomElement | null;
  key: string;
  preventDefault(): void;
  stopPropagation(): void;
}

/** The composer's Changes (diff stat) pill (packages/app/src/composer/diff-stat-pill.tsx) */
const CHANGES_PILL_SELECTOR = '[data-testid="composer-diff-stat-pill"]';
// Every event react-native-web's press handling could read, so Paseo's onPress never fires
const PILL_PRESS_EVENTS = ["pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "touchend"];

/**
 * Sends presses on the composer's Changes pill to `onPress` with the pill's workspace instead of
 * Paseo's handler (Explorer on Changes, then the working diff). Window capture listeners run
 * before react-native-web's, which listen lower down. Hover is untouched. A no-op off web.
 */
export function interceptChangesPill(onPress: (workspaceId: string) => void): () => void {
  if (Platform.OS !== "web") return () => {};
  const pillOf = (target: DomElement | null) => target?.closest?.(CHANGES_PILL_SELECTOR) ?? null;
  const press = (pill: DomElement) => {
    const workspaceId = findPaneBridge(pill)?.workspaceId;
    if (workspaceId) onPress(workspaceId);
  };
  const swallow = (event: DomDragEvent) => {
    if (pillOf(event.target)) event.stopPropagation();
  };
  const onClick = (event: DomDragEvent) => {
    const pill = pillOf(event.target);
    if (!pill) return;
    event.stopPropagation();
    event.preventDefault();
    press(pill);
  };
  const onKeyDown = (event: DomKeyEvent) => {
    const pill = pillOf(event.target);
    if (!pill || (event.key !== "Enter" && event.key !== " ")) return;
    event.stopPropagation();
    event.preventDefault();
    press(pill);
  };
  for (const type of PILL_PRESS_EVENTS) window.addEventListener(type, swallow, true);
  window.addEventListener("click", onClick, true);
  window.addEventListener("keydown", onKeyDown, true);
  return () => {
    for (const type of PILL_PRESS_EVENTS) window.removeEventListener(type, swallow, true);
    window.removeEventListener("click", onClick, true);
    window.removeEventListener("keydown", onKeyDown, true);
  };
}

// Section: drag and drop

export interface TreeDragRegistration {
  getEntry(path: string): TreeEntry | null;
  /** What a drag from the row at `path` carries: the selection when it holds the row, else the row */
  dragEntries(path: string): TreeEntry[];
  /** Absolute path of a path relative to this tree view's folder */
  absolutePath(relativePath: string): string;
  /** Text other apps receive when the rows are dropped outside Paseo */
  plainText(entries: readonly TreeEntry[]): string;
  /** Folder the pointer would drop into, or null when nothing in this tree would accept */
  onDropTargetChange(directory: string | null): void;
  /** Moves `sources` (absolute, possibly from another tree view) into this tree's `toDirectory` */
  onMove(sources: string[], toDirectory: string): void;
  onDropIntoComposer(entries: TreeEntry[], composer: ComposerTarget): void;
}

interface RegisteredTree {
  element: DomElement;
  registration: TreeDragRegistration;
}

type DropTarget =
  | { kind: "tree"; tree: RegisteredTree; directory: string }
  | { kind: "chat"; paneTabId: string; target: DomElement };

const registeredTrees = new Set<RegisteredTree>();
let activeDrag: {
  tree: RegisteredTree;
  entries: TreeEntry[];
  /** Absolute paths a move takes: the entries less those inside another of them */
  sources: string[];
} | null = null;
let highlightedTree: RegisteredTree | null = null;
let dragListenersInstalled = false;

function carriesTreeDrag(event: DomDragEvent): boolean {
  const types = event.dataTransfer?.types;
  return Boolean(activeDrag && types && Array.from(types).includes(TREE_DRAG_MIME));
}

function findTree(target: DomElement | null): RegisteredTree | null {
  if (!target) return null;
  for (const tree of registeredTrees) {
    if (tree.element.contains(target)) return tree;
  }
  return null;
}

function resolveDropTarget(target: DomElement | null): DropTarget | null {
  const tree = findTree(target);
  if (tree) {
    const row = target?.closest(`[${TREE_PATH_ATTRIBUTE}]`);
    const path = row && tree.element.contains(row) ? row.getAttribute(TREE_PATH_ATTRIBUTE) : null;
    const entry = path === null ? null : tree.registration.getEntry(path);
    if (!entry) return { kind: "tree", tree, directory: ROOT_PATH };
    const directory = entry.kind === "directory" ? entry.path : parentPath(entry.path);
    return { kind: "tree", tree, directory };
  }
  const bridge = findPaneBridge(target);
  if (target && (bridge?.target.kind === "agent" || bridge?.target.kind === "draft")) {
    return { kind: "chat", paneTabId: bridge.tabId, target };
  }
  return null;
}

function canMoveTo(drop: Extract<DropTarget, { kind: "tree" }>): boolean {
  if (!activeDrag) return false;
  return movableInto(activeDrag.sources, drop.tree.registration.absolutePath(drop.directory)).length > 0;
}

/** The composer inside the chat pane holding `target` */
function findPaneComposer(target: DomElement, paneTabId: string): DomTextArea | null {
  for (let ancestor: DomElement | null = target; ancestor; ancestor = ancestor.parentElement) {
    for (const candidate of Array.from(ancestor.querySelectorAll(COMPOSER_SELECTOR))) {
      if (isVisible(candidate) && findPaneBridge(candidate)?.tabId === paneTabId) {
        return candidate as DomTextArea;
      }
    }
  }
  return null;
}

function setHighlight(tree: RegisteredTree | null, directory: string | null): void {
  if (highlightedTree && highlightedTree !== tree) {
    highlightedTree.registration.onDropTargetChange(null);
  }
  highlightedTree = tree;
  tree?.registration.onDropTargetChange(directory);
}

function endDrag(): void {
  setHighlight(null, null);
  activeDrag = null;
}

/** Shows "N items" under the pointer instead of the one row the drag started on */
function setCountDragImage(transfer: DomDataTransfer, count: number): void {
  const label = document.createElement("div");
  label.textContent = `${count} items`;
  label.style.cssText =
    "position:fixed;top:-100px;left:0;padding:3px 8px;border-radius:4px;background:#3a3a3a;color:#fff;font:12px system-ui,sans-serif";
  document.body.appendChild(label);
  transfer.setDragImage(label, 0, 0);
  // The browser has taken its picture of the label by now
  setTimeout(() => label.remove(), 0);
}

function onDragStart(event: DomDragEvent): void {
  const tree = findTree(event.target);
  const path = event.target?.closest(`[${TREE_PATH_ATTRIBUTE}]`)?.getAttribute(TREE_PATH_ATTRIBUTE);
  const entries = tree && path ? tree.registration.dragEntries(path) : [];
  if (!tree || entries.length === 0 || !event.dataTransfer) return;
  const paths = entries.map((entry) => entry.path);
  const sources = outermostPaths(paths).map((relativePath) => tree.registration.absolutePath(relativePath));
  activeDrag = { tree, entries, sources };
  event.dataTransfer.effectAllowed = "copyMove";
  event.dataTransfer.setData(TREE_DRAG_MIME, paths.join("\n"));
  event.dataTransfer.setData("text/plain", tree.registration.plainText(entries));
  if (entries.length > 1) setCountDragImage(event.dataTransfer, entries.length);
}

// Chat panes wrap the composer in Paseo's FileDropZone, which stops propagation and rejects
// unknown drag types. Capture-phase listeners on the document run first and claim tree drags.
function onDragOver(event: DomDragEvent): void {
  if (!carriesTreeDrag(event) || !event.dataTransfer) return;
  event.stopPropagation();
  const drop = resolveDropTarget(event.target);
  if (drop?.kind === "tree" && canMoveTo(drop)) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setHighlight(drop.tree, drop.directory);
    return;
  }
  setHighlight(null, null);
  if (drop?.kind === "chat") {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    return;
  }
  event.dataTransfer.dropEffect = "none";
}

function onDrop(event: DomDragEvent): void {
  if (!carriesTreeDrag(event) || !activeDrag) return;
  event.preventDefault();
  event.stopPropagation();
  const { tree: sourceTree, entries, sources } = activeDrag;
  const drop = resolveDropTarget(event.target);
  endDrag();
  if (drop?.kind === "tree") {
    const movable = movableInto(sources, drop.tree.registration.absolutePath(drop.directory));
    if (movable.length > 0) drop.tree.registration.onMove(movable, drop.directory);
    return;
  }
  if (drop?.kind === "chat") {
    const composer = findPaneComposer(drop.target, drop.paneTabId);
    if (composer) sourceTree.registration.onDropIntoComposer(entries, composerTargetFor(composer));
  }
}

// Keeps FileDropZone's enter/leave counter balanced for drags it never sees dropped
function onDragEnterOrLeave(event: DomDragEvent): void {
  if (carriesTreeDrag(event)) event.stopPropagation();
}

function installDragListeners(): void {
  if (dragListenersInstalled) return;
  dragListenersInstalled = true;
  document.addEventListener("dragstart", onDragStart, true);
  document.addEventListener("dragover", onDragOver, true);
  document.addEventListener("drop", onDrop, true);
  document.addEventListener("dragenter", onDragEnterOrLeave, true);
  document.addEventListener("dragleave", onDragEnterOrLeave, true);
  document.addEventListener("dragend", endDrag, true);
}

/** Makes a tree root a drag source and drop target; a no-op off web */
export function registerTreeDragAndDrop(
  node: unknown,
  registration: TreeDragRegistration,
): () => void {
  if (Platform.OS !== "web" || !node) return () => {};
  installDragListeners();
  const tree: RegisteredTree = { element: node as DomElement, registration };
  registeredTrees.add(tree);
  return () => {
    registeredTrees.delete(tree);
    if (highlightedTree === tree) highlightedTree = null;
    if (activeDrag?.tree === tree) activeDrag = null;
  };
}
