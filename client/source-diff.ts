// NOTE: App-internal DOM augmentation of Paseo's Source file panel
// (packages/app/src/file-panels/source/toolbar.tsx and editor/view.web.tsx). A view selector goes
// beside "Ln, Col"; diff modes hide the app's editor and render the plugin's diff view in its place.
import { Platform } from "react-native";
import type { DiffMode } from "../shared/diff-contracts";
import { type DiffViewHandle, type EditorLook, mountDiffView } from "./diff-editor";
import { findPaneBridge } from "./host-bridge";
import { closeOriginalSide, openOriginalSide } from "./split-panes";
import { joinSplit } from "./split-sync";

interface DomNode {
  readonly isConnected: boolean;
  readonly parentElement: DomNode | null;
  readonly firstChild: DomNode | null;
  readonly children: ArrayLike<DomNode>;
  className: string;
  textContent: string | null;
  value: string;
  readonly style: { display: string; cssText: string; setProperty(name: string, value: string): void };
  querySelector(selector: string): DomNode | null;
  querySelectorAll(selector: string): ArrayLike<DomNode>;
  insertBefore(node: DomNode, reference: DomNode | null): void;
  appendChild(node: DomNode): void;
  after(node: DomNode): void;
  remove(): void;
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, listener: () => void): void;
}
interface ComputedStyle {
  backgroundColor: string;
  color: string;
  fontFamily: string;
  fontSize: string;
  lineHeight: string;
}
declare const document: { body: DomNode; createElement(tag: string): DomNode; querySelectorAll(selector: string): ArrayLike<DomNode> };
declare const window: { getComputedStyle(element: DomNode): ComputedStyle };
declare class MutationObserver {
  constructor(callback: () => void);
  observe(target: DomNode, options: { childList: boolean; subtree: boolean }): void;
  disconnect(): void;
}
declare function requestAnimationFrame(callback: () => void): number;

const BAR_SELECTOR = '[data-testid="file-panel-bar"]';
const SELECT_MARKER = "data-better-tree-diff-mode";
const REFRESH_INTERVAL_MS = 3000;
const EDITOR_SEARCH_DEPTH = 8;
const MODE_LABELS: Record<DiffMode, string> = {
  source: "Source",
  unified: "Unified diff",
  changes: "Changes only",
  split: "Split diff",
};

export interface SourceDiffSources {
  absolutePath: string;
  original: string | null;
  current: string | null;
}

interface Augmented {
  bar: DomNode;
  select: DomNode;
  fileKey: string;
  path: string;
  workspaceId: string;
  mode: DiffMode;
  /** Increments per mode change so a stale load cannot mount */
  generation: number;
  host: DomNode | null;
  container: DomNode | null;
  handle: DiffViewHandle | null;
  sources: { original: string; current: string } | null;
  leaveSplit: (() => void) | null;
  refreshTimer: ReturnType<typeof setInterval> | null;
}

/** Last mode per file, so a tab that remounts (or reopens) keeps its view */
const modeByFile = new Map<string, DiffMode>();

function luminance(color: string): number {
  const parts = color.match(/[\d.]+/g)?.map(Number) ?? [];
  const [red = 0, green = 0, blue = 0] = parts;
  return (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
}

function isTransparent(color: string): boolean {
  return color === "transparent" || /rgba\([^)]*,\s*0\)$/.test(color);
}

/** Colors and type of the app's editor, read from its DOM */
function lookFromEditor(host: DomNode): EditorLook {
  const editor = host.querySelector(".cm-editor") ?? host;
  const content = host.querySelector(".cm-content") ?? editor;
  const gutters = host.querySelector(".cm-gutters");
  const editorStyle = window.getComputedStyle(editor);
  const contentStyle = window.getComputedStyle(content);
  let background = editorStyle.backgroundColor;
  for (let node: DomNode | null = host; node && isTransparent(background); node = node.parentElement) {
    background = window.getComputedStyle(node).backgroundColor;
  }
  const gutterStyle = gutters ? window.getComputedStyle(gutters) : null;
  const foreground = contentStyle.color || editorStyle.color;
  return {
    dark: luminance(foreground) > luminance(background),
    background,
    foreground,
    mutedForeground: gutterStyle?.color ?? foreground,
    gutterBackground: gutterStyle && !isTransparent(gutterStyle.backgroundColor) ? gutterStyle.backgroundColor : background,
    fontFamily: contentStyle.fontFamily,
    fontSize: contentStyle.fontSize,
    lineHeight: contentStyle.lineHeight,
  };
}

