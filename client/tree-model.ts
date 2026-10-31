import type { SearchEntry, TreeEntry } from "../shared/contracts";

/** Directory key for the workspace root in listing maps */
export const ROOT_PATH = "";

export interface TreeRow {
  entry: TreeEntry;
  depth: number;
  expanded: boolean;
  loading: boolean;
}

/** Flattens loaded directory listings into visible rows in depth-first order */
export function flattenTree(
  directories: ReadonlyMap<string, readonly TreeEntry[]>,
  expanded: ReadonlySet<string>,
): TreeRow[] {
  const rows: TreeRow[] = [];
  const pending: { entry: TreeEntry; depth: number }[] = [];
  const rootEntries = directories.get(ROOT_PATH) ?? [];
  for (let index = rootEntries.length - 1; index >= 0; index--) {
    pending.push({ entry: rootEntries[index], depth: 0 });
  }
  while (pending.length > 0) {
    const { entry, depth } = pending.pop()!;
    const isExpanded = entry.kind === "directory" && expanded.has(entry.path);
    const children = isExpanded ? directories.get(entry.path) : undefined;
    rows.push({ entry, depth, expanded: isExpanded, loading: isExpanded && !children });
    if (!children) continue;
    for (let index = children.length - 1; index >= 0; index--) {
      pending.push({ entry: children[index], depth: depth + 1 });
    }
  }
  return rows;
}

/** Parent folder of a workspace-relative path; ROOT_PATH for top-level entries */
export function parentPath(relativePath: string): string {
  const separatorIndex = relativePath.lastIndexOf("/");
  return separatorIndex > 0 ? relativePath.slice(0, separatorIndex) : ROOT_PATH;
}

/** The tree a filter shows: its matches and the folders leading to them */
export interface FilterView {
  /** Listings of the shown entries only, keyed like the tree's, for flattenTree */
  directories: Map<string, TreeEntry[]>;
  /** Shown folders with shown entries inside; the others have nothing to open here */
  parents: Set<string>;
  /** Entries the filter matched, as opposed to folders shown only to lead to one */
  matched: Set<string>;
}

/** Builds the filtered tree from search results, which arrive in tree order */
export function buildFilterView(entries: readonly SearchEntry[]): FilterView {
  const view: FilterView = { directories: new Map(), parents: new Set(), matched: new Set() };
  for (const entry of entries) {
    const parent = parentPath(entry.path);
    const siblings = view.directories.get(parent);
    if (siblings) siblings.push(entry);
    else view.directories.set(parent, [entry]);
    if (parent !== ROOT_PATH) view.parents.add(parent);
    if (entry.matched) view.matched.add(entry.path);
  }
  return view;
}

function isSameOrInside(candidate: string, ancestor: string): boolean {
  return candidate === ancestor || candidate.startsWith(`${ancestor}/`);
}

/** Whether moving `sourcePath` into `directory` changes anything and stays out of itself */
export function canMoveInto(sourcePath: string, directory: string): boolean {
  return directory !== parentPath(sourcePath) && !isSameOrInside(directory, sourcePath);
}

/** Rewrites a path at or below `fromPath` to live under `toPath`; other paths pass through */
export function remapPath(candidate: string, fromPath: string, toPath: string): string {
  return isSameOrInside(candidate, fromPath) ? `${toPath}${candidate.slice(fromPath.length)}` : candidate;
}

/** `paths` without the ones inside another of them, which go wherever that one goes */
export function outermostPaths(paths: readonly string[]): string[] {
  const all = new Set(paths);
  return paths.filter((path) => {
    for (let end = path.lastIndexOf("/"); end > 0; end = path.lastIndexOf("/", end - 1)) {
      if (all.has(path.slice(0, end))) return false;
    }
    return true;
  });
}

// Section: selection

/** Selected rows: Ctrl (Cmd on macOS)+click toggles a row, Shift+click selects a run of rows */
export interface TreeSelection {
  /** Every selected row's path */
  paths: ReadonlySet<string>;
  /** The row clicked last; shortcuts and the row menu act on it */
  lead: string | null;
  /** Where Shift+click runs start */
  anchor: string | null;
}

export const NO_SELECTION: TreeSelection = { paths: new Set(), lead: null, anchor: null };

/** Selects only `paths`: the last one leads, the first anchors */
export function selectPaths(paths: readonly string[]): TreeSelection {
  return { paths: new Set(paths), lead: paths.at(-1) ?? null, anchor: paths[0] ?? null };
}

