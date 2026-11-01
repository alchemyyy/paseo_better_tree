import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { SearchEntry, searchTreeRpc } from "../shared/contracts";
// NOTE: Explicit extensions so `node --test` can load this module directly
import { matchesTreeFilter, parseTreeFilter } from "../shared/tree-filter.ts";
import { mapLimited } from "./file-work.ts";
import { fileIconId } from "./file-icons.ts";
import { runGitProcess } from "./git-process.ts";
import { compareTreeEntries, HIDDEN_NAMES, isRepositoryFolder, UNSEARCHED_FOLDERS } from "./tree.ts";

// Listing must not take index.lock away from the user's own git commands
const GIT_ENVIRONMENT = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
const GIT_MAX_BUFFER = 256 * 1024 * 1024;
const GIT_TIMEOUT_MS = 20_000;
const GIT_MODE_SUBMODULE = "160000";
const GIT_MODE_SYMLINK = "120000";

/** Matches a search lists at most, nearest the root first; the rest are only counted */
export const MAX_LISTED_MATCHES = 1000;
// shortcut: bounds one listing's entries and walking time, raise if large folders come back incomplete
const MAX_ENTRIES = 200_000;
const WALK_BUDGET_MS = 4000;
/** A listing answers the searches that follow it this soon, so typing a filter lists the tree once */
const LISTING_TTL_MS = 2000;

/** "unknown" is a link, resolved with stat once it is listed */
type EntryKind = "file" | "directory" | "unknown";

/** Everything a search can match under one root */
interface Listing {
  /** Forward-slash paths relative to the root, each once */
  paths: string[];
  kinds: EntryKind[];
  /** The paths lowercased, made by the first search that reads the listing */
  lowerPaths: string[] | null;
  /** Listing stopped early: too many entries, or too slow */
  incomplete: boolean;
}

interface ListingBuild {
  listing: Listing;
  /** Folders added so far; many files share them */
  folders: Set<string>;
  deadline: number;
}

function joinRelative(prefix: string, relativePath: string): string {
  return prefix && relativePath ? `${prefix}/${relativePath}` : prefix || relativePath;
}

/** Adds one entry; false once the listing is full */
function addEntry(build: ListingBuild, relativePath: string, kind: EntryKind): boolean {
  const { listing } = build;
  if (listing.paths.length >= MAX_ENTRIES) {
    listing.incomplete = true;
    return false;
  }
  listing.paths.push(relativePath);
  listing.kinds.push(kind);
  return true;
}

function addFolder(build: ListingBuild, relativePath: string): boolean {
  if (build.folders.has(relativePath)) return true;
  build.folders.add(relativePath);
  return addEntry(build, relativePath, "directory");
}

/** Adds a path git listed, with the folders above it; a path inside an unsearched folder stops there */
function addListedPath(build: ListingBuild, relativePath: string, kind: EntryKind): boolean {
  for (let slash = relativePath.indexOf("/"); slash !== -1; slash = relativePath.indexOf("/", slash + 1)) {
    const folder = relativePath.slice(0, slash);
    if (!addFolder(build, folder)) return false;
    if (UNSEARCHED_FOLDERS.has(folder.slice(folder.lastIndexOf("/") + 1))) return true;
  }
  return kind === "directory" ? addFolder(build, relativePath) : addEntry(build, relativePath, kind);
}

function splitRecords(output: string): string[] {
  return output.split("\0").filter((record) => record !== "");
}

/** Git processes searches run at once; repositories with many submodules list in parallel */
const GIT_CONCURRENCY = 8;
let gitRunning = 0;
const gitWaiting: (() => void)[] = [];

async function git(cwd: string, args: string[]): Promise<string> {
  if (gitRunning < GIT_CONCURRENCY) gitRunning++;
  // NOTE: executor form, since tsconfig's ES2023 lib has no Promise.withResolvers
  else await new Promise<void>((resolve) => gitWaiting.push(resolve));
  try {
    const result = await runGitProcess(cwd, args, {
      env: GIT_ENVIRONMENT,
      maxBuffer: GIT_MAX_BUFFER,
      timeout: GIT_TIMEOUT_MS,
    });
    if (result.error !== null) throw new Error(result.error);
    return result.stdout;
  } finally {
    // A waiting call takes over the slot
    const next = gitWaiting.shift();
    if (next) next();
    else gitRunning--;
  }
}

/**
 * Adds the files of the repository holding `directory` (at `prefix` under the root), its
 * .gitignore applied, then those of the repositories nested in it: submodules and repositories
 * git leaves untracked. False when git cannot list `directory`.
 */
