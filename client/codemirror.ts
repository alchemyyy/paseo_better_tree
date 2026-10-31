// CodeMirror ships inside the plugin as one vendored bundle (scripts/vendor.mjs). It loads on
// first use, so native clients and panels without an editor never evaluate it.
import type * as CodeMirror from "./vendor/codemirror";

let loaded: typeof CodeMirror | null = null;

export function codemirror(): typeof CodeMirror {
  loaded ??= require("./vendor/codemirror") as typeof CodeMirror;
  return loaded;
}