/** The element the app mounted its editor into, near the toolbar */
function findEditorHost(bar: DomNode): DomNode | null {
  let node: DomNode | null = bar.parentElement;
  for (let depth = 0; node && depth < EDITOR_SEARCH_DEPTH; depth++, node = node.parentElement) {
    const editor = node.querySelector(".cm-editor");
    if (editor?.parentElement) return editor.parentElement;
  }
  return null;
}

/** The toolbar's status group (cursor position), where the selector goes */
function findStatusGroup(bar: DomNode): DomNode | null {
  let row: DomNode | null = bar;
  while (row && row.children.length === 1) row = row.children[0];
  return row && row.children.length >= 2 ? row.children[1] : null;
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** The first non-transparent background at or above `node` */
function solidBackground(node: DomNode): string {
  let background = "transparent";
  for (let current: DomNode | null = node; current && isTransparent(background); current = current.parentElement) {
    background = window.getComputedStyle(current).backgroundColor;
  }
  return background;
}

/**
 * The toolbar's own theme: its file-size text (always present, unlike "Ln, Col" which a preview
 * view drops) and the background it sits on, which decides light or dark.
 */
function toolbarLook(bar: DomNode): { color: string; background: string; dark: boolean } {
  // React Native Web colors its Text elements, not the views around them
  const text = bar.querySelector('[dir="auto"]') ?? bar;
  const color = window.getComputedStyle(text).color;
  const background = solidBackground(bar);
  return { color, background, dark: luminance(color) > luminance(background) };
}

function createSelect(look: { color: string; background: string; dark: boolean }): DomNode {
  const select = document.createElement("select");
  select.setAttribute(SELECT_MARKER, "");
  select.setAttribute("aria-label", "File view");
  select.setAttribute("title", "File view");
  for (const [value, label] of Object.entries(MODE_LABELS)) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  }
  select.style.cssText = [
    "font-size: 11px",
    "font-family: inherit",
    `color: ${look.color}`,
    // The closed control and its opened option list both follow the toolbar's theme
    `color-scheme: ${look.dark ? "dark" : "light"}`,
    `background-color: ${look.background}`,
    "border: 1px solid color-mix(in srgb, currentColor 25%, transparent)",
    "border-radius: 4px",
    "padding: 0 4px",
    "height: 20px",
    "margin-right: 8px",
    "cursor: pointer",
    // Electron's titlebar drag region would otherwise swallow the click
    "-webkit-app-region: no-drag",
  ].join(";");
  return select;
}

function showMessage(container: DomNode, text: string, color: string): void {
  container.textContent = text;
  container.style.setProperty("padding", "16px");
  container.style.setProperty("color", color);
  container.style.setProperty("font-size", "13px");
}

/**
 * Adds a Source / Unified diff / Changes only / Split diff selector to every Source file panel.
 * Returns the stop function. A no-op off web.
 */
