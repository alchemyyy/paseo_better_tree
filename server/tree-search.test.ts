import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { searchTree } from "./tree-search.ts";

const temporaryRoots: string[] = [];
after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

/** A temporary folder holding `files` (relative paths, forward slashes) */
function createFolder(files: readonly string[]): string {
  const root = mkdtempSync(path.join(tmpdir(), "better-tree-search-"));
  temporaryRoots.push(root);
  for (const file of files) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), "");
  }
  return root;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=Search Test", "-c", "user.email=search@example.invalid", ...args], { cwd });
}

/** The listed entries as "path" for matches and "(path)" for folders shown only to lead to one */
async function shown(root: string, query: string): Promise<{ entries: string[]; matchCount: number }> {
  const result = await searchTree({ root, query });
  assert.equal(result.incomplete, false);
  return {
    entries: result.entries.map((entry) => (entry.matched ? entry.path : `(${entry.path})`)),
    matchCount: result.matchCount,
  };
}

test("searchTree matches names in any folder, ignoring case, and lists them in tree order", async () => {
  const root = createFolder([
    "src/Tree-Panel.tsx",
    "src/tree-model.ts",
    "src/nested/deep-tree.md",
    "docs/guide.md",
    "node_modules/tree-lib/index.js",
    "file10.txt",
    "file9.txt",
  ]);
  // Folders first, then natural name order, as the tree lists them
  assert.deepEqual(await shown(root, "tree"), {
    entries: ["(src)", "(src/nested)", "src/nested/deep-tree.md", "src/tree-model.ts", "src/Tree-Panel.tsx"],
    matchCount: 3,
  });
  assert.deepEqual((await shown(root, "file")).entries, ["file9.txt", "file10.txt"]);
  // Every term must match, at least one in the entry's own name, the rest in folders above it;
  // a term with a slash matches the path
  assert.deepEqual((await shown(root, "TREE ts")).entries, ["(src)", "src/tree-model.ts", "src/Tree-Panel.tsx"]);
  assert.deepEqual((await shown(root, "nested tree")).entries, ["(src)", "(src/nested)", "src/nested/deep-tree.md"]);
  assert.deepEqual((await shown(root, "src/nested")).entries, ["(src)", "src/nested", "src/nested/deep-tree.md"]);
  // node_modules is found by name but never searched through
  assert.deepEqual(await shown(root, "node"), { entries: ["node_modules"], matchCount: 1 });
  assert.deepEqual(await shown(root, "index"), { entries: [], matchCount: 0 });
});

test("searchTree in a repository skips what .gitignore ignores and files deleted from disk, and searches nested repositories", async () => {
  const root = createFolder(["app.ts", "gone.ts"]);
  writeFileSync(path.join(root, ".gitignore"), "build/\n*.log\n");
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "initial");
  unlinkSync(path.join(root, "gone.ts"));
  for (const file of ["build/out.ts", "debug.log", "fresh.ts", "inner/lib.ts"]) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), "");
  }
  git(path.join(root, "inner"), "init", "-q", "-b", "main");
  assert.deepEqual(await shown(root, "ts"), {
    entries: ["(inner)", "inner/lib.ts", "app.ts", "fresh.ts"],
    matchCount: 3,
  });
  assert.deepEqual(await shown(root, "log"), { entries: [], matchCount: 0 });
});

test("searchTree outside git applies the .gitignore of each repository it walks into", async () => {
  const root = createFolder(["notes/main.md", "tools/repo/main.rs", "tools/repo/dist/main.rs"]);
  writeFileSync(path.join(root, "tools/repo/.gitignore"), "dist/\n");
  git(path.join(root, "tools/repo"), "init", "-q", "-b", "main");
  assert.deepEqual(await shown(root, "main"), {
    entries: ["(notes)", "notes/main.md", "(tools)", "(tools/repo)", "tools/repo/main.rs"],
    matchCount: 2,
  });
});
