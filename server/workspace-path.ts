import path from "node:path";

/** Normalizes a workspace-relative path to forward slashes with no leading "./" or trailing "/" */
export function normalizeRelativePath(relativePath: string): string {
  const segments: string[] = [];
  for (const segment of relativePath.replace(/\\/g, "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    segments.push(segment);
  }
  return segments.join("/");
}

/** Resolves a workspace-relative path and rejects anything that escapes the workspace root */
export function resolveInsideRoot(root: string, relativePath: string): string {
  const rootPath = path.resolve(root);
  const target = path.resolve(rootPath, normalizeRelativePath(relativePath) || ".");
  const relative = path.relative(rootPath, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Path is outside the workspace: ${relativePath}`);
  }
  return target;
}