export function startSourceDiff(
  loadSources: (path: string, workspaceId: string) => Promise<SourceDiffSources>,
): () => void {
  if (Platform.OS !== "web") return () => {};
  const augmented = new Map<DomNode, Augmented>();

  const clearDiff = (entry: Augmented) => {
    if (entry.refreshTimer) clearInterval(entry.refreshTimer);
    entry.refreshTimer = null;
    entry.leaveSplit?.();
    entry.leaveSplit = null;
    entry.handle?.destroy();
    entry.handle = null;
    entry.container?.remove();
    entry.container = null;
    if (entry.host) entry.host.style.display = "";
    entry.host = null;
    entry.sources = null;
  };

  const setMode = async (entry: Augmented, mode: DiffMode) => {
    const previous = entry.mode;
    entry.mode = mode;
    entry.generation++;
    const generation = entry.generation;
    modeByFile.set(entry.fileKey, mode);
    entry.select.value = mode;
    clearDiff(entry);
    if (previous === "split" && mode !== "split") closeOriginalSide(entry.bar, entry.fileKey);
    if (mode === "source") return;

    const host = findEditorHost(entry.bar);
    if (!host) {
      // Preview views (Markdown, HTML) have no editor to stand in for
      entry.mode = "source";
      entry.select.value = "source";
      return;
    }
    const look = lookFromEditor(host);
    const container = document.createElement("div");
    container.className = host.className;
    container.style.cssText = host.style.cssText;
    container.style.setProperty("display", "flex");
    container.style.setProperty("flex-direction", "column");
    host.after(container);
    host.style.display = "none";
    entry.host = host;
    entry.container = container;

    let sources: SourceDiffSources;
    try {
      sources = await loadSources(entry.path, entry.workspaceId);
    } catch (error) {
      if (generation === entry.generation) showMessage(container, error instanceof Error ? error.message : String(error), look.mutedForeground);
      return;
    }
    if (generation !== entry.generation) return;
    if (sources.current === null) {
      showMessage(container, "This file cannot be shown as a diff (binary, deleted, or too large).", look.mutedForeground);
      return;
    }
    if (sources.original === null) {
      showMessage(container, "This file is not in a Git repository, so there is nothing to compare.", look.mutedForeground);
      return;
    }
    entry.sources = { original: sources.original, current: sources.current };
    const handle = mountDiffView(container, {
      original: sources.original,
      current: sources.current,
      filename: basename(sources.absolutePath),
      mode: mode === "split" ? "current" : mode,
      look,
    });
    entry.handle = handle;
    if (handle && mode === "split") {
      entry.leaveSplit = joinSplit(entry.fileKey, "current", handle, () => entry.sources ?? { original: "", current: "" });
      openOriginalSide(entry.bar, entry.fileKey, sources.absolutePath);
    }
    // Agents edit files underneath; keep the diff current
    entry.refreshTimer = setInterval(() => {
      void loadSources(entry.path, entry.workspaceId)
        .then((next) => {
          if (generation !== entry.generation || next.current === null || next.original === null) return;
          entry.sources = { original: next.original, current: next.current };
          entry.handle?.setSources(next.original, next.current);
        })
        .catch(() => undefined);
    }, REFRESH_INTERVAL_MS);
  };

  const attach = (bar: DomNode) => {
    const bridge = findPaneBridge(bar);
    if (!bridge || bridge.target.kind !== "file") return;
    const status = findStatusGroup(bar);
    if (!status) return;
    const path = bridge.target.path;
    const fileKey = `${bridge.serverId}:${bridge.workspaceId}|${path}`;
    const select = createSelect(toolbarLook(bar));
    status.insertBefore(select, status.firstChild);
    const entry: Augmented = {
      bar,
      select,
      fileKey,
      path,
      workspaceId: bridge.workspaceId,
      mode: "source",
      generation: 0,
      host: null,
      container: null,
      handle: null,
      sources: null,
      leaveSplit: null,
      refreshTimer: null,
    };
    select.addEventListener("change", () => void setMode(entry, select.value as DiffMode));
    augmented.set(bar, entry);
    const remembered = modeByFile.get(fileKey);
    if (remembered && remembered !== "source") void setMode(entry, remembered);
  };

  const scan = () => {
    for (const bar of Array.from(document.querySelectorAll(BAR_SELECTOR))) {
      const entry = augmented.get(bar);
      if (!entry) {
        attach(bar);
        continue;
      }
      // React re-rendered the status group without our selector; put it back
      if (!entry.select.isConnected) {
        const status = findStatusGroup(bar);
        status?.insertBefore(entry.select, status.firstChild);
      }
    }
    for (const [bar, entry] of augmented) {
      if (bar.isConnected) continue;
      // The file tab closed or unmounted; its split's original pane goes with it
      if (entry.mode === "split") closeOriginalSide(bar, entry.fileKey);
      clearDiff(entry);
      augmented.delete(bar);
    }
  };

  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      scan();
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
  scan();
  return () => {
    observer.disconnect();
    for (const entry of augmented.values()) {
      clearDiff(entry);
      entry.select.remove();
    }
    augmented.clear();
  };
}
