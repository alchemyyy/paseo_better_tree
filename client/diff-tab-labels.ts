// NOTE: App-internal DOM augmentation of Paseo's workspace tab strip
// (packages/app/src/screens/workspace/workspace-desktop-tabs-row.tsx). Plugin panels get one fixed
// title, so diff tabs would all read "Diff"; this relabels each with its file name, colored by its
// git change, and puts the full path in its tooltip.
import { Platform } from "react-native";
import { lookupChange, subscribeGitStatus } from "./change-registry";
import { changeColor } from "./change-list";
import { DiffTabStateSchema, type DiffTabState } from "./diff-tabs";
import { TRACKED_COLOR, UNTRACKED_COLOR } from "./git-colors";
import { findLayoutStore, findPanelTabs, type LayoutStoreApi } from "./layout-guard";
import { DIFF_PANEL_IDS } from "./panel-ids";

interface DomNode {
  textContent: string | null;
  readonly style: { color: string };
  querySelector(selector: string): DomNode | null;
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
// React Native Web renders <Text> as an element with dir="auto"
const TEXT_SELECTOR = '[dir="auto"]';
const FIBER_KEY_PREFIX = "__reactFiber$";
const MAX_FIBER_DEPTH = 20;
// Tabs opened before staging stopped being a category may still say staged
const CATEGORY_COLORS = { tracked: TRACKED_COLOR, untracked: UNTRACKED_COLOR, staged: TRACKED_COLOR } as const;

interface FiberLike {
  return: FiberLike | null;
  memoizedProps?: Record<string, unknown> | null;
}

interface TabIdentity {
  workspaceKey: string;
  panelId: string;
}

/** The tab chip's own props (TabChip: serverId, workspaceId, tab); tooltips portal but keep the fiber chain */
function tabIdentity(node: DomNode, pluginId: string): TabIdentity | null {
  const record = node as unknown as Record<string, unknown>;
  const key = Object.keys(record).find((candidate) => candidate.startsWith(FIBER_KEY_PREFIX));
  let fiber = key ? (record[key] as FiberLike) : null;
  for (let depth = 0; fiber && depth < MAX_FIBER_DEPTH; depth++, fiber = fiber.return) {
    const props = fiber.memoizedProps;
    const tab = props?.tab as { target?: { kind?: string; pluginId?: string; panelId?: string } } | undefined;
    if (!tab?.target || typeof props?.serverId !== "string" || typeof props.workspaceId !== "string") continue;
    const { target } = tab;
    if (target.kind !== "plugin" || target.pluginId !== pluginId || !DIFF_PANEL_IDS.includes(target.panelId ?? "")) {
      return null;
    }
    return { workspaceKey: `${props.serverId}:${props.workspaceId}`, panelId: target.panelId ?? "" };
  }
  return null;
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1) || path;
}

/** Live status when a panel has loaded the worktree, else the category from when the tab opened */
function labelColor(state: DiffTabState): string {
  const file = lookupChange(state.worktree, state.path);
  if (file) return changeColor(file);
  if (file === null) return "";
  return state.category ? CATEGORY_COLORS[state.category] : "";
}

function setText(element: DomNode | null, text: string): void {
  if (element && element.textContent !== text) element.textContent = text;
}

/** Relabels diff tabs while the app runs on the web; returns the stop function */
export function startDiffTabLabels(pluginId: () => string): () => void {
  if (Platform.OS !== "web") return () => undefined;
  let store: LayoutStoreApi | null = null;
  let unsubscribeStore: (() => void) | null = null;

  const stateFor = (node: DomNode): DiffTabState | null => {
    const identity = tabIdentity(node, pluginId());
    if (!identity) return null;
    if (!store) {
      store = findLayoutStore(node);
      unsubscribeStore = store?.subscribe(schedule) ?? null;
    }
    if (!store) return null;
    const tab = findPanelTabs(store, identity.workspaceKey, pluginId(), [identity.panelId])[0];
    const parsed = DiffTabStateSchema.safeParse(tab?.state);
    return parsed.success ? parsed.data : null;
  };

  const scan = () => {
    for (const chip of Array.from(document.querySelectorAll(CHIP_SELECTOR))) {
      const state = stateFor(chip);
      if (!state) continue;
      const label = chip.querySelector(TEXT_SELECTOR);
      setText(label, baseName(state.path));
      const color = labelColor(state);
      if (label && label.style.color !== color) label.style.color = color;
    }
    for (const tooltip of Array.from(document.querySelectorAll(TOOLTIP_SELECTOR))) {
      const state = stateFor(tooltip);
      if (state) setText(tooltip.querySelector(TEXT_SELECTOR) ?? tooltip, state.path);
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
