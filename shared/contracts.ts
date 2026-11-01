import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { ArrangementSchema } from "./arrangement";

export const TreeEntrySchema = z.object({
  name: z.string(),
  /** Workspace-relative path with forward slashes */
  path: z.string(),
  kind: z.enum(["file", "directory"]),
  /** Files only: the file-type icon id, drawn with `fileIconRpc` */
  icon: z.string().optional(),
  /** Folders only: the top level of a Git repository or worktree, which holds a `.git` folder or file */
  repository: z.boolean().optional(),
});
export type TreeEntry = z.infer<typeof TreeEntrySchema>;

const WorkspacePathInputSchema = z.object({
  /** Absolute workspace directory on the daemon host */
  root: z.string().min(1),
  /** Workspace-relative path; empty for the root */
  path: z.string(),
});

export const listDirectoryRpc = defineRpc({
  name: "tree.list",
  input: WorkspacePathInputSchema,
  output: z.object({ entries: z.array(TreeEntrySchema) }),
});

export const SearchEntrySchema = TreeEntrySchema.extend({
  /** The entry matches the filter; false for a folder shown because a match is inside it */
  matched: z.boolean(),
});
export type SearchEntry = z.infer<typeof SearchEntrySchema>;

export const searchTreeRpc = defineRpc({
  name: "tree.search",
  input: z.object({
    /** Absolute folder the tree view lists */
    root: z.string().min(1),
    /** Filter text, as parseTreeFilter (shared/tree-filter.ts) reads it */
    query: z.string(),
  }),
  output: z.object({
    /** The listed matches and the folders leading to them, in tree order */
    entries: z.array(SearchEntrySchema),
    /** Every match found; more than the listed ones when the list was capped */
    matchCount: z.number().int(),
    /** The search stopped early in a very large folder, so matches may be missing */
    incomplete: z.boolean(),
  }),
});

export const openInTextEditorRpc = defineRpc({
  name: "tree.open-in-text-editor",
  input: WorkspacePathInputSchema,
  output: z.object({ editor: z.string() }),
});

export const openInFileBrowserRpc = defineRpc({
  name: "tree.open-in-file-browser",
  input: WorkspacePathInputSchema,
  output: z.object({}),
});

export const openTerminalRpc = defineRpc({
  name: "tree.open-terminal",
  input: WorkspacePathInputSchema,
  output: z.object({ terminal: z.string() }),
});

export const openWithDefaultAppRpc = defineRpc({
  name: "tree.open-with-default-app",
  input: WorkspacePathInputSchema,
  output: z.object({}),
});

export const createEntryRpc = defineRpc({
  name: "tree.create",
  input: WorkspacePathInputSchema.extend({
    /** Name of the new file or folder inside the folder at `path` */
    name: z.string(),
    kind: z.enum(["file", "directory"]),
  }),
  /** Workspace-relative path of the new entry */
  output: z.object({ path: z.string() }),
});

export const renameEntryRpc = defineRpc({
  name: "tree.rename",
  input: WorkspacePathInputSchema.extend({ name: z.string() }),
  /** Workspace-relative path after the rename */
  output: z.object({ path: z.string() }),
});

export const copyEntryRpc = defineRpc({
  name: "tree.copy",
  // Absolute paths, since the clipboard is shared by tree views rooted at different folders
  input: z.object({
    /** Absolute path of the file or folder to copy */
    source: z.string().min(1),
    /** Absolute folder to copy into; a taken name gets " copy", " copy 2", ... */
    toDirectory: z.string().min(1),
  }),
  /** Absolute path of the copy */
  output: z.object({ path: z.string() }),
});

export const trashEntryRpc = defineRpc({
  name: "tree.trash",
  input: WorkspacePathInputSchema,
  output: z.object({}),
});

export const moveEntryRpc = defineRpc({
  name: "tree.move",
  // Absolute paths, since tree views can be rooted at different folders
  input: z.object({
    /** Absolute path of the file or folder to move */
    source: z.string().min(1),
    /** Absolute destination folder */
    toDirectory: z.string().min(1),
  }),
  /** Absolute path after the move */
  output: z.object({ path: z.string() }),
});

export const fileIconRpc = defineRpc({
  name: "tree.file-icon",
  input: z.object({
    /** Icon id from a listed file */
    icon: z.string().min(1),
    /** A light theme gets the icon's light variant where one exists */
    light: z.boolean(),
  }),
  output: z.object({ svg: z.string() }),
});

// Each Ctrl/Shift/Alt+scroll notch moves one step
export const MIN_ROW_PADDING = 0;
export const MAX_ROW_PADDING = 16;
export const DEFAULT_ROW_PADDING = 3;
export const ROW_PADDING_STEP = 0.5;
export const MIN_FONT_WEIGHT = 100;
export const MAX_FONT_WEIGHT = 900;
export const DEFAULT_FONT_WEIGHT = 400;
export const FONT_WEIGHT_STEP = 50;
export const MIN_FONT_SIZE = 9;
export const MAX_FONT_SIZE = 24;
export const DEFAULT_FONT_SIZE = 13;
export const FONT_SIZE_STEP = 0.5;

export const preferences = defineSettings({
  id: "preferences",
  scope: "host",
  version: 1,
  schema: z.object({
    autoOpen: z.boolean().default(true),
    /** Moves the tree out of Explorer into a workspace pane; named for the stock Changes it once sat beside */
    arrangeBesideChanges: z.boolean().default(true),
    autoOpenGit: z.boolean().default(true),
    rowPadding: z
      .number()
      .multipleOf(ROW_PADDING_STEP)
      .min(MIN_ROW_PADDING)
      .max(MAX_ROW_PADDING)
      .default(DEFAULT_ROW_PADDING),
    // Global pane layout, captured from the user's edits and applied to every workspace
    /** Placement and sizes of the file tree and Git panes around the rest of the workspace */
    arrangement: ArrangementSchema.nullable().default(null),
    /** Explorer dock width in points */
    explorerWidth: z.number().positive().nullable().default(null),
    /**
     * Git panel section heights, top to bottom. No fixed length: a stored list from an older
     * section layout must stay valid, and the panel ignores one of the wrong length
     */
    gitSections: z.array(z.number().min(0)).nullable().default(null),
    fontWeight: z
      .number()
      .multipleOf(FONT_WEIGHT_STEP)
      .min(MIN_FONT_WEIGHT)
      .max(MAX_FONT_WEIGHT)
      .default(DEFAULT_FONT_WEIGHT),
    /** File tree text size in points; row icons follow it */
    fontSize: z
      .number()
      .multipleOf(FONT_SIZE_STEP)
      .min(MIN_FONT_SIZE)
      .max(MAX_FONT_SIZE)
      .default(DEFAULT_FONT_SIZE),
    /** File tree colors changed files and their folders */
    treeGitChanges: z.boolean().default(false),
    /** Git changes list: one section per category */
    changesGrouped: z.boolean().default(false),
    /** Git changes list: files nested under their folders */
    changesFolders: z.boolean().default(false),
    /** Commit tabs: the changes tree's share of the tab's width, or of its height on phones */
    commitTreeShare: z.number().min(0).max(1).nullable().default(null),
  }),
});