async function addRepository(build: ListingBuild, directory: string, prefix: string): Promise<boolean> {
  let output: string[];
  try {
    output = await Promise.all([
      git(directory, ["ls-files", "-z", "--stage"]),
      // "? <path>" for an untracked file git does not ignore, "R <path>" for one deleted from disk
      git(directory, ["ls-files", "-z", "-t", "--others", "--deleted", "--exclude-standard"]),
    ]);
  } catch {
    return false;
  }
  const [staged = "", changes = ""] = output;
  const untracked: string[] = [];
  const deleted = new Set<string>();
  for (const record of splitRecords(changes)) {
    if (record.startsWith("? ")) untracked.push(record.slice(2));
    else if (record.startsWith("R ")) deleted.add(record.slice(2));
  }
  const nested: string[] = [];
  let previous = "";
  for (const record of splitRecords(staged)) {
    // "<mode> <object> <stage>\t<path>"; a conflicted path repeats once per stage
    const tab = record.indexOf("\t");
    const file = record.slice(tab + 1);
    if (tab < 0 || file === previous || deleted.has(file)) continue;
    previous = file;
    const mode = record.slice(0, tab).split(" ")[0];
    if (mode === GIT_MODE_SUBMODULE) nested.push(file);
    const kind = mode === GIT_MODE_SUBMODULE ? "directory" : mode === GIT_MODE_SYMLINK ? "unknown" : "file";
    if (!addListedPath(build, joinRelative(prefix, file), kind)) return true;
  }
  for (const record of untracked) {
    // An untracked repository inside lists as its folder, with a trailing slash
    const isRepository = record.endsWith("/");
    const relativePath = isRepository ? record.slice(0, -1) : record;
    if (isRepository) nested.push(relativePath);
    if (!addListedPath(build, joinRelative(prefix, relativePath), isRepository ? "directory" : "file")) return true;
  }
  await Promise.all(
    nested.map(async (repository) => {
      if (build.listing.incomplete) return;
      if (Date.now() > build.deadline) {
        build.listing.incomplete = true;
        return;
      }
      const absolute = path.join(directory, repository);
      const nestedPrefix = joinRelative(prefix, repository);
      // An uninitialized submodule is an empty folder, where git would list the outer repository
      if (!(await isRepositoryFolder(absolute))) return;
      if (!(await addRepository(build, absolute, nestedPrefix))) await addWalk(build, absolute, nestedPrefix);
    }),
  );
  return true;
}

/** Adds everything under `directory` (at `prefix` under the root), breadth first, without following links */
async function addWalk(build: ListingBuild, directory: string, prefix: string): Promise<void> {
  const queue = [""];
  // Repositories met on the way list through git while the walk goes on
  const repositories: Promise<void>[] = [];
  walk: for (let next = 0; next < queue.length; next++) {
    if (build.listing.incomplete) break;
    if (Date.now() > build.deadline) {
      build.listing.incomplete = true;
      break;
    }
    const folder = queue[next]!;
    const absolute = folder ? path.join(directory, folder) : directory;
    const dirents = await readdir(absolute, { withFileTypes: true }).catch(() => null);
    if (!dirents) continue;
    // A repository inside applies its own .gitignore; one git cannot list is walked like any folder
    if (folder !== "" && dirents.some((dirent) => dirent.name === ".git")) {
      const folderPrefix = joinRelative(prefix, folder);
      repositories.push(
        addRepository(build, absolute, folderPrefix).then((listed) =>
          listed ? undefined : addWalk(build, absolute, folderPrefix),
        ),
      );
      continue;
    }
    for (const dirent of dirents) {
      if (HIDDEN_NAMES.has(dirent.name)) continue;
      const relativePath = joinRelative(folder, dirent.name);
      const listedPath = joinRelative(prefix, relativePath);
      if (dirent.isDirectory()) {
        if (!addFolder(build, listedPath)) break walk;
        if (!UNSEARCHED_FOLDERS.has(dirent.name)) queue.push(relativePath);
      } else if (!addEntry(build, listedPath, dirent.isSymbolicLink() ? "unknown" : "file")) {
        break walk;
      }
    }
  }
  await Promise.all(repositories);
}

/**
 * Lists what a search under `root` can find. A folder in a repository lists through git, so its
 * .gitignore applies; anything else is walked, each repository met on the way listing through git
 */
async function listTree(root: string): Promise<Listing> {
  const build: ListingBuild = {
    listing: { paths: [], kinds: [], lowerPaths: null, incomplete: false },
    folders: new Set(),
    deadline: Date.now() + WALK_BUDGET_MS,
  };
  // Git lists nothing for an ignored folder or a repository without files; those are walked
  const listedByGit = await addRepository(build, root, "");
  if (!listedByGit || build.listing.paths.length === 0) await addWalk(build, root, "");
  return build.listing;
}

