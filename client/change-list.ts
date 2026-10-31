import type { GitFile } from "../shared/git-contracts";
import { TRACKED_COLOR, UNTRACKED_COLOR } from "./git-colors.ts";
import { joinPath, normalizeAbsolute, parentDirectory } from "./tree-model.ts";

/** Staging is the row's checkbox, not a category: a file is tracked or new (untracked or added) */
export type ChangeCategory = "tracked" | "untracked";
export type ChangeFilter = Record<ChangeCategory, boolean>;

export type ChangeRow =
  | { kind: "group"; key: string; category: ChangeCategory; count: number; collapsed: boolean }
  | { kind: "folder"; key: string; name: string; depth: number; collapsed: boolean }
  | { kind: "file"; key: string; file: GitFile; depth: number };

export interface ChangeListOptions {
  filter: ChangeFilter;
  /** One section per category */
  grouped: boolean;
  /** Files nested under their folders instead of a flat list */
  folders: boolean;
  /** Row keys of collapsed groups and folders */
  collapsed: ReadonlySet<string>;
}

export type CheckState = "checked" | "unchecked" | "mixed";

export interface StageFamily {
  /** Every path in the family; staging all of them checks the box */
  paths: string[];
  /** Paths with something in the index; unstaging them clears the box */
  stagedPaths: string[];
  state: CheckState;
}

const GROUP_ORDER: readonly ChangeCategory[] = ["tracked", "untracked"];

/** Staging an untracked file adds it to the index; it stays new until committed */
function isNew(file: GitFile): boolean {
  return file.untracked || file.added;
}

export function fileCategory(file: GitFile): ChangeCategory {
  return isNew(file) ? "untracked" : "tracked";
}

export function inCategory(file: GitFile, category: ChangeCategory): boolean {
  return fileCategory(file) === category;
}

export function matchesFilter(file: GitFile, filter: ChangeFilter): boolean {
  return filter[fileCategory(file)];
}

export function changeColor(file: GitFile): string {
  return isNew(file) ? UNTRACKED_COLOR : TRACKED_COLOR;
}

/** Folders take their strongest descendant's color: new files outrank edits */
function colorRank(color: string): number {
  return color === UNTRACKED_COLOR ? 2 : 1;
}

/** Visible rows of the changes list: grouping first, then folder structure inside each group */
export function buildChangeRows(files: readonly GitFile[], options: ChangeListOptions): ChangeRow[] {
  const rows: ChangeRow[] = [];
  const visible = files.filter((file) => matchesFilter(file, options.filter));
  if (!options.grouped) {
    appendFiles(rows, visible, "", options);
    return rows;
  }
  for (const category of GROUP_ORDER) {
    if (!options.filter[category]) continue;
    const members = visible.filter((file) => inCategory(file, category));
    if (members.length === 0) continue;
    const key = `group:${category}`;
    const collapsed = options.collapsed.has(key);
    rows.push({ kind: "group", key, category, count: members.length, collapsed });
    if (!collapsed) appendFiles(rows, members, `${category}:`, options);
  }
  return rows;
}

interface FolderNode {
  name: string;
  path: string;
  folders: Map<string, FolderNode>;
  files: GitFile[];
}

function newFolder(name: string, path: string): FolderNode {
  return { name, path, folders: new Map(), files: [] };
}

