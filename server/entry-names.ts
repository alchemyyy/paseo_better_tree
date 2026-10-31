// Characters Windows refuses in a name, plus control characters
const WINDOWS_INVALID = /[<>:"|?*\u0000-\u001F]/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/** Why `name` cannot name a file or folder, or null when it can */
export function entryNameProblem(name: string, platform: NodeJS.Platform): string | null {
  if (name.trim() === "") return "A name is required";
  if (name === "." || name === "..") return `"${name}" is not a valid name`;
  if (/[\\/]/.test(name)) return "Names cannot contain / or \\";
  if (platform === "win32") {
    if (WINDOWS_INVALID.test(name)) return 'Names cannot contain < > : " | ? *';
    if (/[. ]$/.test(name)) return "Names cannot end with a space or a period";
    if (WINDOWS_RESERVED.test(name)) return `"${name}" is reserved by Windows`;
  } else if (name.includes("\u0000")) {
    return "Names cannot contain a null character";
  }
  return null;
}

/**
 * The `attempt`th name for a copy of `name`: "notes copy.txt", then "notes copy 2.txt", ...
 * A leading dot is part of the name, so ".gitignore" becomes ".gitignore copy".
 */
export function copyName(name: string, isDirectory: boolean, attempt: number): string {
  const dot = isDirectory ? -1 : name.lastIndexOf(".");
  const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  return `${stem} copy${attempt > 1 ? ` ${attempt}` : ""}${extension}`;
}
