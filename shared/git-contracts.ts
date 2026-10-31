import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const WorktreeSchema = z.object({
  /** Absolute worktree top-level directory on the daemon host */
  path: z.string(),
  /** Short branch name, or null when HEAD is detached */
  branch: z.string().nullable(),
  head: z.string(),
  /** The worktree holding the listed folder: the workspace directory, or a repository the Git panel focuses */
  current: z.boolean(),
  /** Registered with git but its directory is gone (prunable); nothing to show */
  missing: z.boolean(),
});
export type Worktree = z.infer<typeof WorktreeSchema>;

/** What a worktree row shows beyond the list, read separately because it costs a status per worktree */
export const WorktreeSummarySchema = z.object({
  additions: z.number().int(),
  deletions: z.number().int(),
  /** Latest of the HEAD commit time and changed files' modification times */
  modifiedAt: z.string().nullable(),
});
export type WorktreeSummary = z.infer<typeof WorktreeSummarySchema>;

export const GitFileSchema = z.object({
  /** Path relative to the worktree top level, forward slashes */
  path: z.string(),
  /** Has changes in the index */
  staged: z.boolean(),
  /** Tracked file with unstaged working-tree changes */
  modified: z.boolean(),
  untracked: z.boolean(),
  /** New in the index (was untracked before staging) */
  added: z.boolean(),
  additions: z.number().int(),
  deletions: z.number().int(),
});
export type GitFile = z.infer<typeof GitFileSchema>;

export const CommitSchema = z.object({
  sha: z.string(),
  shortSha: z.string(),
  author: z.string(),
  time: z.string(),
  subject: z.string(),
  /** Local branches pointing at this commit */
  branches: z.array(z.string()),
  isHead: z.boolean(),
});
export type Commit = z.infer<typeof CommitSchema>;

export const RepositorySchema = z.object({
  /** Absolute top-level folder */
  path: z.string(),
  /** Forward-slash path from the folder searched */
  relativePath: z.string(),
  /** Checked-out branch; null when HEAD is detached or unreadable */
  branch: z.string().nullable(),
});
export type Repository = z.infer<typeof RepositorySchema>;

export const CheckoutActionSchema = z.enum(["switch-branch", "checkout-detached", "new-worktree"]);
export type CheckoutAction = z.infer<typeof CheckoutActionSchema>;

const WorktreeInputSchema = z.object({ worktree: z.string().min(1) });

export const gitWorktreesRpc = defineRpc({
  name: "git.worktrees",
  input: z.object({ root: z.string().min(1) }),
  /** The worktree holding `root` first, then its repository's others; none when `root` is in no repository */
  output: z.object({ worktrees: z.array(WorktreeSchema) }),
});

export const gitWorktreeSummaryRpc = defineRpc({
  name: "git.worktree-summary",
  input: WorktreeInputSchema,
  output: WorktreeSummarySchema,
});

export const gitRepositoriesRpc = defineRpc({
  name: "git.repositories",
  input: z.object({ root: z.string().min(1) }),
  output: z.object({
    /** The repositories inside `root`, outermost only, in tree order; none when `root` is in a repository */
    repositories: z.array(RepositorySchema),
    /** The search stopped early in a very large folder, so repositories may be missing */
    incomplete: z.boolean(),
  }),
});

export const gitStatusRpc = defineRpc({
  name: "git.status",
  input: WorktreeInputSchema,
  output: z.object({ files: z.array(GitFileSchema) }),
});

export const gitStageRpc = defineRpc({
  name: "git.stage",
  input: WorktreeInputSchema.extend({ paths: z.array(z.string().min(1)).min(1), staged: z.boolean() }),
  /** The worktree's status read right after the change, so the panel never shows one from before it */
  output: z.object({ files: z.array(GitFileSchema) }),
});

export const gitDiffRpc = defineRpc({
  name: "git.diff",
  input: WorktreeInputSchema.extend({ path: z.string().min(1) }),
  output: z.object({ diff: z.string() }),
});

export const gitLogRpc = defineRpc({
  name: "git.log",
  input: WorktreeInputSchema.extend({ limit: z.number().int().min(1).max(1000).optional() }),
  output: z.object({ commits: z.array(CommitSchema) }),
});

export const CommitModeSchema = z.enum(["staged", "tracked", "amend"]);
export type CommitMode = z.infer<typeof CommitModeSchema>;

export const gitCommitRpc = defineRpc({
  name: "git.commit",
  input: WorktreeInputSchema.extend({
    /** Empty only for an amend, which then keeps the previous message */
    message: z.string(),
    mode: CommitModeSchema,
  }),
  output: z.object({ sha: z.string(), subject: z.string() }),
});

export const gitUncommitRpc = defineRpc({
  name: "git.uncommit",
  input: WorktreeInputSchema,
  /** The undone commit's full message, to put back in the editor */
  output: z.object({ message: z.string() }),
});

export const RemoteActionSchema = z.enum(["fetch", "pull", "push"]);
export type RemoteAction = z.infer<typeof RemoteActionSchema>;

export const gitRemoteRpc = defineRpc({
  name: "git.remote",
  input: WorktreeInputSchema.extend({ action: RemoteActionSchema }),
  output: z.object({ message: z.string() }),
});

export const gitChangesRpc = defineRpc({
  name: "git.changes",
  input: WorktreeInputSchema.extend({
    /** The version last seen; 0 to get the current one immediately */
    version: z.number(),
  }),
  output: z.object({ version: z.number() }),
});

export const gitCheckoutRpc = defineRpc({
  name: "git.checkout",
  input: WorktreeInputSchema.extend({
    sha: z.string().regex(/^[0-9a-f]{7,64}$/),
    action: CheckoutActionSchema,
    branch: z.string().min(1).optional(),
  }),
  output: z.object({ message: z.string(), worktreePath: z.string().optional() }),
});

export const gitIgnoreRpc = defineRpc({
  name: "git.ignore",
  input: WorktreeInputSchema.extend({
    /** Worktree-relative path, forward slashes */
    path: z.string().min(1),
    kind: z.enum(["file", "directory"]),
  }),
  /** The line in the worktree's top-level .gitignore; `added` is false when it was already there */
  output: z.object({ pattern: z.string(), added: z.boolean() }),
});

export const gitRevertRpc = defineRpc({
  name: "git.revert",
  /**
   * Changed files to return to HEAD, staged and unstaged together. Files new since HEAD leave the
   * index and go to the Recycle Bin or Trash
   */
  input: WorktreeInputSchema.extend({ paths: z.array(z.string().min(1)).min(1) }),
  output: z.object({}),
});
