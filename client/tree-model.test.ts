import assert from "node:assert/strict";
import { test } from "node:test";
import type { SearchEntry, TreeEntry } from "../shared/contracts.ts";
import { filterMatchRanges, parseTreeFilter } from "../shared/tree-filter.ts";
import {
  baseName,
  buildFilterView,
  canMoveAbsolute,
  canMoveInto,
  copyableRelativePath,
  deselectWhere,
  isSameOrInsideAbsolute,
  movableInto,
  NO_SELECTION,
  outermostPaths,
  parentDirectory,
  relativeInside,
  flattenTree,
  formatQuotedPath,
  parseQuotedPaths,
  resolvePath,
  joinPath,
  parentPath,
  relativeLinkPath,
  remapPath,
  ROOT_PATH,
  selectForMenu,
  selectPaths,
  selectRange,
  toggleSelected,
  type TreeSelection,
} from "./tree-model.ts";

test("parentDirectory walks up to the drive or filesystem root", () => {
  assert.equal(parentDirectory("H:\\Boreal\\boreal"), "H:\\Boreal");
  assert.equal(parentDirectory("H:\\Boreal"), "H:\\");
  assert.equal(parentDirectory("H:\\"), null);
  assert.equal(parentDirectory("/home/me/repo/"), "/home/me");
  assert.equal(parentDirectory("/home"), "/");
  assert.equal(parentDirectory("/"), null);
  assert.equal(baseName("H:\\Boreal\\boreal\\"), "boreal");
  assert.equal(baseName("H:\\"), "H:\\");
});

test("relativeInside returns null outside the base", () => {
  assert.equal(relativeInside("H:\\Boreal\\boreal", "H:\\Boreal\\boreal\\src\\a.ts"), "src/a.ts");
  assert.equal(relativeInside("H:\\Boreal\\boreal", "h:\\boreal\\BOREAL"), "");
  assert.equal(relativeInside("H:\\Boreal\\boreal", "H:\\Boreal\\other"), null);
  assert.equal(relativeInside("H:\\Boreal", "D:\\x"), null);
});

test("canMoveAbsolute compares across tree views", () => {
  assert.equal(canMoveAbsolute("H:\\r\\src\\a.ts", "H:\\r\\lib"), true);
  assert.equal(canMoveAbsolute("H:\\r\\src\\a.ts", "h:/R/src"), false);
  assert.equal(canMoveAbsolute("H:\\r\\src", "H:\\r\\src\\inner"), false);
  assert.equal(canMoveAbsolute("H:\\r\\src", "H:\\r\\srcx"), true);
  assert.equal(canMoveAbsolute("/r/src/lib", "/r"), true);
});

test("isSameOrInsideAbsolute catches pasting a folder into itself, not into a sibling with a longer name", () => {
  assert.equal(isSameOrInsideAbsolute("H:\\r\\src\\inner", "h:/R/src"), true);
  assert.equal(isSameOrInsideAbsolute("H:\\r\\src", "H:\\r\\src"), true);
  assert.equal(isSameOrInsideAbsolute("H:\\r\\src2", "H:\\r\\src"), false);
  assert.equal(isSameOrInsideAbsolute("/a/b", "/"), true);
});

test("copyableRelativePath counts from the workspace when inside it, with native separators", () => {
  assert.equal(copyableRelativePath("H:\\ws", "H:\\ws\\pkg", "src/a.ts"), "pkg\\src\\a.ts");
  assert.equal(copyableRelativePath("H:\\ws", "H:\\elsewhere", "src/a.ts"), "src\\a.ts");
  assert.equal(copyableRelativePath("/ws", "/ws", "src/a.ts"), "src/a.ts");
});

test("canMoveInto rejects no-op moves and moves into the folder itself", () => {
  assert.equal(parentPath("src/a.ts"), "src");
  assert.equal(parentPath("a.ts"), ROOT_PATH);
  assert.equal(canMoveInto("src/a.ts", "lib"), true);
  assert.equal(canMoveInto("src/a.ts", "src"), false);
  assert.equal(canMoveInto("src", "src/lib"), false);
  assert.equal(canMoveInto("src", "src"), false);
  assert.equal(canMoveInto("src", "srcx"), true);
  assert.equal(canMoveInto("src/lib", ROOT_PATH), true);
});

