import assert from "node:assert/strict";
import { test } from "node:test";
import type { GitFile } from "../shared/git-contracts";
import {
  buildChangeRows,
  changeColorsByPath,
  type ChangeRow,
  changeTargetFromKey,
  stageFamilies,
} from "./change-list.ts";
import { TRACKED_COLOR, UNTRACKED_COLOR } from "./git-colors.ts";

const file = (path: string, flags: Partial<Pick<GitFile, "staged" | "modified" | "untracked" | "added">>): GitFile => ({
  path,
  staged: flags.staged ?? false,
  modified: flags.modified ?? false,
  untracked: flags.untracked ?? false,
  added: flags.added ?? false,
  additions: 0,
  deletions: 0,
});

const ALL = { tracked: true, untracked: true };
const describe = (rows: ChangeRow[]) =>
  rows.map((row) => {
    switch (row.kind) {
      case "group":
        return `[${row.category} ${row.count}]`;
      case "folder":
        return `${"  ".repeat(row.depth)}${row.name}/`;
      case "file":
        return `${"  ".repeat(row.depth)}${row.file.path}`;
    }
  });

const FILES = [
  file("README.md", { modified: true }),
  file("src/a/deep/x.ts", { staged: true, modified: true }),
  file("src/b.ts", { untracked: true }),
  file("src/c.ts", { staged: true }),
];

test("buildChangeRows nests folders, compresses single-folder chains, and groups by tracked or new", () => {
  assert.deepEqual(describe(buildChangeRows(FILES, { filter: ALL, grouped: false, folders: true, collapsed: new Set() })), [
    "src/",
    "  a/deep/",
    "    src/a/deep/x.ts",
    "  src/b.ts",
    "  src/c.ts",
    "README.md",
  ]);
  assert.deepEqual(
    describe(buildChangeRows(FILES, { filter: ALL, grouped: true, folders: true, collapsed: new Set(["group:untracked"]) })),
    ["[tracked 3]", "src/", "  a/deep/", "    src/a/deep/x.ts", "  src/c.ts", "README.md", "[untracked 1]"],
  );
  assert.deepEqual(
    describe(
      buildChangeRows(FILES, {
        filter: { tracked: false, untracked: true },
        grouped: false,
        folders: true,
        collapsed: new Set(["folder:src"]),
      }),
    ),
    ["src/"],
  );
});

test("changeTargetFromKey resolves every file and folder row, a grouped folder covering only its group", () => {
  for (const grouped of [false, true]) {
    const rows = buildChangeRows(FILES, { filter: ALL, grouped, folders: true, collapsed: new Set() });
    for (const row of rows) {
      const target = changeTargetFromKey(row.key, FILES, ALL);
      if (row.kind === "group") assert.equal(target, null);
      else if (row.kind === "file") assert.deepEqual(target, { kind: "file", path: row.file.path, files: [row.file] });
      else assert.ok(target && target.kind === "directory" && target.files.length > 0, row.key);
    }
  }
  const mixed = [file("dir/a", { modified: true }), file("dir/b", { untracked: true }), file("dirx/c", { modified: true })];
  assert.deepEqual(
    changeTargetFromKey("untracked:folder:dir", mixed, ALL)?.files.map((member) => member.path),
    ["dir/b"],
  );
  assert.deepEqual(
    changeTargetFromKey("folder:dir", mixed, ALL)?.files.map((member) => member.path),
    ["dir/a", "dir/b"],
  );
  assert.equal(changeTargetFromKey("file:gone", mixed, ALL), null);
});

test("stageFamilies treats added files as untracked and reports partial staging", () => {
  const families = stageFamilies([
    file("a", { modified: true }),
    file("b", { staged: true }),
    file("c", { added: true, staged: true }),
    file("d", { added: true, staged: true }),
  ]);
  assert.equal(families.tracked.state, "mixed");
  assert.deepEqual(families.tracked.stagedPaths, ["b"]);
  assert.equal(families.untracked.state, "checked");
  assert.equal(stageFamilies([file("e", { untracked: true })]).untracked.state, "unchecked");
});

test("changeColorsByPath colors files and folders by their strongest change", () => {
  const colors = changeColorsByPath(
    [file("src/a.ts", { staged: true }), file("src/b.ts", { untracked: true }), file("doc/c.md", { modified: true })],
    "C:/Repo",
  );
  // Staging is not a color: a staged edit is still a tracked change
  assert.equal(colors.get("c:/repo/src/a.ts"), TRACKED_COLOR);
  assert.equal(colors.get("c:/repo/src"), UNTRACKED_COLOR);
  assert.equal(colors.get("c:/repo/doc"), TRACKED_COLOR);
  assert.equal(colors.get("c:/repo"), UNTRACKED_COLOR);
  assert.equal(colors.has("c:"), false);
});
