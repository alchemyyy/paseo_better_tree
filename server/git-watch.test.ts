import assert from "node:assert/strict";
import { test } from "node:test";
import { watchEventKind } from "./git-watch.ts";

test("watchEventKind ignores object writes in the worktree's .git and in an outside git directory", () => {
  assert.equal(watchEventKind(".git/objects/ab/cdef", false), "ignore");
  assert.equal(watchEventKind(".git\\objects\\pack\\pack-1.idx", false), "ignore");
  assert.equal(watchEventKind(".git/objects", false), "ignore");
  assert.equal(watchEventKind("objects/ab/cdef", true), "ignore");
  assert.equal(watchEventKind("objects\\info", true), "ignore");
});

test("watchEventKind marks HEAD, ref, and reflog writes as refs changes", () => {
  for (const name of ["HEAD", "ORIG_HEAD", "FETCH_HEAD", "packed-refs", "refs/heads/main", "refs\\tags\\v1", "logs/HEAD", "refs"]) {
    assert.equal(watchEventKind(name, true), "refs", name);
    assert.equal(watchEventKind(`.git/${name}`, false), "refs", name);
  }
  assert.equal(watchEventKind(".git\\refs\\heads\\main", false), "refs");
});

test("watchEventKind counts other writes as file changes", () => {
  assert.equal(watchEventKind("src/main.ts", false), "files");
  assert.equal(watchEventKind(".git/index", false), "files");
  assert.equal(watchEventKind("index", true), "files");
  // Only git's own files count as refs; a worktree file named like one is an ordinary file
  assert.equal(watchEventKind("HEAD", false), "files");
  assert.equal(watchEventKind("refs/notes.md", false), "files");
  assert.equal(watchEventKind("objects/model.ts", false), "files");
});

test("watchEventKind treats an unnamed event as both a file and a refs change", () => {
  assert.equal(watchEventKind(null, false), "refs");
  assert.equal(watchEventKind(null, true), "refs");
});