/** Ctrl/Cmd+click: the row joins or leaves the selection, and the next run starts there */
export function toggleSelected(selection: TreeSelection, path: string): TreeSelection {
  const paths = new Set(selection.paths);
  if (!paths.delete(path)) paths.add(path);
  // A row taken out passes the lead to another selected row
  return { paths, lead: paths.has(path) ? path : ([...paths].at(-1) ?? null), anchor: path };
}

/**
 * Shift+click: the rows from the anchor to `path` in `order` (the rows shown) replace the
 * selection, or join it when `additive` (Ctrl/Cmd held too). Without an anchor in `order`, the run
 * starts at `path`.
 */
export function selectRange(
  selection: TreeSelection,
  path: string,
  order: readonly string[],
  additive: boolean,
): TreeSelection {
  const end = order.indexOf(path);
  if (end < 0) return selection;
  const anchored = selection.anchor === null ? -1 : order.indexOf(selection.anchor);
  const start = anchored < 0 ? end : anchored;
  const run = order.slice(Math.min(start, end), Math.max(start, end) + 1);
  return { paths: new Set(additive ? [...selection.paths, ...run] : run), lead: path, anchor: order[start] };
}

/** A row's menu acts on the selection holding it, else on the row alone */
export function selectForMenu(selection: TreeSelection, path: string): TreeSelection {
  return selection.paths.has(path) ? { ...selection, lead: path } : selectPaths([path]);
}

/** The selection less the rows `isGone` matches, as after deleting them */
export function deselectWhere(selection: TreeSelection, isGone: (path: string) => boolean): TreeSelection {
  const paths = [...selection.paths].filter((path) => !isGone(path));
  if (paths.length === selection.paths.size) return selection;
  return {
    paths: new Set(paths),
    lead: selection.lead !== null && !isGone(selection.lead) ? selection.lead : (paths.at(-1) ?? null),
    anchor: selection.anchor !== null && !isGone(selection.anchor) ? selection.anchor : null,
  };
}

const DRIVE_ROOT = /^[A-Za-z]:$/;

/** Last segment of an absolute path, or the path itself for a filesystem root */
export function baseName(absolute: string): string {
  const trimmed = absolute.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index < 0 ? absolute : trimmed.slice(index + 1) || absolute;
}

/** Parent of an absolute directory, or null at a drive or filesystem root */
export function parentDirectory(absolute: string): string | null {
  const trimmed = absolute.replace(/[\\/]+$/, "");
  if (trimmed === "" || DRIVE_ROOT.test(trimmed)) return null;
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (index < 0) return null;
  const parent = trimmed.slice(0, index);
  if (parent === "") return "/";
  return DRIVE_ROOT.test(parent) ? `${parent}${absolute.includes("\\") ? "\\" : "/"}` : parent;
}

/** Comparable form of an absolute path: forward slashes, no trailing slash, case-folded on Windows */
export function normalizeAbsolute(absolute: string): string {
  const slashes = absolute.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return isWindowsPath(absolute) ? slashes.toLowerCase() : slashes;
}

/** Forward-slash path of `target` under `base`, "" for `base` itself, or null when outside it */
export function relativeInside(base: string, target: string): string | null {
  const relative = relativeLinkPath(base, target);
  if (relative === ".") return "";
  if (relative === ".." || relative.startsWith("../") || /^([A-Za-z]:|\/)/.test(relative)) return null;
  return relative;
}

/** Whether moving `source` into `directory` (both absolute) changes anything and stays out of itself */
export function canMoveAbsolute(source: string, directory: string): boolean {
  const normalizedSource = normalizeAbsolute(source);
  const normalizedDirectory = normalizeAbsolute(directory);
  const sourceParent = parentDirectory(source);
  if (sourceParent !== null && normalizeAbsolute(sourceParent) === normalizedDirectory) return false;
  return (
    normalizedDirectory !== normalizedSource && !normalizedDirectory.startsWith(`${normalizedSource}/`)
  );
}

/**
 * The `sources` (absolute) a drop into `directory` moves: none when the folder is one of them or
 * inside one, else those not already in it
 */
export function movableInto(sources: readonly string[], directory: string): string[] {
  if (sources.some((source) => isSameOrInsideAbsolute(directory, source))) return [];
  return sources.filter((source) => canMoveAbsolute(source, directory));
}

