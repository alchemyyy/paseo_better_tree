import assert from "node:assert/strict";
import { test } from "node:test";
import { linuxTerminalCandidates, windowsTerminalCandidates } from "./launch-targets.ts";

test("windowsTerminalCandidates opens Windows Terminal by working directory, without a profile command", () => {
  const [wt, fallback] = windowsTerminalCandidates("C:\\a;b %PATH%");
  assert.deepEqual(wt, { command: "wt.exe", args: ["-d", "."], cwd: "C:\\a;b %PATH%" });
  assert.equal(fallback?.cwd, "C:\\a;b %PATH%");
  assert.ok(fallback?.args.every((arg) => !arg.includes("%PATH%")));
});

test("linuxTerminalCandidates start every emulator in the folder", () => {
  const candidates = linuxTerminalCandidates("/w x");
  assert.ok(candidates.every((candidate) => candidate.cwd === "/w x"));
  assert.deepEqual(
    candidates.find((candidate) => candidate.command === "gnome-terminal")?.args,
    ["--working-directory=/w x"],
  );
});
