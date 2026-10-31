import assert from "node:assert/strict";
import { test } from "node:test";
import { applyChunks, canShowInline, type ChunkRange, type DiffChunk, lineHighlights, mapPosition, unchangedSpans } from "./diff-map.ts";

test("lineHighlights keeps character marks only on partially edited lines", () => {
  const lines = [
    { from: 0, to: 14, text: "int tail = 30;" },
    { from: 15, to: 29, text: "  if (x) go();" },
  ];
  // "30" became "300", and the whole second line is new (indentation aside)
  const changes = [
    { from: 12, to: 13 },
    { from: 17, to: 29 },
  ];
  assert.deepEqual(lineHighlights(lines, changes), [
    { lineFrom: 0, whole: false, ranges: [{ from: 12, to: 13 }] },
    { lineFrom: 15, whole: true, ranges: [] },
  ]);
});

// A: "aa\nbb\ncc\n", B: "aa\nXX\nYY\ncc\n" (line "bb" replaced by two lines)
const chunks = [{ fromA: 3, toA: 6, fromB: 3, toB: 9 }];

test("mapPosition carries offsets around a changed region", () => {
  assert.equal(mapPosition(chunks, 0, "a"), 0);
  assert.equal(mapPosition(chunks, 4, "a"), 3);
  assert.equal(mapPosition(chunks, 6, "a"), 9);
  assert.equal(mapPosition(chunks, 9, "b"), 6);
  assert.equal(mapPosition(chunks, 5, "b"), 3);
  assert.equal(mapPosition([], 7, "b"), 7);
});

test("canShowInline keeps light edits and reflows inline, heavy rewrites as blocks", () => {
  const chunkOf = (original: string, current: string, changes: ChunkRange[]): DiffChunk => ({
    fromA: 0,
    toA: original.length,
    fromB: 0,
    toB: current.length,
    changes,
  });
  // "// a b c d" reflowed into "// a b X c\n// d"
  const reflowA = "// alpha beta gamma delta\n";
  const reflowB = "// alpha beta NEW gamma\n// delta\n";
  const reflow = chunkOf(reflowA, reflowB, [
    { fromA: 14, toA: 14, fromB: 14, toB: 18 },
    { fromA: 19, toA: 20, fromB: 23, toB: 27 },
  ]);
  assert.equal(canShowInline(reflow, reflowA, reflowB), true);
  const rewriteA = "int x = compute();\n";
  const rewriteB = "return finalize(y);\n";
  const rewrite = chunkOf(rewriteA, rewriteB, [{ fromA: 0, toA: 18, fromB: 0, toB: 19 }]);
  assert.equal(canShowInline(rewrite, rewriteA, rewriteB), false);
  assert.equal(canShowInline(chunkOf("", "new\n", []), "", "new\n"), false);
});

test("applyChunks replaces only the given chunks", () => {
  assert.equal(
    applyChunks("a\nb\nc\nd\n", "a\nB\nc\nD\n", [{ fromA: 2, toA: 4, fromB: 2, toB: 4 }]),
    "a\nB\nc\nd\n",
  );
});

test("unchangedSpans folds lines away from changes", () => {
  // 20 lines of 2 characters each ("x\n"); one change on line 10
  const lineAt = (position: number) => Math.floor(position / 2) + 1;
  const chunk = { fromA: 18, toA: 20, fromB: 18, toB: 20 };
  assert.deepEqual(unchangedSpans([chunk], lineAt, 20, 40, { margin: 3, minSize: 4 }), [
    { first: 1, last: 6 },
    { first: 14, last: 20 },
  ]);
  assert.deepEqual(unchangedSpans([], lineAt, 20, 40, { margin: 1, minSize: 2 }), [{ first: 1, last: 20 }]);
});
