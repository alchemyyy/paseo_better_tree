export const TREE_PANEL_ID = "tree";
export const GIT_PANEL_ID = "git";

// Pinned folders open as extra tree views; like diff tabs they come from a fixed pool
export const TREE_VIEW_SLOT_COUNT = 6;
export const TREE_VIEW_PANEL_IDS: readonly string[] = Array.from(
  { length: TREE_VIEW_SLOT_COUNT },
  (_, index) => `tree-view-${index + 1}`,
);

/** Panels that own their pane: other tabs are moved out of it */
export const EXCLUSIVE_PANEL_IDS: ReadonlySet<string> = new Set([
  TREE_PANEL_ID,
  GIT_PANEL_ID,
  ...TREE_VIEW_PANEL_IDS,
]);

// Plugin workspace panels allow one tab each per workspace, so per-file diff tabs come from a
// fixed pool of identical panels. The file each tab shows lives in its tab state.
export const DIFF_SLOT_COUNT = 8;
export const DIFF_PANEL_IDS: readonly string[] = Array.from(
  { length: DIFF_SLOT_COUNT },
  (_, index) => `diff-${index + 1}`,
);

// Each commit opens in its own Commit tab, from a smaller pool: opening one past it reuses the
// tab whose commit was opened longest ago
export const COMMIT_SLOT_COUNT = 6;
export const COMMIT_PANEL_IDS: readonly string[] = Array.from(
  { length: COMMIT_SLOT_COUNT },
  (_, index) => `commit-${index + 1}`,
);