test("remapPath moves a folder's descendants with it", () => {
  assert.equal(remapPath("src/lib/a.ts", "src/lib", "pkg/lib"), "pkg/lib/a.ts");
  assert.equal(remapPath("src/lib", "src/lib", "pkg/lib"), "pkg/lib");
  assert.equal(remapPath("src/library", "src/lib", "pkg/lib"), "src/library");
});

const SHOWN = ["a", "a/x", "a/y", "b", "c", "d"];
const selected = (selection: TreeSelection) => [...selection.paths].sort();

test("Ctrl+click toggles one row and anchors the next Shift+click there", () => {
  let selection = toggleSelected(selectPaths(["a/x"]), "c");
  assert.deepEqual(selected(selection), ["a/x", "c"]);
  assert.equal(selection.lead, "c");
  selection = toggleSelected(selection, "c");
  assert.deepEqual(selected(selection), ["a/x"]);
  // The lead passes to a row still selected; the run starts at the row clicked
  assert.equal(selection.lead, "a/x");
  assert.deepEqual(selected(selectRange(selection, "d", SHOWN, false)), ["c", "d"]);
});

test("Shift+click selects the run from a fixed anchor, replacing the selection unless Ctrl is held", () => {
  let selection = selectRange(selectPaths(["b"]), "a/x", SHOWN, false);
  assert.deepEqual(selected(selection), ["a/x", "a/y", "b"]);
  selection = selectRange(selection, "d", SHOWN, false);
  assert.deepEqual(selected(selection), ["b", "c", "d"]);
  assert.equal(selection.anchor, "b");
  selection = selectRange(toggleSelected(selectPaths(["a"]), "c"), "d", SHOWN, true);
  assert.deepEqual(selected(selection), ["a", "c", "d"]);
  // An anchor no longer shown (its folder closed) starts the run at the row clicked
  assert.deepEqual(selected(selectRange(selectPaths(["a/x"]), "c", ["a", "b", "c"], false)), ["c"]);
  assert.deepEqual(selected(selectRange(NO_SELECTION, "b", SHOWN, false)), ["b"]);
});

test("a row's menu keeps the selection holding it, and deleting a folder deselects what was inside", () => {
  const selection = selectRange(selectPaths(["a"]), "b", SHOWN, false);
  assert.deepEqual(selected(selectForMenu(selection, "a/y")), ["a", "a/x", "a/y", "b"]);
  assert.equal(selectForMenu(selection, "a/y").lead, "a/y");
  assert.deepEqual(selected(selectForMenu(selection, "d")), ["d"]);
  const afterDelete = deselectWhere(selectForMenu(selection, "a"), (path) => path === "a" || path.startsWith("a/"));
  assert.deepEqual(selected(afterDelete), ["b"]);
  assert.equal(afterDelete.lead, "b");
});

test("a multi-row move skips rows inside another moved row and rows already in the folder", () => {
  assert.deepEqual(outermostPaths(["src", "src/a.ts", "src-old/b.ts", "lib/deep/c.ts", "lib"]), ["src", "src-old/b.ts", "lib"]);
  assert.deepEqual(movableInto(["H:\\r\\src\\a.ts", "H:\\r\\lib\\b.ts"], "H:\\r\\lib"), ["H:\\r\\src\\a.ts"]);
  assert.deepEqual(movableInto(["H:\\r\\src", "H:\\r\\a.ts"], "H:\\r\\src\\inner"), []);
  assert.deepEqual(movableInto(["H:\\r\\lib\\b.ts"], "H:\\r\\lib"), []);
});

const directory = (path: string): TreeEntry => ({
  name: path.split("/").pop() ?? path,
  path,
  kind: "directory",
});
const file = (path: string): TreeEntry => ({ name: path.split("/").pop() ?? path, path, kind: "file" });

test("flattenTree walks expanded folders depth first and marks unloaded ones", () => {
  const directories = new Map<string, TreeEntry[]>([
    [ROOT_PATH, [directory("src"), directory("docs"), file("README.md")]],
    ["src", [directory("src/lib"), file("src/main.ts")]],
  ]);
  const rows = flattenTree(directories, new Set(["src", "src/lib"]));
  assert.deepEqual(
    rows.map((row) => [row.entry.path, row.depth, row.expanded, row.loading]),
    [
      ["src", 0, true, false],
      ["src/lib", 1, true, true],
      ["src/main.ts", 1, false, false],
      ["docs", 0, false, false],
      ["README.md", 0, false, false],
    ],
  );
});

