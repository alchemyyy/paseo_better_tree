import assert from "node:assert/strict";
import { test } from "node:test";
import { fileIconId } from "./file-icons.ts";

test("fileIconId: whole names beat extensions, longer suffixes beat shorter, case is ignored", () => {
  // README.md has a name icon; an ordinary .md file gets the extension one
  assert.notEqual(fileIconId("README.md"), fileIconId("notes.md"));
  assert.equal(fileIconId("readme.MD"), fileIconId("README.md"));
  // test.ts is a longer suffix than ts
  assert.notEqual(fileIconId("parser.test.ts"), fileIconId("parser.ts"));
  assert.equal(fileIconId("PHOTO.PNG"), fileIconId("photo.png"));
  // No match falls back to the generic file icon, as does a name with no extension
  assert.equal(fileIconId("data.no-such-extension"), fileIconId("NO_SUCH_NAME"));
});
