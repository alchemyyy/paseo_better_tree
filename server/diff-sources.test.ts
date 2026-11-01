import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { readDiffSources } from "./diff-sources.ts";
import { stopGitObjectReaders } from "./object-reader.ts";

const temporaryRoots: string[] = [];
after(async () => {
  // Readers keep the process alive and, on Windows, their working directories locked
  await stopGitObjectReaders();
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true, maxRetries: 10 });
});

function createRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "better-tree-diff-sources-"));
  temporaryRoots.push(root);
  return root;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    "git",
    ["-c", "user.name=Diff Sources Test", "-c", "user.email=diff-sources@example.invalid", "-c", "core.autocrlf=false", ...args],
    { cwd },
  );
}

/** A repository with `files` committed to HEAD */
function createRepository(files: Record<string, string>): string {
  const root = createRoot();
  git(root, "init", "--quiet");
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
  git(root, "add", "--all");
  git(root, "commit", "--quiet", "-m", "initial");
  return root;
}

test("readDiffSources compares a modified file on disk with HEAD, normalizing CRLF", async () => {
  const root = createRepository({ "a.txt": "one\ntwo\n" });
  const filePath = path.join(root, "a.txt");
  writeFileSync(filePath, "one\r\nthree\r\n");
  assert.deepEqual(await readDiffSources(filePath), { absolutePath: filePath, original: "one\ntwo\n", current: "one\nthree\n" });
});

test("readDiffSources gives an untracked file an empty original", async () => {
  const root = createRepository({ "a.txt": "one\n" });
  const filePath = path.join(root, "new.txt");
  writeFileSync(filePath, "fresh\n");
  assert.deepEqual(await readDiffSources(filePath), { absolutePath: filePath, original: "", current: "fresh\n" });
});

test("readDiffSources finds HEAD's text in a folder whose name has a space", async () => {
  const root = createRepository({ "a.txt": "top\n", "sub dir/note.txt": "nested\n" });
  const filePath = path.join(root, "sub dir", "note.txt");
  writeFileSync(filePath, "nested\nmore\n");
  assert.deepEqual(await readDiffSources(filePath), { absolutePath: filePath, original: "nested\n", current: "nested\nmore\n" });
});

test("readDiffSources gives a repository without commits an empty original", async () => {
  const root = createRoot();
  git(root, "init", "--quiet");
  const filePath = path.join(root, "a.txt");
  writeFileSync(filePath, "first\n");
  assert.deepEqual(await readDiffSources(filePath), { absolutePath: filePath, original: "", current: "first\n" });
});

test("readDiffSources has no original outside a repository", async () => {
  const root = createRoot();
  const filePath = path.join(root, "loose.txt");
  writeFileSync(filePath, "loose\n");
  assert.deepEqual(await readDiffSources(filePath), { absolutePath: filePath, original: null, current: "loose\n" });
});
