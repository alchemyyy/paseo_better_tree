import assert from "node:assert/strict";
import { test } from "node:test";
import { appendGitignoreLine, gitignorePattern } from "../shared/gitignore.ts";

test("gitignorePattern anchors the path and matches only it", () => {
  assert.equal(gitignorePattern("src/build", true), "/src/build/");
  assert.equal(gitignorePattern("notes.txt", false), "/notes.txt");
  // Leading # and ! lose their meaning after the anchoring slash
  assert.equal(gitignorePattern("#todo.md", false), "/#todo.md");
});

test("gitignorePattern escapes glob characters, backslashes, and trailing spaces", () => {
  assert.equal(gitignorePattern("a*b?[c].txt", false), "/a\\*b\\?\\[c].txt");
  assert.equal(gitignorePattern("odd\\name", false), "/odd\\\\name");
  assert.equal(gitignorePattern("trail  ", false), "/trail\\ \\ ");
});

test("appendGitignoreLine adds a line once, keeping the file's line endings", () => {
  assert.equal(appendGitignoreLine("", "/a"), "/a\n");
  assert.equal(appendGitignoreLine("node_modules", "/a"), "node_modules\n/a\n");
  assert.equal(appendGitignoreLine("x\r\ny\r\n", "/a"), "x\r\ny\r\n/a\r\n");
  assert.equal(appendGitignoreLine("x\n/a\n", "/a"), null);
});
