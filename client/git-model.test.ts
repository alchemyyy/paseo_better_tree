import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canCommit,
  chooseDiffSlot,
  chooseSlot,
  createStageTracker,
  defaultCommitMode,
  formatRelativeTime,
  parseUnifiedDiff,
  resizeFractions,
  withStaged,
} from "./git-model.ts";
import { fileCategory } from "./change-list.ts";

const file = (path: string, flags: { staged?: boolean; modified?: boolean; untracked?: boolean }) => ({
  path,
  staged: flags.staged ?? false,
  modified: flags.modified ?? false,
  untracked: flags.untracked ?? false,
  added: false,
  additions: 0,
  deletions: 0,
});

test("defaultCommitMode and canCommit follow what is staged and tracked", () => {
  const stagedFile = file("a", { staged: true });
  const modifiedFile = file("b", { modified: true });
  const untrackedFile = file("c", { untracked: true });
  assert.equal(defaultCommitMode([stagedFile, modifiedFile]), "staged");
  assert.equal(defaultCommitMode([modifiedFile]), "tracked");
  assert.equal(canCommit("staged", [modifiedFile], "msg"), false);
  assert.equal(canCommit("staged", [stagedFile], "  "), false);
  assert.equal(canCommit("staged", [stagedFile], "msg"), true);
  assert.equal(canCommit("tracked", [untrackedFile], "msg"), false);
  assert.equal(canCommit("tracked", [modifiedFile], "msg"), true);
  assert.equal(canCommit("amend", [], ""), true);
});

test("resizeFractions moves one divider and lets either side collapse", () => {
  const round = (values: number[]) => values.map((value) => Math.round(value * 100) / 100);
  assert.deepEqual(round(resizeFractions([0.25, 0.45, 0.3], 0, 0.1)), [0.35, 0.35, 0.3]);
  assert.deepEqual(round(resizeFractions([0.25, 0.45, 0.3], 1, 1)), [0.25, 0.75, 0]);
  assert.deepEqual(round(resizeFractions([0.25, 0.45, 0.3], 0, -1)), [0, 0.7, 0.3]);
});

test("parseUnifiedDiff numbers lines from hunk headers", () => {
  const diff = [
    "diff --git a/a.txt b/a.txt",
    "index 1..2 100644",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -3,3 +3,3 @@ heading",
    " keep",
    "-old",
    "+new",
    "\\ No newline at end of file",
    "",
  ].join("\n");
  const lines = parseUnifiedDiff(diff);
  assert.deepEqual(
    lines.map((line) => [line.kind, line.text, line.oldNumber, line.newNumber]),
    [
      ["meta", "diff --git a/a.txt b/a.txt", null, null],
      ["meta", "index 1..2 100644", null, null],
      ["meta", "--- a/a.txt", null, null],
      ["meta", "+++ b/a.txt", null, null],
      ["hunk", "@@ -3,3 +3,3 @@ heading", null, null],
      ["context", "keep", 3, 3],
      ["delete", "old", 4, null],
      ["add", "new", null, 4],
      ["meta", "\\ No newline at end of file", null, null],
    ],
  );
});

test("formatRelativeTime buckets elapsed time", () => {
  const now = Date.parse("2026-10-25T12:00:00Z");
  assert.equal(formatRelativeTime(null, now), "");
  assert.equal(formatRelativeTime("2026-10-25T11:59:30Z", now), "just now");
  assert.equal(formatRelativeTime("2026-10-25T11:55:00Z", now), "5m ago");
  assert.equal(formatRelativeTime("2026-10-25T09:00:00Z", now), "3h ago");
  assert.equal(formatRelativeTime("2026-10-22T12:00:00Z", now), "3d ago");
  assert.equal(formatRelativeTime("2025-10-01T12:00:00Z", now), "1y ago");
});

test("chooseSlot reuses the tab showing a key, then a free slot, then the oldest", () => {
  const slots = ["v1", "v2"];
  assert.equal(chooseSlot(slots, [{ panelId: "v1", key: "/a", openedAt: 5 }], "/a"), "v1");
  assert.equal(chooseSlot(slots, [{ panelId: "v1", key: "/a", openedAt: 5 }], "/b"), "v2");
  assert.equal(
    chooseSlot(
      slots,
      [
        { panelId: "v1", key: "/a", openedAt: 9 },
        { panelId: "v2", key: null, openedAt: 1 },
      ],
      "/c",
    ),
    "v2",
  );
});

test("chooseDiffSlot reuses the matching tab, then a free slot, then the oldest", () => {
  const slots = ["diff-1", "diff-2"];
  const spec = { worktree: "/r", path: "a.ts" };
  assert.equal(chooseDiffSlot(slots, [], spec), "diff-1");
  const tabs = [
    { panelId: "diff-1", spec: { worktree: "/r", path: "b.ts", openedAt: 20 } },
    { panelId: "diff-2", spec: { worktree: "/r", path: "a.ts", openedAt: 10 } },
  ];
  assert.equal(chooseDiffSlot(slots, tabs, spec), "diff-2");
  assert.equal(chooseDiffSlot(slots, tabs.slice(0, 1), { worktree: "/r", path: "c.ts" }), "diff-2");
  assert.equal(chooseDiffSlot(slots, tabs, { worktree: "/r", path: "c.ts" }), "diff-2");
});

test("withStaged flips a file the way git does and keeps it in its change group", () => {
  const untracked = file("new.txt", { untracked: true });
  const staged = withStaged(untracked, true);
  assert.deepEqual([staged.staged, staged.untracked, staged.added], [true, false, true]);
  assert.equal(fileCategory(staged), fileCategory(untracked));
  assert.deepEqual(withStaged(staged, false), { ...untracked });
  const edited = file("a.txt", { staged: true, modified: true });
  assert.deepEqual([withStaged(edited, true).staged, withStaged(edited, true).modified], [true, false]);
  assert.deepEqual([withStaged(edited, false).staged, withStaged(edited, false).modified], [false, true]);
  // Already as asked: the same object, so memoized rows do not re-render
  const modified = file("b.txt", { modified: true });
  assert.equal(withStaged(modified, false), modified);
});

test("createStageTracker shows only the newest answer and keeps a path with its latest toggle", () => {
  const tracker = createStageTracker();
  const first = tracker.begin(["a", "b"]);
  const second = tracker.begin(["b"]);
  // The later toggle answers first: its status is shown and b is released; a still waits
  assert.deepEqual(tracker.finish(second, ["b"], true), { apply: true, released: ["b"] });
  // The older answer arrives last: too old to show, but a was its own
  assert.deepEqual(tracker.finish(first, ["a", "b"], true), { apply: false, released: ["a"] });
  // A failed toggle shows nothing yet still gives its paths back
  const failed = tracker.begin(["c"]);
  assert.deepEqual(tracker.finish(failed, ["c"], false), { apply: false, released: ["c"] });
});
