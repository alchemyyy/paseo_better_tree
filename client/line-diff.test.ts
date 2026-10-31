import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { diffLines } from "./line-diff.ts";

test("diffLines finds replacements, insertions, and deletions like git", () => {
  assert.deepEqual(diffLines(["a", "b", "c"], ["a", "b", "c"]), []);
  assert.deepEqual(diffLines(["a", "b", "c"], ["a", "x", "y", "c"]), [{ fromA: 1, toA: 2, fromB: 1, toB: 3 }]);
  assert.deepEqual(diffLines(["a", "b", "c", "d"], ["a", "d"]), [{ fromA: 1, toA: 3, fromB: 1, toB: 1 }]);
  assert.deepEqual(diffLines(["a", "c"], ["a", "b", "c", "e"]), [
    { fromA: 1, toA: 1, fromB: 1, toB: 2 },
    { fromA: 2, toA: 2, fromB: 3, toB: 4 },
  ]);
  assert.deepEqual(diffLines([], ["x"]), [{ fromA: 0, toA: 0, fromB: 0, toB: 1 }]);
});

test("diffLines keeps unchanged lines between scattered edits", () => {
  const original = Array.from({ length: 200 }, (_, index) => `line ${index}`);
  const current = original.slice();
  current.splice(150, 1, "changed 150");
  current.splice(20, 0, "new a", "new b");
  current.splice(5, 1);
  const blocks = diffLines(original, current);
  let added = 0;
  let removed = 0;
  for (const block of blocks) {
    added += block.toB - block.fromB;
    removed += block.toA - block.fromA;
  }
  assert.equal(blocks.length, 3);
  assert.equal(added, 3);
  assert.equal(removed, 2);
});

// The file that exposed the problem: git counts +584 -29, a character diff said +1818 -1263
const HEAD_SAMPLE = process.env.BT_DIFF_HEAD;
const WORK_SAMPLE = process.env.BT_DIFF_WORK;
test("diffLines matches git's counts on a large real rewrite", { skip: !HEAD_SAMPLE || !WORK_SAMPLE }, () => {
  const original = readFileSync(HEAD_SAMPLE!, "utf8").split("\n");
  const current = readFileSync(WORK_SAMPLE!, "utf8").split("\n");
  let added = 0;
  let removed = 0;
  for (const block of diffLines(original, current)) {
    added += block.toB - block.fromB;
    removed += block.toA - block.fromA;
  }
  assert.deepEqual({ added, removed }, { added: 584, removed: 29 });
});
