import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  copyEntryRpc,
  createEntryRpc,
  fileIconRpc,
  listDirectoryRpc,
  moveEntryRpc,
  openInFileBrowserRpc,
  openInTextEditorRpc,
  openTerminalRpc,
  openWithDefaultAppRpc,
  preferences,
  renameEntryRpc,
  searchTreeRpc,
  trashEntryRpc,
} from "./shared/contracts";
import {
  gitChangesRpc,
  gitCheckoutRpc,
  gitCommitDetailsRpc,
  gitCommitFileDiffRpc,
  gitCommitFileRpc,
  gitCommitRpc,
  gitDiffRpc,
  gitIgnoreRpc,
  gitLogRpc,
  gitRemoteRpc,
  gitRepositoriesRpc,
  gitRevertRpc,
  gitStageRpc,
  gitStatusRpc,
  gitUncommitRpc,
  gitWorktreeSummaryRpc,
  gitWorktreesRpc,
} from "./shared/git-contracts";
import {
  checkoutCommit,
  commit,
  commitDetails,
  commitFileDiff,
  commitFileSources,
  commitLog,
  fileDiff,
  ignorePath,
  listStatus,
  listWorktrees,
  remote,
  revertChanges,
  setStaged,
  uncommit,
  worktreeSummary,
} from "./server/git";
import { diffSourcesRpc } from "./shared/diff-contracts";
import { diffSources } from "./server/diff-sources";
import { stopGitWatches, waitForChanges } from "./server/git-watch";
import { stopGitObjectReaders } from "./server/object-reader";
import { moveEntry } from "./server/move";
import { copyEntry, createEntry, renameEntry } from "./server/entry-ops";
import { trashEntry } from "./server/trash";
import { openInFileBrowser, openWithDefaultApp } from "./server/file-browser";
import { openInTextEditor } from "./server/text-editor";
import { openTerminal } from "./server/terminal";
import { fileIcon } from "./server/file-icons";
import { listRepositories } from "./server/repositories";
import { listDirectory } from "./server/tree";
import { forgetSearchListings, searchTree } from "./server/tree-search";

/** A handler that changes files, after which cached search listings are stale */
function changingFiles<Input, Output>(handler: (input: Input) => Promise<Output>): (input: Input) => Promise<Output> {
  return async (input) => {
    try {
      return await handler(input);
    } finally {
      forgetSearchListings();
    }
  };
}

export default function contribute(server: PluginServerContext) {
  server.registerSettings(preferences);
  server.handle(listDirectoryRpc, listDirectory);
  server.handle(searchTreeRpc, searchTree);
  server.handle(fileIconRpc, fileIcon);
  server.handle(openInTextEditorRpc, openInTextEditor);
  server.handle(openInFileBrowserRpc, openInFileBrowser);
  server.handle(openTerminalRpc, openTerminal);
  server.handle(openWithDefaultAppRpc, openWithDefaultApp);
  server.handle(moveEntryRpc, changingFiles(moveEntry));
  server.handle(createEntryRpc, changingFiles(createEntry));
  server.handle(renameEntryRpc, changingFiles(renameEntry));
  server.handle(copyEntryRpc, changingFiles(copyEntry));
  server.handle(trashEntryRpc, changingFiles(trashEntry));
  server.handle(gitWorktreesRpc, listWorktrees);
  server.handle(gitWorktreeSummaryRpc, worktreeSummary);
  server.handle(gitRepositoriesRpc, listRepositories);
  server.handle(gitStatusRpc, listStatus);
  server.handle(gitStageRpc, setStaged);
  server.handle(gitDiffRpc, fileDiff);
  server.handle(gitLogRpc, commitLog);
  server.handle(gitCommitDetailsRpc, commitDetails);
  server.handle(gitCommitFileRpc, commitFileSources);
  server.handle(gitCommitFileDiffRpc, commitFileDiff);
  server.handle(gitCheckoutRpc, checkoutCommit);
  server.handle(gitChangesRpc, waitForChanges);
  server.handle(gitCommitRpc, commit);
  server.handle(gitUncommitRpc, uncommit);
  server.handle(gitRemoteRpc, remote);
  server.handle(gitIgnoreRpc, ignorePath);
  server.handle(gitRevertRpc, changingFiles(revertChanges));
  server.handle(diffSourcesRpc, diffSources);
  return () => {
    stopGitWatches();
    stopGitObjectReaders();
  };
}
