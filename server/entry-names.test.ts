import assert from "node:assert/strict";
import { test } from "node:test";
import { copyName, entryNameProblem } from "./entry-names.ts";

test("entryNameProblem rejects empty, dot, and path-like names everywhere", () => {
  for (const name of ["", "  ", ".", "..", "a/b", "a\\b"]) {
    assert.notEqual(entryNameProblem(name, "linux"), null, name);
  }
  assert.equal(entryNameProblem("notes.md", "linux"), null);
  assert.equal(entryNameProblem("a:b?.txt", "linux"), null);
});

test("entryNameProblem applies Windows' extra rules only on Windows", () => {
  for (const name of ["a:b", "what?", "trailing.", "trailing ", "CON", "nul.txt", "COM1"]) {
    assert.notEqual(entryNameProblem(name, "win32"), null, name);
  }
  assert.equal(entryNameProblem("console.log", "win32"), null);
  assert.equal(entryNameProblem("it's & ok [1].txt", "win32"), null);
});

test("copyName keeps the extension last and numbers later copies", () => {
  assert.equal(copyName("notes.txt", false, 1), "notes copy.txt");
  assert.equal(copyName("notes.txt", false, 2), "notes copy 2.txt");
  assert.equal(copyName("archive.tar.gz", false, 1), "archive.tar copy.gz");
  assert.equal(copyName(".gitignore", false, 1), ".gitignore copy");
  assert.equal(copyName("v1.2", true, 3), "v1.2 copy 3");
});
