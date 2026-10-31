import type { Stats } from "node:fs";
import { cp, lstat, mkdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { copyEntryRpc, createEntryRpc, renameEntryRpc } from "../shared/contracts";
import { copyName, entryNameProblem } from "./entry-names";
import { resolveInsideRoot } from "./workspace-path";

/** Gives up on finding a free copy name after this many attempts */
const MAX_COPY_ATTEMPTS = 1000;

/** Creates an empty file or a folder; never overwrites */
export async function createEntry({
  root,
  path: parentPath,
  name,
  kind,
}: RpcInput<typeof createEntryRpc>): Promise<RpcOutput<typeof createEntryRpc>> {
  assertValidName(name);
  const parent = resolveInsideRoot(root, parentPath);
  if (!(await stat(parent)).isDirectory()) throw new Error(`${parentPath || "The tree root"} is not a folder`);
  const target = path.join(parent, name);
  try {
    if (kind === "directory") await mkdir(target);
    else await writeFile(target, "", { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`"${name}" already exists`);
    throw error;
  }
  return { path: relativeTo(root, target) };
}

/** Renames a file or folder in place; never overwrites, but a case-only rename works */
export async function renameEntry({
  root,
  path: relativePath,
  name,
}: RpcInput<typeof renameEntryRpc>): Promise<RpcOutput<typeof renameEntryRpc>> {
  assertValidName(name);
  const source = resolveInsideRoot(root, relativePath);
  if (source === path.resolve(root)) throw new Error("The tree root cannot be renamed here");
  const target = path.join(path.dirname(source), name);
  if (target === source) return { path: relativePath };
  const existing = await lstatOrNull(target);
  const sourceStats = await lstat(source);
  // On a case-insensitive disk, "readme.md" -> "README.md" finds the source itself
  if (existing && (existing.dev !== sourceStats.dev || existing.ino !== sourceStats.ino)) {
    throw new Error(`"${name}" already exists`);
  }
  await rename(source, target);
  return { path: relativeTo(root, target) };
}

/** Copies a file or folder into a folder, naming it "<name> copy" when the name is taken */
export async function copyEntry({
  source,
  toDirectory,
}: RpcInput<typeof copyEntryRpc>): Promise<RpcOutput<typeof copyEntryRpc>> {
  if (!path.isAbsolute(source) || !path.isAbsolute(toDirectory)) throw new Error("Copies need absolute paths");
  const resolvedSource = path.resolve(source);
  const destination = path.resolve(toDirectory);
  const sourceStats = await lstat(resolvedSource);
  if (!(await stat(destination)).isDirectory()) throw new Error(`${destination} is not a folder`);
  const fromSource = path.relative(resolvedSource, destination);
  if (fromSource === "" || (!fromSource.startsWith("..") && !path.isAbsolute(fromSource))) {
    throw new Error("A folder cannot be copied into itself");
  }
  const name = path.basename(resolvedSource);
  let target = path.join(destination, name);
  for (let attempt = 1; await lstatOrNull(target); attempt++) {
    if (attempt > MAX_COPY_ATTEMPTS) throw new Error(`No free name for a copy of "${name}"`);
    target = path.join(destination, copyName(name, sourceStats.isDirectory(), attempt));
  }
  // Links are copied as links, so a copied folder never pulls in what its links point at
  await cp(resolvedSource, target, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
  return { path: target };
}

function assertValidName(name: string): void {
  const problem = entryNameProblem(name, process.platform);
  if (problem) throw new Error(problem);
}

function relativeTo(root: string, target: string): string {
  return path.relative(path.resolve(root), target).split(path.sep).join("/");
}

async function lstatOrNull(filePath: string): Promise<Stats | null> {
  try {
    return await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
