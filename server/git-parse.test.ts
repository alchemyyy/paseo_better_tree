import assert from "node:assert/strict";
import { test } from "node:test";
import {
  countTextLines,
  parseLog,
  parseNumstatZ,
  parseRenamesZ,
  parseStatusZ,
  parseWorktreeList,
} from "./git-parse.ts";

test("parseWorktreeList reads branches, detached heads, and bare entries", () => {
  const output = [
    "worktree C:/repo",
    "HEAD aaa",
    "branch refs/heads/main",
    "",
    "worktree C:/repo-abc",
    "HEAD bbb",
    "detached",
    "",
    "worktree C:/gone",
    "HEAD ccc",
    "branch refs/heads/old",
    "prunable gitdir file points to non-existent location",
    "",
    "worktree C:/bare",
    "bare",
    "",
  ].join("\n");
  assert.deepEqual(parseWorktreeList(output), [
    { path: "C:/repo", head: "aaa", branch: "main", bare: false, prunable: false },
    { path: "C:/repo-abc", head: "bbb", branch: null, bare: false, prunable: false },
    { path: "C:/gone", head: "ccc", branch: "old", bare: false, prunable: true },
    { path: "C:/bare", head: "", branch: null, bare: true, prunable: false },
  ]);
});

test("parseRenamesZ maps renamed paths to their originals and skips other changes", () => {
  const output = "M\0src/a.ts\0R087\0old name.ts\0new name.ts\0C100\0x.ts\0y.ts\0D\0gone.ts\0";
  assert.deepEqual([...parseRenamesZ(output)], [["new name.ts", "old name.ts"]]);
});

test("parseStatusZ skips the original path of renames", () => {
  const output = " M src/a.ts\0R  new.ts\0old.ts\0?? notes.md\0MM both.ts\0";
  assert.deepEqual(parseStatusZ(output), [
    { path: "src/a.ts", index: " ", worktree: "M" },
    { path: "new.ts", index: "R", worktree: " " },
    { path: "notes.md", index: "?", worktree: "?" },
    { path: "both.ts", index: "M", worktree: "M" },
  ]);
});

test("parseNumstatZ handles renames and binary files", () => {
  const output = "3\t1\tsrc/a.ts\0" + "2\t0\t\0old.ts\0new.ts\0" + "-\t-\timage.png\0";
  assert.deepEqual(parseNumstatZ(output), [
    { path: "src/a.ts", additions: 3, deletions: 1 },
    { path: "new.ts", additions: 2, deletions: 0 },
    { path: "image.png", additions: 0, deletions: 0 },
  ]);
});

test("parseLog extracts local branches and HEAD", () => {
  const record = (fields: string[]) => `${fields.join("\x1f")}\x1e\n`;
  const output =
    record([
      "a".repeat(40),
      "aaaaaaa",
      "Ada",
      "1700000000",
      "Fix: things, stuff",
      "HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1",
    ]) + record(["b".repeat(40), "bbbbbbb", "Bob", "1600000000", "Init", ""]);
  const commits = parseLog(output);
  assert.equal(commits.length, 2);
  assert.deepEqual(commits[0].branches, ["main"]);
  assert.equal(commits[0].isHead, true);
  assert.equal(commits[0].subject, "Fix: things, stuff");
  assert.equal(commits[0].time, new Date(1700000000 * 1000).toISOString());
  assert.deepEqual(commits[1].branches, []);
  assert.equal(commits[1].isHead, false);
});

test("countTextLines counts a trailing partial line and ignores binary", () => {
  assert.equal(countTextLines(""), 0);
  assert.equal(countTextLines("a\nb\n"), 2);
  assert.equal(countTextLines("a\nb"), 2);
  assert.equal(countTextLines("a\0b"), 0);
});