test("buildFilterView opens the folders leading to matches, and a matched folder with nothing shown inside is not one", () => {
  const found = (entry: TreeEntry, matched: boolean): SearchEntry => ({ ...entry, matched });
  const view = buildFilterView([
    found(directory("src"), false),
    found(directory("src/tree"), true),
    found(file("src/tree-model.ts"), true),
    found(directory("trees"), true),
  ]);
  assert.deepEqual([...view.parents], ["src"]);
  assert.deepEqual([...view.matched], ["src/tree", "src/tree-model.ts", "trees"]);
  assert.deepEqual(
    flattenTree(view.directories, view.parents).map((row) => [row.entry.path, row.depth, row.expanded, row.loading]),
    [
      ["src", 0, true, false],
      ["src/tree", 1, false, false],
      ["src/tree-model.ts", 1, false, false],
      ["trees", 0, false, false],
    ],
  );
});

test("filterMatchRanges marks every place a name term appears, merging overlaps, ignoring case and path terms", () => {
  const filter = parseTreeFilter("TREE  ee src/")!;
  assert.deepEqual(filter, { nameTerms: ["tree", "ee"], pathTerms: ["src/"] });
  assert.deepEqual(filterMatchRanges(filter, "Tree-Tree.ts"), [
    [0, 4],
    [5, 9],
  ]);
  assert.deepEqual(filterMatchRanges(filter, "index.ts"), []);
  assert.equal(parseTreeFilter("   "), null);
});

test("relativeLinkPath climbs out of a subdirectory cwd", () => {
  assert.equal(
    relativeLinkPath("C:\\repo\\packages\\app", "C:\\repo\\some\\file\\path\\file_name.txt"),
    "../../some/file/path/file_name.txt",
  );
  assert.equal(relativeLinkPath("/repo", "/repo/src/a.ts"), "src/a.ts");
  assert.equal(relativeLinkPath("/repo/src", "/repo/src"), ".");
});

test("relativeLinkPath ignores case on Windows and returns absolute paths across drives", () => {
  assert.equal(relativeLinkPath("c:\\Repo", "C:\\repo\\a.txt"), "a.txt");
  assert.equal(relativeLinkPath("C:\\repo", "D:\\other\\a.txt"), "D:/other/a.txt");
});

test("joinPath uses the root's separator", () => {
  assert.equal(joinPath("C:\\repo\\", "src/a.ts"), "C:\\repo\\src\\a.ts");
  assert.equal(joinPath("/repo", "src/a.ts"), "/repo/src/a.ts");
});

test("parseQuotedPaths reads back what formatQuotedPath writes", () => {
  const message = `look at ${formatQuotedPath("src/a b.ts")} and ${formatQuotedPath('odd"name.txt')} plus "../up/x.md"`;
  assert.deepEqual(parseQuotedPaths(message), ["src/a b.ts", 'odd"name.txt', "../up/x.md"]);
  assert.deepEqual(parseQuotedPaths('no "multi\nline" quotes'), []);
});

test("resolvePath resolves relative paths and keeps absolute ones", () => {
  assert.equal(resolvePath("H:\\Boreal\\boreal", "src/a.ts"), "H:\\Boreal\\boreal\\src\\a.ts");
  assert.equal(resolvePath("H:\\Boreal\\boreal\\app", "../some/file.txt"), "H:\\Boreal\\boreal\\some\\file.txt");
  assert.equal(resolvePath("H:\\Boreal\\boreal", "D:/x/y.txt"), "D:\\x\\y.txt");
  assert.equal(resolvePath("/repo/app", "./lib/../a.ts"), "/repo/app/a.ts");
  assert.equal(resolvePath("/repo", "/etc/hosts"), "/etc/hosts");
});

test("formatQuotedPath wraps the path in double quotes", () => {
  assert.equal(formatQuotedPath("relative/path/to/file.txt"), '"relative/path/to/file.txt"');
  assert.equal(formatQuotedPath("docs/my file.txt"), '"docs/my file.txt"');
  assert.equal(formatQuotedPath('odd"name.txt'), '"odd\\"name.txt"');
});
