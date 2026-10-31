/** Tree commands that have a keyboard shortcut, as in VS Code's Explorer */
export type TreeCommand =
  | "cut"
  | "copy"
  | "paste"
  | "copyPath"
  | "copyRelativePath"
  | "rename"
  | "delete"
  | "revealInFileBrowser"
  /** Focuses the tree's filter field */
  | "find";

/** One key press; `code` is the physical key ("KeyC"), so letters match on every keyboard layout */
export interface KeyStroke {
  key: string;
  code: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
}

/** "Mod" is Cmd on macOS and Ctrl elsewhere; a space separates the presses of a chord */
const BINDINGS: Readonly<Record<TreeCommand, { other: string; mac: string }>> = {
  cut: { other: "Mod+X", mac: "Mod+X" },
  copy: { other: "Mod+C", mac: "Mod+C" },
  paste: { other: "Mod+V", mac: "Mod+V" },
  copyPath: { other: "Shift+Alt+C", mac: "Mod+Alt+C" },
  copyRelativePath: { other: "Mod+K Mod+Shift+C", mac: "Mod+Shift+Alt+C" },
  rename: { other: "F2", mac: "Enter" },
  delete: { other: "Delete", mac: "Mod+Backspace" },
  revealInFileBrowser: { other: "Shift+Alt+R", mac: "Mod+Alt+R" },
  find: { other: "Mod+F", mac: "Mod+F" },
};

/** How long the second press of a chord may wait */
export const CHORD_TIMEOUT_MS = 1500;

interface Press {
  key: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
}

function parsePress(text: string): Press {
  const parts = text.split("+");
  return {
    key: parts[parts.length - 1]!,
    mod: parts.includes("Mod"),
    shift: parts.includes("Shift"),
    alt: parts.includes("Alt"),
  };
}

function bindingPresses(command: TreeCommand, mac: boolean): Press[] {
  return (mac ? BINDINGS[command].mac : BINDINGS[command].other).split(" ").map(parsePress);
}

const COMMANDS = Object.keys(BINDINGS) as TreeCommand[];
const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "AltGraph"]);
const KEY_LABELS: Readonly<Record<string, string>> = { Delete: "Del", Backspace: "Backspace" };

/** Menu label for a command's shortcut: "Ctrl+X", "Shift+Alt+C", "Cmd+K Cmd+Shift+C", ... */
export function shortcutLabel(command: TreeCommand, mac: boolean): string {
  return bindingPresses(command, mac)
    .map((press) =>
      [
        press.mod ? (mac ? "Cmd" : "Ctrl") : null,
        press.shift ? "Shift" : null,
        press.alt ? (mac ? "Option" : "Alt") : null,
        KEY_LABELS[press.key] ?? press.key,
      ]
        .filter((part) => part !== null)
        .join("+"),
    )
    .join(" ");
}

function matchesPress(stroke: KeyStroke, press: Press, mac: boolean): boolean {
  const mod = mac ? stroke.meta : stroke.ctrl;
  const otherMod = mac ? stroke.ctrl : stroke.meta;
  if (mod !== press.mod || otherMod || stroke.shift !== press.shift || stroke.alt !== press.alt) return false;
  const letter = /^Key([A-Z])$/.exec(stroke.code)?.[1];
  return (letter ?? stroke.key) === press.key;
}

/**
 * Matches key presses to commands, remembering the first press of a chord. Returns the
 * command, "pending" after a chord's first press (the caller should swallow it), or null.
 */
export function createShortcutMatcher(mac: boolean): (stroke: KeyStroke, now: number) => TreeCommand | "pending" | null {
  const bindings = COMMANDS.map((command) => ({ command, presses: bindingPresses(command, mac) }));
  let chord: { presses: Press[]; at: number }[] = [];
  return (stroke, now) => {
    // Pressing Ctrl on its way to Ctrl+Shift+C must not break the chord
    if (MODIFIER_KEYS.has(stroke.key)) return chord.length > 0 ? "pending" : null;
    const waiting = chord.filter((pending) => now - pending.at <= CHORD_TIMEOUT_MS);
    chord = [];
    for (const pending of waiting) {
      const binding = bindings.find((candidate) => candidate.presses === pending.presses);
      if (binding && matchesPress(stroke, pending.presses[1]!, mac)) return binding.command;
    }
    for (const binding of bindings) {
      if (!matchesPress(stroke, binding.presses[0]!, mac)) continue;
      if (binding.presses.length === 1) return binding.command;
      chord.push({ presses: binding.presses, at: now });
    }
    return chord.length > 0 ? "pending" : null;
  };
}
