import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { listRepositories } from "./repositories.ts";

const temporaryRoots: string[] = [];
after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

function createRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "better-tree-repositories-"));
  temporaryRoots.push(root);
  return root;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=Repositories Test", "-c", "user.email=repositories@example.invalid", ...args], {
    cwd,
  });
}

/** A repository at `folder` with one commit on `branch` */
function createRepository(folder: string, branch: string): void {
  mkdirSync(folder, { recursive: true });
  git(folder, "init", "-q", "-b", branch);
  writeFileSync(path.join(folder, "readme.md"), "");
  git(folder, "add", "-A");
  git(folder, "commit", "-qm", "initial");
}

test("listRepositories outside Git lists the outermost repositories at any depth, in tree order, with their branches", async () => {
  const root = createRoot();
  createRepository(path.join(root, "apps", "web"), "main");
  // A repository inside another is not listed
  createRepository(path.join(root, "apps", "web", "vendor", "lib"), "main");
  // A linked worktree holds a .git file naming its git directory
  git(path.join(root, "apps", "web"), "worktree", "add", "-q", "-b", "feature", path.join(root, "apps", "linked"));
  createRepository(path.join(root, "Zeta"), "main");
  git(path.join(root, "Zeta"), "checkout", "-q", "--detach");
  // Without commits the branch still reads
  mkdirSync(path.join(root, "tools", "cli"), { recursive: true });
  git(path.join(root, "tools", "cli"), "init", "-q", "-b", "dev");
  // node_modules is never searched through
  createRepository(path.join(root, "node_modules", "pkg"), "main");
  mkdirSync(path.join(root, "notes"));

  const result = await listRepositories({ root });
  assert.equal(result.incomplete, false);
  assert.deepEqual(
    result.repositories.map(({ relativePath, branch }) => [relativePath, branch]),
    [
      ["apps/linked", "feature"],
      ["apps/web", "main"],
      ["tools/cli", "dev"],
      ["Zeta", null],
    ],
  );
});