/** Whether an absolute path is a Windows one: a drive path or a UNC share */
export function isWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

/** Whether absolute `candidate` is `ancestor` or inside it */
export function isSameOrInsideAbsolute(candidate: string, ancestor: string): boolean {
  const normalizedCandidate = normalizeAbsolute(candidate);
  const normalizedAncestor = normalizeAbsolute(ancestor);
  return (
    normalizedCandidate === normalizedAncestor ||
    normalizedCandidate.startsWith(normalizedAncestor === "/" ? "/" : `${normalizedAncestor}/`)
  );
}

/**
 * Relative path for "Copy relative path": from the workspace folder when the entry is inside it,
 * else from the tree's root; with the platform's separators, as VS Code copies it
 */
export function copyableRelativePath(workspaceDirectory: string | null, root: string, relativePath: string): string {
  const absolute = joinPath(root, relativePath);
  const fromWorkspace = workspaceDirectory === null ? null : relativeInside(workspaceDirectory, absolute);
  const relative = fromWorkspace ?? relativePath;
  return isWindowsPath(root) ? relative.replace(/\//g, "\\") : relative;
}

function splitPath(value: string): string[] {
  return value.replace(/\\/g, "/").split("/").filter((segment) => segment !== "" && segment !== ".");
}

/** Joins an absolute directory with a workspace-relative forward-slash path */
export function joinPath(directory: string, relativePath: string): string {
  const separator = isWindowsPath(directory) ? "\\" : "/";
  const segments = splitPath(relativePath);
  if (segments.length === 0) return directory;
  return `${directory.replace(/[\\/]+$/, "")}${separator}${segments.join(separator)}`;
}

/**
 * Forward-slash path from `fromDirectory` to `targetPath`, both absolute.
 * Paths on different roots (drives or UNC shares) return the absolute target.
 */
export function relativeLinkPath(fromDirectory: string, targetPath: string): string {
  const fromSegments = splitPath(fromDirectory);
  const targetSegments = splitPath(targetPath);
  const ignoreCase = isWindowsPath(fromDirectory) || isWindowsPath(targetPath);
  const sameSegment = (left: string, right: string) =>
    ignoreCase ? left.toLowerCase() === right.toLowerCase() : left === right;
  if (
    fromSegments.length === 0 ||
    targetSegments.length === 0 ||
    !sameSegment(fromSegments[0], targetSegments[0])
  ) {
    return targetPath.replace(/\\/g, "/");
  }
  let shared = 0;
  while (
    shared < fromSegments.length &&
    shared < targetSegments.length &&
    sameSegment(fromSegments[shared], targetSegments[shared])
  ) {
    shared++;
  }
  const segments: string[] = [];
  for (let index = shared; index < fromSegments.length; index++) segments.push("..");
  for (let index = shared; index < targetSegments.length; index++) {
    segments.push(targetSegments[index]);
  }
  return segments.length === 0 ? "." : segments.join("/");
}

/** Every `"..."` token in a message, unescaped; the format formatQuotedPath writes */
export function parseQuotedPaths(text: string): string[] {
  const paths: string[] = [];
  for (const match of text.matchAll(/"((?:[^"\\\n]|\\.)+)"/g)) {
    paths.push(match[1].replace(/\\"/g, '"'));
  }
  return paths;
}

/** Absolute path of `path` (relative or absolute) seen from `baseDirectory`, with `.` and `..` resolved */
export function resolvePath(baseDirectory: string, path: string): string {
  const absolute = isWindowsPath(path) || path.startsWith("/") || path.startsWith("\\");
  const start = absolute ? path : `${baseDirectory.replace(/[\\/]+$/, "")}/${path}`;
  const windows = isWindowsPath(start);
  const separator = windows || baseDirectory.includes("\\") ? "\\" : "/";
  const [first, ...rest] = start.replace(/\\/g, "/").split("/");
  const prefix = windows ? first : "";
  const segments: string[] = [];
  for (const segment of windows ? rest : [first, ...rest]) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return windows ? `${prefix}${separator}${segments.join(separator)}` : `/${segments.join("/")}`;
}

/** `"relative/path/to/file.txt"`; an embedded double quote is backslash-escaped */
export function formatQuotedPath(path: string): string {
  return `"${path.replace(/"/g, '\\"')}"`;
}
