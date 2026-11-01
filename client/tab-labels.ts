// NOTE: App-internal DOM augmentation of Paseo's workspace tab strip
// (packages/app/src/screens/workspace/workspace-desktop-tabs-row.tsx). Plugin panels get one fixed
// title, so every diff tab would read "Diff" and every commit tab "Commit". This relabels a diff
// tab with its file name, colored by its git change, and a commit tab with its subject, putting the
// full path or the commit in the tooltip. The strip sizes each tab from a hidden copy of its label
// (TabLabelMeasurement), which gets the same text, so a relabeled tab fits its label as file tabs do.
import { Platform } from "react-native";
import { lookupChange, subscribeGitStatus } from "./change-registry";
import { changeColor } from "./change-list";
import { CommitTabStateSchema } from "./commit-tabs";
import { DiffTabStateSchema, type DiffTabState } from "./diff-tabs";
import { TRACKED_COLOR, UNTRACKED_COLOR } from "./git-colors";
import { findLayoutStore, findPanelTabs, type LayoutStoreApi } from "./layout-guard";
import { COMMIT_PANEL_IDS, DIFF_PANEL_IDS } from "./panel-ids";

interface DomNode {
  textContent: string | null;
  readonly style: { color: string };
  querySelector(selector: string): DomNode | null;
  querySelectorAll(selector: string): ArrayLike<DomNode>;
}
declare const document: { body: DomNode; querySelectorAll(selector: string): ArrayLike<DomNode> };
declare class MutationObserver {
  constructor(callback: () => void);
  observe(target: DomNode, options: { childList: boolean; subtree: boolean; characterData: boolean }): void;
  disconnect(): void;
}
declare function requestAnimationFrame(callback: () => void): number;

const CHIP_SELECTOR = '[data-testid^="workspace-tab-plugin_workspace_"]';
const TOOLTIP_SELECTOR = '[data-testid^="workspace-tab-tooltip-plugin_workspace_"]';
const ROW_SELECTOR = '[data-testid="workspace-tabs-row"]';
// React Native Web renders <Text> as an element with dir="auto"
const TEXT_SELECTOR = '[dir="auto"]';
const FIBER_KEY_PREFIX = "__reactFiber$";
const MAX_FIBER_DEPTH = 20;
// A hidden label's host node sits six fibers under its TabLabelMeasurement in Paseo 0.14
const MAX_MEASUREMENT_DEPTH = 8;
// Tabs opened before staging stopped being a category may still say staged
const CATEGORY_COLORS = { tracked: TRACKED_COLOR, untracked: UNTRACKED_COLOR, staged: TRACKED_COLOR } as const;
const COMMIT_PANEL_ID_SET: ReadonlySet<string> = new Set(COMMIT_PANEL_IDS);
const RELABELED_PANEL_IDS: ReadonlySet<string> = new Set([...DIFF_PANEL_IDS, ...COMMIT_PANEL_IDS]);

interface FiberLike {
  return: FiberLike | null;
  memoizedProps?: Record<string, unknown> | null;
}

interface TabIdentity {
  workspaceKey: string;
  panelId: string;
  /** The strip's key for the tab, which its hidden label is measured under */
  key: string | null;
}

interface TabLabel {
  text: string;
  /** Empty for the strip's own color */
  color: string;
  tooltip: string;
}

function fiberOf(node: DomNode): FiberLike | null {
  const record = node as unknown as Record<string, unknown>;
  const key = Object.keys(record).find((candidate) => candidate.startsWith(FIBER_KEY_PREFIX));
  return key ? (record[key] as FiberLike) : null;
}

/** The tab chip's own props (TabChip: serverId, workspaceId, tab); tooltips portal but keep the fiber chain */
function tabIdentity(node: DomNode, pluginId: string): TabIdentity | null {
  let fiber = fiberOf(node);
  for (let depth = 0; fiber && depth < MAX_FIBER_DEPTH; depth++, fiber = fiber.return) {
    const props = fiber.memoizedProps;
    const tab = props?.tab as { key?: unknown; target?: { kind?: string; pluginId?: string; panelId?: string } } | undefined;
    if (!tab?.target || typeof props?.serverId !== "string" || typeof props.workspaceId !== "string") continue;
    const { target } = tab;
    if (target.kind !== "plugin" || target.pluginId !== pluginId || !RELABELED_PANEL_IDS.has(target.panelId ?? "")) {
      return null;
    }
    return {
      workspaceKey: `${props.serverId}:${props.workspaceId}`,
      panelId: target.panelId ?? "",
      key: typeof tab.key === "string" ? tab.key : null,
    };
  }
  return null;
}

