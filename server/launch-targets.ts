import type { LaunchCommand } from "./windows-command";

/**
 * Windows: Windows Terminal in the folder with its default profile. The folder is the working
 * directory, so no path goes through wt's argument parsing, which expands %VARIABLES% and splits
 * on ";". Without wt, `start` opens a cmd.exe console; the outer cmd is detached, so it has no
 * console of its own and the window outlives the plugin process.
 */
export function windowsTerminalCandidates(directory: string): LaunchCommand[] {
  return [
    { command: "wt.exe", args: ["-d", "."], cwd: directory },
    {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", '"start "" cmd.exe"'],
      windowsVerbatimArguments: true,
      cwd: directory,
    },
  ];
}

/** macOS: Terminal.app in the folder */
export function macTerminalCommand(directory: string): LaunchCommand {
  return { command: "open", args: ["-a", "Terminal", directory] };
}

/** Linux terminal emulators in preference order, with each one's working-directory option */
const LINUX_TERMINALS: readonly { command: string; openIn(directory: string): string[] }[] = [
  { command: "x-terminal-emulator", openIn: () => [] },
  { command: "gnome-terminal", openIn: (directory) => [`--working-directory=${directory}`] },
  { command: "konsole", openIn: (directory) => ["--workdir", directory] },
  { command: "xfce4-terminal", openIn: (directory) => [`--working-directory=${directory}`] },
  { command: "kitty", openIn: (directory) => ["--directory", directory] },
  { command: "alacritty", openIn: (directory) => ["--working-directory", directory] },
  { command: "xterm", openIn: () => [] },
];

/** Linux candidates; each also starts in the folder for emulators without an option */
export function linuxTerminalCandidates(directory: string): LaunchCommand[] {
  return LINUX_TERMINALS.map((terminal) => ({
    command: terminal.command,
    args: terminal.openIn(directory),
    cwd: directory,
  }));
}
