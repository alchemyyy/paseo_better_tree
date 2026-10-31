import { lstat, rename, stat } from "node:fs/promises";
import path from "node:path";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { moveEntryRpc } from "../shared/contracts";

/** Moves a file or folder into another folder, never overwriting and never into itself */
export async function moveEntry({
  source,
  toDirectory,
}: RpcInput<typeof moveEntryRpc>): Promise<RpcOutput<typeof moveEntryRpc>> {
  if (!path.isAbsolute(source) || !path.isAbsolute(toDirectory)) {
    throw new Error("Moves need absolute paths");
  }
  const resolvedSource = path.resolve(source);
  const destinationDirectory = path.resolve(toDirectory);
  if (path.dirname(resolvedSource) === resolvedSource) throw new Error("A filesystem root cannot be moved");
  const fromSource = path.relative(resolvedSource, destinationDirectory);
  const outsideSource =
    fromSource === ".." || fromSource.startsWith(`..${path.sep}`) || path.isAbsolute(fromSource);
  if (!outsideSource) throw new Error("A folder cannot be moved into itself");
  if (!(await stat(destinationDirectory)).isDirectory()) {
    throw new Error(`${destinationDirectory} is not a folder`);
  }
  const target = path.join(destinationDirectory, path.basename(resolvedSource));
  if (target === resolvedSource) return { path: target };
  if (await exists(target)) throw new Error(`${target} already exists`);
  await rename(resolvedSource, target);
  return { path: target };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