/** The tab key a hidden measurement label stands for, or null for any other text */
function measuredTabKey(node: DomNode): string | null {
  let fiber = fiberOf(node);
  for (let depth = 0; fiber && depth < MAX_MEASUREMENT_DEPTH; depth++, fiber = fiber.return) {
    const props = fiber.memoizedProps;
    if (typeof props?.tabKey === "string" && typeof props.onMeasure === "function") return props.tabKey;
  }
  return null;
}

/** Live status when a panel has loaded the worktree, else the category from when the tab opened */
function diffLabelColor(state: DiffTabState): string {
  const file = lookupChange(state.worktree, state.path);
  if (file) return changeColor(file);
  if (file === null) return "";
  return state.category ? CATEGORY_COLORS[state.category] : "";
}

function labelFor(panelId: string, state: unknown): TabLabel | null {
  if (COMMIT_PANEL_ID_SET.has(panelId)) {
    const parsed = CommitTabStateSchema.safeParse(state);
    if (!parsed.success) return null;
    const { shortSha, subject } = parsed.data;
    return { text: subject || shortSha, color: "", tooltip: `${shortSha} ${subject}` };
  }
  const parsed = DiffTabStateSchema.safeParse(state);
  if (!parsed.success) return null;
  const { path } = parsed.data;
  return { text: path.slice(path.lastIndexOf("/") + 1) || path, color: diffLabelColor(parsed.data), tooltip: path };
}

function setText(element: DomNode | null, text: string): void {
  if (element && element.textContent !== text) element.textContent = text;
}

/** Relabels diff and commit tabs while the app runs on the web; returns the stop function */
export function startTabLabels(pluginId: () => string): () => void {
  if (Platform.OS !== "web") return () => undefined;
  let store: LayoutStoreApi | null = null;
  let unsubscribeStore: (() => void) | null = null;

  const resolve = (node: DomNode): { identity: TabIdentity; label: TabLabel } | null => {
    const identity = tabIdentity(node, pluginId());
    if (!identity) return null;
    if (!store) {
      store = findLayoutStore(node);
      unsubscribeStore = store?.subscribe(schedule) ?? null;
    }
    if (!store) return null;
    const tab = findPanelTabs(store, identity.workspaceKey, pluginId(), [identity.panelId])[0];
    const label = labelFor(identity.panelId, tab?.state);
    return label ? { identity, label } : null;
  };

  const scan = () => {
    // Tab key -> label, for the hidden copies the strip measures
    const measured = new Map<string, string>();
    for (const chip of Array.from(document.querySelectorAll(CHIP_SELECTOR))) {
      const resolved = resolve(chip);
      if (!resolved) continue;
      const { identity, label } = resolved;
      const text = chip.querySelector(TEXT_SELECTOR);
      setText(text, label.text);
      if (text && text.style.color !== label.color) text.style.color = label.color;
      if (identity.key !== null) measured.set(identity.key, label.text);
    }
    for (const tooltip of Array.from(document.querySelectorAll(TOOLTIP_SELECTOR))) {
      const resolved = resolve(tooltip);
      if (resolved) setText(tooltip.querySelector(TEXT_SELECTOR) ?? tooltip, resolved.label.tooltip);
    }
    if (measured.size === 0) return;
    for (const row of Array.from(document.querySelectorAll(ROW_SELECTOR))) {
      for (const text of Array.from(row.querySelectorAll(TEXT_SELECTOR))) {
        const key = measuredTabKey(text);
        const label = key === null ? undefined : measured.get(key);
        if (label !== undefined) setText(text, label);
      }
    }
  };

  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      scan();
    });
  }
  // Our own text writes trigger the observer once more, but the second scan changes nothing
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  const unsubscribeStatus = subscribeGitStatus(schedule);
  scan();
  return () => {
    observer.disconnect();
    unsubscribeStatus();
    unsubscribeStore?.();
  };
}
