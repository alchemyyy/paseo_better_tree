import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const DiffModeSchema = z.enum(["source", "unified", "changes", "split"]);
/** How a file shows: the plain editor, a unified diff, only the changed hunks, or side by side */
export type DiffMode = z.infer<typeof DiffModeSchema>;

export const diffSourcesRpc = defineRpc({
  name: "diff.sources",
  input: z.object({
    /** Absolute, or relative to the workspace directory */
    path: z.string().min(1),
    /** Needed when `path` is relative */
    workspaceId: z.string().optional(),
  }),
  output: z.object({
    absolutePath: z.string(),
    /** Text on disk, null when deleted, binary, or too large */
    current: z.string().nullable(),
    /** Text at HEAD, "" for a new file, null outside a repository or for binary content */
    original: z.string().nullable(),
  }),
});
