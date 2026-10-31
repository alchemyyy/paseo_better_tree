import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildWindowsLaunch,
  explorerArgument,
  parseRegistryValue,
  parseWindowsCommandLine,
} from "./windows-command.ts";

const environment: Record<string, string> = { SystemRoot: "C:\\Windows" };
const readEnvironment = (name: string) => environment[name];

test("parseWindowsCommandLine keeps quoted spaces", () => {
  assert.deepEqual(parseWindowsCommandLine('"C:\\Program Files\\Code\\Code.exe" "%1" --new'), [
    "C:\\Program Files\\Code\\Code.exe",
    "%1",
    "--new",
  ]);
});

test("buildWindowsLaunch expands environment references and substitutes the file", () => {
  assert.deepEqual(
    buildWindowsLaunch("%SystemRoot%\\system32\\NOTEPAD.EXE %1", "C:\\a b\\c.txt", readEnvironment),
    { command: "C:\\Windows\\system32\\NOTEPAD.EXE", args: ["C:\\a b\\c.txt"] },
  );
});

test("buildWindowsLaunch appends the file when the template has no placeholder", () => {
  assert.deepEqual(buildWindowsLaunch('"C:\\Tools\\ed.exe" %*', "C:\\x.txt", readEnvironment), {
    command: "C:\\Tools\\ed.exe",
    args: ["C:\\x.txt"],
  });
  assert.equal(buildWindowsLaunch("   ", "C:\\x.txt", readEnvironment), null);
});

test("parseRegistryValue reads REG_SZ and REG_EXPAND_SZ data", () => {
  assert.equal(
    parseRegistryValue(
      "\r\nHKEY_CLASSES_ROOT\\txtfile\\shell\\open\\command\r\n    (Default)    REG_EXPAND_SZ    %SystemRoot%\\system32\\NOTEPAD.EXE %1\r\n",
    ),
    "%SystemRoot%\\system32\\NOTEPAD.EXE %1",
  );
  assert.equal(parseRegistryValue("    ProgId    REG_SZ    txtfile\r\n    Hash    REG_SZ    x="), "txtfile");
  assert.equal(parseRegistryValue("ERROR: not found"), null);
});

test("explorerArgument selects a file and quotes paths with spaces and commas", () => {
  assert.equal(explorerArgument("C:\\a b\\x,y.txt", true), '/select,"C:\\a b\\x,y.txt"');
  assert.equal(explorerArgument("C:\\a b\\x,y.txt", false), '"C:\\a b\\x,y.txt"');
});

test("explorerArgument leaves a drive root unquoted so its slash is not read as an escaped quote", () => {
  assert.equal(explorerArgument("C:\\", false), "C:\\");
});
