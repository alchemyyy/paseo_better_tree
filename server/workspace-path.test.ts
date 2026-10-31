import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { normalizeRelativePath, resolveInsideRoot } from "./workspace-path.ts";

const root = path.resolve("workspace-root");

test("normalizeRelativePath strips dots and separators", () => {
  assert.equal(normalizeRelativePath("./src\\lib/"), "src/lib");
  assert.equal(normalizeRelativePath("."), "");
});

test("resolveInsideRoot accepts paths inside the root", () => {
  assert.equal(resolveInsideRoot(root, ""), root);
  assert.equal(resolveInsideRoot(root, "src/a.ts"), path.join(root, "src", "a.ts"));
  assert.equal(resolveInsideRoot(root, "..hidden"), path.join(root, "..hidden"));
});

test("resolveInsideRoot rejects escapes", () => {
  assert.throws(() => resolveInsideRoot(root, "../outside"));
  assert.throws(() => resolveInsideRoot(root, "src/../../outside"));
});
