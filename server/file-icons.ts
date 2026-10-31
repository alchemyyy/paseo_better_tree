import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { fileIconRpc } from "../shared/contracts";
import manifest from "./vendor/material-icons/manifest.json" with { type: "json" };

// File icons come from Material Icon Theme (MIT), vendored by scripts/vendor.mjs: its map from
// lowercased file names and extensions to icon ids, and the SVGs those ids name. The SVGs are
// bundled into the server, so clients only fetch the icons they show.

const fileNames: ReadonlyMap<string, string> = new Map(Object.entries(manifest.fileNames));
const fileExtensions: ReadonlyMap<string, string> = new Map(Object.entries(manifest.fileExtensions));
/** Icon id to SVG file name */
const iconFiles: ReadonlyMap<string, string> = new Map(Object.entries(manifest.iconFiles));
const fallback = manifest.file;

/** The icon id for a file name, matched like VS Code: the whole name, then the longest dotted suffix */
export function fileIconId(name: string): string {
  const lower = name.toLowerCase();
  const byName = fileNames.get(lower);
  if (byName) return byName;
  for (let dot = lower.indexOf("."); dot !== -1; dot = lower.indexOf(".", dot + 1)) {
    const byExtension = fileExtensions.get(lower.slice(dot + 1));
    if (byExtension) return byExtension;
  }
  return fallback;
}

/** An icon's SVG, in its light-theme variant when one exists; unknown ids get the generic file icon */
export function fileIcon({ icon, light }: RpcInput<typeof fileIconRpc>): RpcOutput<typeof fileIconRpc> {
  const variant = light && iconFiles.has(`${icon}_light`) ? `${icon}_light` : icon;
  const fileName = iconFiles.get(variant) ?? iconFiles.get(fallback) ?? "file.svg";
  // NOTE: esbuild bundles every SVG this pattern matches, as text (Paseo's ".svg" loader)
  const svg = require(`./vendor/material-icons/icons/${fileName}`) as string;
  return { svg };
}