function appendFiles(rows: ChangeRow[], files: readonly GitFile[], keyPrefix: string, options: ChangeListOptions): void {
  if (!options.folders) {
    for (const file of files) rows.push({ kind: "file", key: `${keyPrefix}file:${file.path}`, file, depth: 0 });
    return;
  }
  const root = newFolder("", "");
  for (const file of files) {
    const segments = file.path.split("/");
    let node = root;
    for (let index = 0; index < segments.length - 1; index++) {
      let child = node.folders.get(segments[index]);
      if (!child) {
        child = newFolder(segments[index], node.path ? `${node.path}/${segments[index]}` : segments[index]);
        node.folders.set(segments[index], child);
      }
      node = child;
    }
    node.files.push(file);
  }
  // Depth-first: a folder's subfolders come before its files
  type Pending = { folder: FolderNode; depth: number } | { file: GitFile; depth: number };
  const pending: Pending[] = [];
  const pushChildren = (folder: FolderNode, depth: number) => {
    const folders = [...folder.folders.values()].sort((left, right) => left.name.localeCompare(right.name));
    for (let index = folder.files.length - 1; index >= 0; index--) pending.push({ file: folder.files[index], depth });
    for (let index = folders.length - 1; index >= 0; index--) pending.push({ folder: folders[index], depth });
  };
  pushChildren(root, 0);
  while (pending.length > 0) {
    const item = pending.pop()!;
    if ("file" in item) {
      rows.push({ kind: "file", key: `${keyPrefix}file:${item.file.path}`, file: item.file, depth: item.depth });
      continue;
    }
    // A chain of folders holding only one folder each shows as one row, "a/b/c"
    let folder = item.folder;
    let name = folder.name;
    while (folder.files.length === 0 && folder.folders.size === 1) {
      folder = folder.folders.values().next().value!;
      name = `${name}/${folder.name}`;
    }
    const key = `${keyPrefix}folder:${folder.path}`;
    const collapsed = options.collapsed.has(key);
    rows.push({ kind: "folder", key, name, depth: item.depth, collapsed });
    if (!collapsed) pushChildren(folder, item.depth + 1);
  }
}

function family(members: readonly GitFile[]): StageFamily {
  const stagedPaths = members.filter((file) => file.staged).map((file) => file.path);
  const fullyStaged = members.filter((file) => file.staged && !file.modified).length;
  let state: CheckState = "unchecked";
  if (members.length > 0 && fullyStaged === members.length) state = "checked";
  else if (stagedPaths.length > 0) state = "mixed";
  return { paths: members.map((file) => file.path), stagedPaths, state };
}

/** Stage-all checkbox state per category */
export function stageFamilies(files: readonly GitFile[]): Record<ChangeCategory, StageFamily> {
  return {
    tracked: family(files.filter((file) => !isNew(file))),
    untracked: family(files.filter(isNew)),
  };
}

/** What a file or folder row of the changes list stands for: its path and the changed files it covers */
export interface ChangeTarget {
  kind: "file" | "directory";
  /** Worktree-relative, forward slashes */
  path: string;
  files: GitFile[];
}

/**
 * The file or folder behind a row key from buildChangeRows; a folder in a group covers only that
 * group's visible files. Null for group headers and stale keys.
 */
export function changeTargetFromKey(key: string, files: readonly GitFile[], filter: ChangeFilter): ChangeTarget | null {
  let rest = key;
  let category: ChangeCategory | null = null;
  // A path may hold ":", so the row kind is matched before any group prefix
  if (!rest.startsWith("file:") && !rest.startsWith("folder:")) {
    const prefix = GROUP_ORDER.find((candidate) => rest.startsWith(`${candidate}:`));
    if (!prefix) return null;
    category = prefix;
    rest = rest.slice(prefix.length + 1);
  }
  const covered = (file: GitFile) => matchesFilter(file, filter) && (category === null || inCategory(file, category));
  if (rest.startsWith("file:")) {
    const path = rest.slice("file:".length);
    const match = files.find((file) => file.path === path && covered(file));
    return match ? { kind: "file", path, files: [match] } : null;
  }
  if (!rest.startsWith("folder:")) return null;
  const path = rest.slice("folder:".length);
  const members = files.filter((file) => file.path.startsWith(`${path}/`) && covered(file));
  return members.length > 0 ? { kind: "directory", path, files: members } : null;
}

/**
 * Change color per comparable absolute path (normalizeAbsolute): each changed file, and every
 * folder above it up to the worktree, which takes its strongest descendant's color
 */
export function changeColorsByPath(files: readonly GitFile[], worktree: string): Map<string, string> {
  const colors = new Map<string, string>();
  const worktreeKey = normalizeAbsolute(worktree);
  for (const file of files) {
    const color = changeColor(file);
    const rank = colorRank(color);
    let absolute: string | null = joinPath(worktree, file.path);
    colors.set(normalizeAbsolute(absolute), color);
    absolute = parentDirectory(absolute);
    while (absolute !== null) {
      const key = normalizeAbsolute(absolute);
      const existing = colors.get(key);
      if (existing === undefined || colorRank(existing) < rank) colors.set(key, color);
      if (key === worktreeKey) break;
      absolute = parentDirectory(absolute);
    }
  }
  return colors;
}
