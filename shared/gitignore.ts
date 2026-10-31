/**
 * A .gitignore line matching exactly one worktree-relative path: anchored with a leading slash,
 * glob characters and backslashes escaped, trailing spaces kept, and a trailing slash for folders
 */
export function gitignorePattern(relativePath: string, isDirectory: boolean): string {
  const escaped = relativePath
    .replace(/\/+$/, "")
    .replace(/[\\*?[]/g, (character) => `\\${character}`)
    .replace(/ +$/, (spaces) => "\\ ".repeat(spaces.length));
  return `/${escaped}${isDirectory ? "/" : ""}`;
}

/** `content` with `line` appended on a line of its own, or null when the line is already there */
export function appendGitignoreLine(content: string, line: string): string | null {
  const lines = content.split(/\r?\n/);
  if (lines.includes(line)) return null;
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const separator = content === "" || content.endsWith("\n") ? "" : newline;
  return `${content}${separator}${line}${newline}`;
}
