export interface LaunchCommand {
  command: string;
  args: string[];
  /** Windows only: pass `args` without Node's quoting, for programs that parse their own command line */
  windowsVerbatimArguments?: boolean;
  cwd?: string;
}

const ENVIRONMENT_REFERENCE = /%([A-Za-z_][A-Za-z0-9_()]*)%/g;
const FILE_PLACEHOLDER = /%[1lL]/g;
const UNUSED_PLACEHOLDER = /^%(?:\d|\*)$/;

/** Splits a Windows command line on unquoted whitespace, dropping the quotes */
export function parseWindowsCommandLine(commandLine: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuotes = false;
  let hasToken = false;
  for (const character of commandLine) {
    if (character === '"') {
      inQuotes = !inQuotes;
      hasToken = true;
      continue;
    }
    if (!inQuotes && (character === " " || character === "\t")) {
      if (hasToken) tokens.push(current);
      current = "";
      hasToken = false;
      continue;
    }
    current += character;
    hasToken = true;
  }
  if (hasToken) tokens.push(current);
  return tokens;
}

/**
 * Turns a registry `shell\open\command` template such as `%SystemRoot%\system32\NOTEPAD.EXE %1`
 * into argv for `filePath`. Returns null for an empty template.
 */
export function buildWindowsLaunch(
  commandTemplate: string,
  filePath: string,
  readEnvironment: (name: string) => string | undefined,
): LaunchCommand | null {
  const expanded = commandTemplate.replace(
    ENVIRONMENT_REFERENCE,
    (reference: string, name: string) => readEnvironment(name) ?? reference,
  );
  const tokens = parseWindowsCommandLine(expanded);
  const command = tokens[0];
  if (!command) return null;
  const args: string[] = [];
  let usedFilePath = false;
  for (const token of tokens.slice(1)) {
    const substituted = token.replace(FILE_PLACEHOLDER, () => filePath);
    if (substituted !== token) {
      usedFilePath = true;
      args.push(substituted);
      continue;
    }
    if (UNUSED_PLACEHOLDER.test(token)) continue;
    args.push(token);
  }
  if (!usedFilePath) args.push(filePath);
  return { command, args };
}

/** Reads the string data of a `reg.exe query` result */
export function parseRegistryValue(output: string): string | null {
  const match = /REG_(?:EXPAND_)?SZ[ \t]+(.+)$/m.exec(output);
  const value = match?.[1]?.trim();
  return value ? value : null;
}

/**
 * Explorer argument that opens `target` (a folder, or a file in its default app) or, with
 * `select`, shows it selected in its folder; a drive root keeps its trailing slash unquoted
 */
export function explorerArgument(target: string, select: boolean): string {
  const quoted = target.endsWith("\\") ? target : `"${target}"`;
  return select ? `/select,${quoted}` : quoted;
}