interface CachedListing {
  listing: Promise<Listing>;
}

const listings = new Map<string, CachedListing>();

/** The root's listing, shared by searches that start while it is fresh */
function cachedListing(root: string): Promise<Listing> {
  const key = process.platform === "win32" ? root.toLowerCase() : root;
  const cached = listings.get(key);
  if (cached) return cached.listing;
  const entry: CachedListing = { listing: listTree(root) };
  listings.set(key, entry);
  const forget = () => {
    if (listings.get(key) === entry) listings.delete(key);
  };
  // Freshness counts from when the listing is done, so a slow walk still serves the next keystroke
  entry.listing.then(() => setTimeout(forget, LISTING_TTL_MS).unref(), forget);
  return entry.listing;
}

/** Drops cached listings; the tree's own changes call this, so the next search sees them */
export function forgetSearchListings(): void {
  listings.clear();
}

function toEntry(relativePath: string, kind: "file" | "directory", matched: boolean): SearchEntry {
  const name = relativePath.slice(relativePath.lastIndexOf("/") + 1);
  return { name, path: relativePath, kind, icon: kind === "file" ? fileIconId(name) : undefined, matched };
}

function depthOf(relativePath: string): number {
  let depth = 0;
  for (let slash = relativePath.indexOf("/"); slash !== -1; slash = relativePath.indexOf("/", slash + 1)) depth++;
  return depth;
}

/**
 * Entries under `root` matching the filter text, with the folders that lead to them, in tree
 * order. The first MAX_LISTED_MATCHES matches nearest the root are listed; all are counted.
 */
export async function searchTree({
  root,
  query,
}: RpcInput<typeof searchTreeRpc>): Promise<RpcOutput<typeof searchTreeRpc>> {
  const filter = parseTreeFilter(query);
  if (!filter) return { entries: [], matchCount: 0, incomplete: false };
  const directory = path.resolve(root);
  if (!(await stat(directory).catch(() => null))?.isDirectory()) throw new Error(`Folder does not exist: ${root}`);
  const listing = await cachedListing(directory);
  const { paths, kinds } = listing;
  const lowerPaths = (listing.lowerPaths ??= paths.map((relativePath) => relativePath.toLowerCase()));
  const matches: { index: number; depth: number }[] = [];
  lowerPaths.forEach((lowerPath, index) => {
    if (matchesTreeFilter(filter, lowerPath)) matches.push({ index, depth: depthOf(lowerPath) });
  });
  matches.sort((left, right) => left.depth - right.depth || (paths[left.index]! < paths[right.index]! ? -1 : 1));
  const listed = matches.slice(0, MAX_LISTED_MATCHES).map((match) => match.index);
  await Promise.all(
    listed
      .filter((index) => kinds[index] === "unknown")
      .map(async (index) => {
        const target = await stat(path.join(directory, paths[index]!)).catch(() => null);
        // A broken link lists as a file, as in the tree
        kinds[index] = target?.isDirectory() ? "directory" : "file";
      }),
  );

  const shown = new Map<string, SearchEntry>();
  for (const index of listed) {
    shown.set(paths[index]!, toEntry(paths[index]!, kinds[index] === "directory" ? "directory" : "file", true));
  }
  for (const matchPath of [...shown.keys()]) {
    for (let slash = matchPath.lastIndexOf("/"); slash > 0; slash = matchPath.lastIndexOf("/", slash - 1)) {
      const folder = matchPath.slice(0, slash);
      // A folder already shown brings its own ancestors
      if (shown.has(folder)) break;
      shown.set(folder, toEntry(folder, "directory", matchesTreeFilter(filter, folder.toLowerCase())));
    }
  }
  // Shown folders are marked as the tree's listings mark them
  await mapLimited([...shown.values()], async (entry) => {
    if (entry.kind === "directory") entry.repository = await isRepositoryFolder(path.join(directory, entry.path));
  });
  const children = new Map<string, SearchEntry[]>();
  for (const entry of shown.values()) {
    const parent = entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/")));
    const siblings = children.get(parent);
    if (siblings) siblings.push(entry);
    else children.set(parent, [entry]);
  }
  for (const siblings of children.values()) siblings.sort(compareTreeEntries);
  const entries: SearchEntry[] = [];
  const pending = [...(children.get("") ?? [])].reverse();
  while (pending.length > 0) {
    const entry = pending.pop()!;
    entries.push(entry);
    const below = children.get(entry.path);
    if (below) for (let index = below.length - 1; index >= 0; index--) pending.push(below[index]!);
  }
  return { entries, matchCount: matches.length, incomplete: listing.incomplete };
}
