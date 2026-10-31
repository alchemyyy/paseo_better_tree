// NOTE: The 0.13 plugin SDK cannot open Paseo file tabs or open a tab beside the Explorer.
// The app's PaneContext value (packages/app/src/panels/pane-context.tsx) can, and every plugin
// panel renders inside one, so this reads it from the React fiber tree. This is app-internal
// and may break on a Paseo upgrade; callers must treat a null bridge as "unavailable".

/** WorkspaceTabTarget subset this plugin opens */
export type PaneTarget =
  | { kind: "file"; path: string }
  | { kind: "plugin"; pluginId: string; panelId: string; context: "workspace" }
  | { kind: "agent"; agentId: string }
  | { kind: "draft"; draftId: string; setup?: { cwd?: string } };

export interface PaneBridge {
  serverId: string;
  workspaceId: string;
  host: string;
  tabId: string;
  target: PaneTarget;
  openTab(target: PaneTarget): void;
  openPreferredTarget(target: PaneTarget, source: string): void;
  /** Present only for Explorer-hosted panes on split-capable desktop layouts */
  openTargetToSide?: (target: PaneTarget) => void;
}

interface FiberLike {
  return: FiberLike | null;
  memoizedProps?: { value?: unknown } | null;
}

const FIBER_KEY_PREFIX = "__reactFiber$";
const MAX_FIBER_DEPTH = 400;

function getFiber(node: unknown): FiberLike | null {
  if (!node || typeof node !== "object") return null;
  const record = node as Record<string, unknown>;
  // Fabric host instances (native)
  if (record.__internalInstanceHandle) return record.__internalInstanceHandle as FiberLike;
  // react-dom host nodes (web)
  for (const key of Object.keys(record)) {
    if (key.startsWith(FIBER_KEY_PREFIX)) return record[key] as FiberLike;
  }
  return null;
}

function isPaneBridge(value: unknown): value is PaneBridge {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.openPreferredTarget === "function" &&
    typeof candidate.openTab === "function" &&
    typeof candidate.openFileInWorkspace === "function" &&
    typeof candidate.tabId === "string" &&
    typeof candidate.workspaceId === "string"
  );
}

/** The nearest PaneContext value above a host node, or null */
export function findPaneBridge(node: unknown): PaneBridge | null {
  let fiber = getFiber(node);
  for (let depth = 0; fiber && depth < MAX_FIBER_DEPTH; depth++) {
    const value = fiber.memoizedProps?.value;
    if (isPaneBridge(value)) return value;
    fiber = fiber.return;
  }
  return null;
}
