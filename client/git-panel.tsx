import type { PluginTheme } from "@getpaseo/plugin";
import {
  type PluginWorkspacePanelProps,
  useRpc,
  useSettings,
  useTabState,
  useWorkspace,
} from "@getpaseo/plugin/client";
import { openInFileBrowserRpc, preferences } from "../shared/contracts";
import { gitignorePattern } from "../shared/gitignore";
import { useGlobalLayout } from "./global-layout";
import { savePreferences } from "./preference-saver";
import { FlatList, Icon, Loading, useToast } from "@getpaseo/plugin/client/ui";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type GestureResponderEvent,
  type LayoutChangeEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  type Commit,
  type CommitMode,
  type GitFile,
  gitCheckoutRpc,
  gitCommitRpc,
  gitIgnoreRpc,
  gitLogRpc,
  gitRemoteRpc,
  gitRepositoriesRpc,
  gitRevertRpc,
  gitStatusRpc,
  gitUncommitRpc,
  gitWorktreeSummaryRpc,
  gitWorktreesRpc,
  type RemoteAction,
  type Repository,
  type Worktree,
  type WorktreeSummary,
} from "../shared/git-contracts";
import {
  buildChangeRows,
  type ChangeCategory,
  changeColor,
  changeTargetFromKey,
  type ChangeTarget,
  fileCategory,
  type ChangeRow,
  matchesFilter,
  type StageFamily,
  stageFamilies,
} from "./change-list";
import { Checkbox } from "./checkbox";
import { type CheckoutChoice, CheckoutModal } from "./checkout-modal";
import { type Confirmation, ConfirmModal, trashName } from "./confirm-modal";
import { ContextMenu, type ContextMenuGroups } from "./context-menu";
import { CommitSection } from "./commit-section";
import { openCommitTab } from "./commit-tabs";
import { publishGitStatus } from "./change-registry";
import { openDiffTab } from "./diff-tabs";
import { useExclusivePane } from "./exclusive-pane";
import { revealInTree, useStockViews } from "./stock-views";
import { REPOSITORY_COLOR, STAGED_COLOR, TRACKED_COLOR, UNTRACKED_COLOR } from "./git-colors";
import { DEFAULT_GIT_TAB_STATE, type FileFilter, GitTabStateSchema, type GitTabState } from "./git-focus";
import { GIT_QUERY_KEY, GIT_REFRESH_MS, useGitChangeRefresh } from "./git-live";
import { formatRelativeTime } from "./git-model";
import { useStaging } from "./git-staging";
import { findPaneBridge } from "./host-bridge";
import { findLayoutStore } from "./layout-guard";
import { LineTotals } from "./line-totals";
import { placeRemoteMenu, RemoteButton, RemoteMenu, type RemoteMenuPlacement } from "./remote-actions";
import { TREE_PANEL_ID } from "./panel-ids";
import { SplitSections } from "./split-sections";
import { baseName, joinPath, normalizeAbsolute } from "./tree-model";
import { useMainTreeRoot } from "./tree-views";
import { attachGitRowContextMenu, gitRowDataProps } from "./web";

const CLOCK_TICK_MS = 30_000;
const FONT_SIZE = 13;
const SMALL_FONT_SIZE = 11;
const ICON_SIZE = 14;
// Changes list items run two points under the panel's text, with smaller checkboxes
const CHANGE_FONT_SIZE = FONT_SIZE - 2;
const CHANGE_DETAIL_FONT_SIZE = SMALL_FONT_SIZE - 2;
const CHANGE_CHECKBOX_SIZE = 11;
const CHEVRON_SIZE = 10;
const INDENT_WIDTH = 12;
const ROW_INSET = 10;

// Worktrees, changes, commit, history
const DEFAULT_SECTION_FRACTIONS = [0.2, 0.3, 0.25, 0.25];
const DRAFT_SAVE_DELAY_MS = 500;
const FILTER_OPTIONS: readonly { key: keyof FileFilter; label: string; color: string }[] = [
  { key: "tracked", label: "Tracked", color: TRACKED_COLOR },
  { key: "untracked", label: "Untracked", color: UNTRACKED_COLOR },
];
const CATEGORY_LABELS: Record<ChangeCategory, string> = { tracked: "Tracked", untracked: "Untracked" };
const CATEGORY_COLORS: Record<ChangeCategory, string> = { tracked: TRACKED_COLOR, untracked: UNTRACKED_COLOR };
const NO_FILES: readonly GitFile[] = [];

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function directoryOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function GitPanel({ workspaceId, theme, tab }: PluginWorkspacePanelProps) {
  const workspace = useWorkspace(workspaceId, ({ directory }) => ({ directory }));
  const [tabState, setTabState] = useTabState(tab, GitTabStateSchema, DEFAULT_GIT_TAB_STATE);
  const rootRef = useRef<View>(null);
  // The panel follows the main file tree's root folder: the repository holding it shows, and
  // outside Git the repositories inside it are listed. Undefined until the layout has been read
  const mainTreeRoot = useMainTreeRoot(rootRef);
  const treeRoot = mainTreeRoot === undefined ? undefined : (mainTreeRoot ?? workspace?.directory ?? null);
  /** A repository picked in the list or focused from the file tree, shown instead of the root folder's */
  const focusedRepository =
    tabState.repository && !(treeRoot && normalizeAbsolute(tabState.repository) === normalizeAbsolute(treeRoot))
      ? tabState.repository
      : null;
  useExclusivePane(rootRef, { panelId: TREE_PANEL_ID, position: "bottom" });
  // Paseo's own file tree and Changes opens go to this plugin's tree and Git panel, even while
  // only this panel is mounted
  useStockViews(rootRef);
  const settings = useSettings(preferences);
  useGlobalLayout(rootRef, settings);
  // Section heights are global; the local value bridges the debounced save
  const [sectionOverride, setSectionOverride] = useState<number[] | null>(null);
  const savedSections = settings.status === "ready" ? settings.values.gitSections : null;
  // A saved layout from before the commit section has the wrong length and is ignored
  const sectionFractions =
    sectionOverride ??
    (savedSections?.length === DEFAULT_SECTION_FRACTIONS.length ? savedSections : null) ??
    DEFAULT_SECTION_FRACTIONS;
  // Changes list display is global; the local value bridges the debounced save
  const [listOverride, setListOverride] = useState<{ changesGrouped?: boolean; changesFolders?: boolean }>({});
  const changesGrouped =
    listOverride.changesGrouped ?? (settings.status === "ready" ? settings.values.changesGrouped : false);
  const changesFolders =
    listOverride.changesFolders ?? (settings.status === "ready" ? settings.values.changesFolders : false);
  const updateListDisplay = useCallback((patch: { changesGrouped?: boolean; changesFolders?: boolean }) => {
    setListOverride((current) => ({ ...current, ...patch }));
    savePreferences(patch);
  }, []);
  const tabStateRef = useRef(tabState);
  tabStateRef.current = tabState;
  const updateTabState = useCallback(
    (patch: Partial<GitTabState>) => setTabState({ ...tabStateRef.current, ...patch }),
    [setTabState],
  );
  const toast = useToast();
  const queryClient = useQueryClient();
  const loadWorktrees = useRpc(gitWorktreesRpc);
  const loadStatus = useRpc(gitStatusRpc);
  const loadLog = useRpc(gitLogRpc);
  const checkout = useRpc(gitCheckoutRpc);
  const commitChanges = useRpc(gitCommitRpc);
  const uncommitHead = useRpc(gitUncommitRpc);
  const runRemote = useRpc(gitRemoteRpc);
  const ignore = useRpc(gitIgnoreRpc);
  const revert = useRpc(gitRevertRpc);
  const openInFileBrowser = useRpc(openInFileBrowserRpc);
  const loadRepositories = useRpc(gitRepositoriesRpc);
  const loadSummary = useRpc(gitWorktreeSummaryRpc);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  /** The folder whose repository shows: a focused repository, else the tree's root folder */
  const shownFolder = focusedRepository ?? treeRoot;
  // Two quick git calls; the sections show as soon as they answer and fill in as their own queries do
  const worktrees = useQuery({
    queryKey: [...GIT_QUERY_KEY, "worktrees", shownFolder],
    queryFn: () => loadWorktrees({ root: shownFolder ?? "" }),
    enabled: typeof shownFolder === "string",
    refetchInterval: GIT_REFRESH_MS,
    refetchIntervalInBackground: true,
  });
  const worktreeList = worktrees.data?.worktrees ?? [];
  // A root folder in no repository lists the repositories inside it, so only then does the search run
  const listsRepositories = focusedRepository === null && worktrees.data !== undefined && worktreeList.length === 0;
  // Under the tree's listing key, so the tree's own file changes refresh the list too
  const rootRepositories = useQuery({
    queryKey: ["better-tree", "directory", treeRoot, { repositories: true }],
    queryFn: () => loadRepositories({ root: treeRoot ?? "" }),
    enabled: listsRepositories && typeof treeRoot === "string",
    refetchInterval: GIT_REFRESH_MS,
  });
  const selected =
    worktreeList.find((worktree) => worktree.path === tabState.worktree && !worktree.missing) ??
    worktreeList.find((worktree) => !worktree.missing) ??
    null;
  const selectedPath = selected?.path ?? null;

  const status = useQuery({
    queryKey: [...GIT_QUERY_KEY, "status", selectedPath],
    queryFn: () => loadStatus({ worktree: selectedPath ?? "" }),
    enabled: selectedPath !== null,
    refetchInterval: GIT_REFRESH_MS,
    refetchIntervalInBackground: true,
  });
  const log = useQuery({
    queryKey: [...GIT_QUERY_KEY, "log", selectedPath],
    queryFn: () => loadLog({ worktree: selectedPath ?? "" }),
    enabled: selectedPath !== null,
    refetchInterval: GIT_REFRESH_MS,
    refetchIntervalInBackground: true,
  });
  useEffect(() => {
    if (selectedPath && status.data) publishGitStatus(selectedPath, status.data.files);
  }, [selectedPath, status.data]);

  // A worktree row's totals cost a status of their own, so they load after the changes list
  const summaryPaths = worktreeList.filter((worktree) => !worktree.missing).map((worktree) => worktree.path);
  const summaryResults = useQueries({
    queries: summaryPaths.map((worktree) => ({
      queryKey: [...GIT_QUERY_KEY, "summary", worktree],
      queryFn: () => loadSummary({ worktree }),
      enabled: status.data !== undefined || status.isError,
      refetchInterval: GIT_REFRESH_MS,
      refetchIntervalInBackground: true,
    })),
  });
  const summaries = new Map<string, WorktreeSummary>();
  summaryResults.forEach((result, index) => {
    if (result.data) summaries.set(summaryPaths[index], result.data);
  });
  // The selected worktree's totals come from its changes list, which answers first and matches it
  if (selectedPath && status.data) {
    let additions = 0;
    let deletions = 0;
    for (const file of status.data.files) {
      additions += file.additions;
      deletions += file.deletions;
    }
    summaries.set(selectedPath, { additions, deletions, modifiedAt: summaries.get(selectedPath)?.modifiedAt ?? null });
  }

  const showError = useCallback((error: unknown) => toast.error(errorMessage(error)), [toast]);
  // A toggled checkbox shows its new state at once, and no status read from before it brings the old one back
  const { files, setStaged: onSetStaged } = useStaging(selectedPath, status.data?.files ?? NO_FILES, showError);
  const dirty = files.some((file) => file.staged || file.modified);

  const refreshGit = useCallback(
    () => queryClient.invalidateQueries({ queryKey: GIT_QUERY_KEY }),
    [queryClient],
  );

  useGitChangeRefresh(selectedPath);

  const openDiff = useCallback(
    (file: GitFile) => {
      if (!selectedPath) return;
      const bridge = findPaneBridge(rootRef.current);
      const store = findLayoutStore(rootRef.current);
      if (!bridge || !store || bridge.target.kind !== "plugin") {
        toast.error("Opening diffs needs the Paseo desktop or web app");
        return;
      }
      openDiffTab(
        store,
        `${bridge.serverId}:${bridge.workspaceId}`,
        bridge.target.pluginId,
        { worktree: selectedPath, path: file.path },
        fileCategory(file),
      );
    },
    [selectedPath, toast],
  );

  const openCommit = useCallback(
    (commit: Commit) => {
      if (!selectedPath) return;
      const bridge = findPaneBridge(rootRef.current);
      const store = findLayoutStore(rootRef.current);
      if (!bridge || !store || bridge.target.kind !== "plugin") {
        toast.error("Opening commits needs the Paseo desktop or web app");
        return;
      }
      openCommitTab(store, `${bridge.serverId}:${bridge.workspaceId}`, bridge.target.pluginId, {
        worktree: selectedPath,
        sha: commit.sha,
        shortSha: commit.shortSha,
        subject: commit.subject,
      });
    },
    [selectedPath, toast],
  );

  const [checkoutCommit, setCheckoutCommit] = useState<Commit | null>(null);
  const confirmCheckout = useCallback(
    async (choice: CheckoutChoice) => {
      if (!selectedPath || !checkoutCommit) return;
      const result = await checkout({
        worktree: selectedPath,
        sha: checkoutCommit.sha,
        action: choice.action,
        branch: choice.branch,
      });
      toast.show(result.message, { variant: "success" });
      if (result.worktreePath) updateTabState({ worktree: result.worktreePath });
      await refreshGit();
    },
    [selectedPath, checkoutCommit, checkout, toast, updateTabState, refreshGit],
  );

  // Commit editor: the draft lives locally and reaches tab state after typing pauses
  const [commitMessage, setCommitMessage] = useState(() => tabState.commitMessage ?? "");
  const [commitExpanded, setCommitExpanded] = useState(false);
  const [gitBusy, setGitBusy] = useState<"commit" | "uncommit" | RemoteAction | null>(null);
  useEffect(() => {
    if (commitMessage === (tabStateRef.current.commitMessage ?? "")) return;
    const timer = setTimeout(() => updateTabState({ commitMessage }), DRAFT_SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [commitMessage, updateTabState]);

  const runGitAction = useCallback(
    async (kind: "commit" | "uncommit" | RemoteAction, action: () => Promise<string | null>) => {
      setGitBusy(kind);
      try {
        const message = await action();
        if (message) toast.show(message, { variant: "success" });
      } catch (error) {
        toast.error(errorMessage(error));
      } finally {
        // Busy until the refreshed lists are on screen, so the buttons never come back over the old state
        await refreshGit();
        setGitBusy(null);
      }
    },
    [toast, refreshGit],
  );

  const handleCommit = useCallback(
    (mode: CommitMode) => {
      if (!selectedPath) return;
      void runGitAction("commit", async () => {
        const result = await commitChanges({ worktree: selectedPath, message: commitMessage, mode });
        setCommitMessage("");
        updateTabState({ commitMessage: "", commitMode: null });
        return `Committed ${result.sha.slice(0, 8)} ${result.subject}`;
      });
    },
    [selectedPath, commitMessage, commitChanges, runGitAction, updateTabState],
  );

  const handleUncommit = useCallback(() => {
    if (!selectedPath) return;
    void runGitAction("uncommit", async () => {
      const result = await uncommitHead({ worktree: selectedPath });
      // Like Zed: the undone commit's message comes back for editing
      if (!commitMessage.trim()) setCommitMessage(result.message);
      return "Uncommitted; changes are still staged";
    });
  }, [selectedPath, commitMessage, uncommitHead, runGitAction]);

  // Both remote buttons run the action last chosen in either of their menus
  const [remoteAction, setRemoteAction] = useState<RemoteAction>("fetch");
  const [remoteMenu, setRemoteMenu] = useState<RemoteMenuPlacement | null>(null);
  const handleRemote = useCallback(
    (action: RemoteAction) => {
      if (!selectedPath) return;
      setRemoteAction(action);
      void runGitAction(action, async () => (await runRemote({ worktree: selectedPath, action })).message);
    },
    [selectedPath, runRemote, runGitAction],
  );
  const openRemoteMenu = useCallback((anchor: View | null) => {
    if (rootRef.current && anchor) placeRemoteMenu(rootRef.current, anchor, setRemoteMenu);
  }, []);

  // Changes list context menu, placed over the whole panel so a short section does not clip it
  const [changeMenu, setChangeMenu] = useState<{ target: ChangeTarget; x: number; y: number } | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const rootOffsetRef = useRef({ x: 0, y: 0 });
  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setBounds({ width, height });
    rootRef.current?.measureInWindow((x, y) => {
      rootOffsetRef.current = { x, y };
    });
  }, []);
  // Right-click reads the current lists through refs, so the listeners register once
  const menuSourceRef = useRef({ files, filter: tabState.filter, worktrees: worktreeList });
  menuSourceRef.current = { files, filter: tabState.filter, worktrees: worktreeList };
  const openChangeMenu = useCallback((key: string, x: number, y: number) => {
    const target = changeTargetFromKey(key, menuSourceRef.current.files, menuSourceRef.current.filter);
    if (target) setChangeMenu({ target, x, y });
  }, []);
  useEffect(() => attachGitRowContextMenu(rootRef.current, "change", openChangeMenu), [openChangeMenu]);
  const longPressChange = useCallback(
    (key: string, event: GestureResponderEvent) =>
      openChangeMenu(
        key,
        event.nativeEvent.pageX - rootOffsetRef.current.x,
        event.nativeEvent.pageY - rootOffsetRef.current.y,
      ),
    [openChangeMenu],
  );

  // Worktree context menu, over the whole panel like the changes menu
  const [worktreeMenu, setWorktreeMenu] = useState<{ worktree: Worktree; x: number; y: number } | null>(null);
  const openWorktreeMenu = useCallback((path: string, x: number, y: number) => {
    const worktree = menuSourceRef.current.worktrees.find((candidate) => candidate.path === path);
    if (worktree) setWorktreeMenu({ worktree, x, y });
  }, []);
  useEffect(() => attachGitRowContextMenu(rootRef.current, "worktree", openWorktreeMenu), [openWorktreeMenu]);
  const longPressWorktree = useCallback(
    (path: string, event: GestureResponderEvent) =>
      openWorktreeMenu(
        path,
        event.nativeEvent.pageX - rootOffsetRef.current.x,
        event.nativeEvent.pageY - rootOffsetRef.current.y,
      ),
    [openWorktreeMenu],
  );
  const worktreeMenuGroups = useMemo((): ContextMenuGroups => {
    if (!worktreeMenu) return [];
    const { worktree } = worktreeMenu;
    return [
      [
        {
          id: "open-in-file-explorer",
          label: "Open in file explorer",
          icon: "FolderOpen",
          // A worktree git still lists after its folder was deleted has nothing to show
          disabled: worktree.missing,
          onSelect: () => {
            openInFileBrowser({ root: worktree.path, path: "" }).catch((error: unknown) =>
              toast.error(errorMessage(error)),
            );
          },
        },
      ],
    ];
  }, [worktreeMenu, openInFileBrowser, toast]);

  const changeMenuGroups = useMemo((): ContextMenuGroups => {
    if (!changeMenu || !selectedPath) return [];
    const { target } = changeMenu;
    const worktree = selectedPath;
    const isFolder = target.kind === "directory";
    const name = isFolder ? target.path : basename(target.path);
    const newCount = target.files.filter((file) => fileCategory(file) === "untracked").length;
    const trackedCount = target.files.length - newCount;
    const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
    const confirmIgnore = (): Confirmation => {
      const pattern = gitignorePattern(target.path, isFolder);
      const details = [`The line is added to ${joinPath(worktree, ".gitignore")}.`];
      if (trackedCount > 0) {
        details.push(
          `${plural(trackedCount, "tracked file")} ${trackedCount === 1 ? "stays" : "stay"} tracked: .gitignore only hides untracked files.`,
        );
      }
      return {
        title: "Add to .gitignore",
        icon: "EyeOff",
        message: `Add ${pattern} to .gitignore?`,
        details,
        confirmLabel: "Add to .gitignore",
        busyLabel: "Adding…",
        run: async () => {
          const result = await ignore({ worktree, path: target.path, kind: target.kind });
          toast.show(result.added ? `Added ${result.pattern} to .gitignore` : `${result.pattern} is already in .gitignore`, {
            variant: "success",
          });
          await refreshGit();
        },
      };
    };
    const confirmRevert = (): Confirmation => {
      const details: string[] = [];
      if (trackedCount > 0) {
        details.push(
          `${isFolder ? plural(trackedCount, "tracked file") : "The file"} ${isFolder && trackedCount > 1 ? "return" : "returns"} to the last commit; staged and unstaged edits are lost and cannot be restored.`,
        );
      }
      if (newCount > 0) {
        details.push(
          `${isFolder ? plural(newCount, "new file") : "The new file"} ${isFolder && newCount > 1 ? "go" : "goes"} to the ${trashName(worktree)}.`,
        );
      }
      return {
        title: isFolder ? "Revert changes" : "Revert change",
        icon: "Undo2",
        message: isFolder
          ? `Revert ${plural(target.files.length, "changed file")} in "${name}"?`
          : `Revert the changes to "${name}"?`,
        details,
        confirmLabel: "Revert",
        busyLabel: "Reverting…",
        danger: true,
        run: async () => {
          await revert({ worktree, paths: target.files.map((file) => file.path) });
          await Promise.all([refreshGit(), queryClient.invalidateQueries({ queryKey: ["better-tree", "directory"] })]);
        },
      };
    };
    return [
      [
        {
          id: "go-to",
          label: isFolder ? "Go to folder" : "Go to file",
          icon: "LocateFixed",
          onSelect: () => {
            const bridge = findPaneBridge(rootRef.current);
            const store = findLayoutStore(rootRef.current);
            if (!bridge || !store) {
              toast.error("The file tree needs the Paseo desktop or web app");
              return;
            }
            revealInTree(store, bridge, joinPath(worktree, target.path), target.kind);
          },
        },
        {
          id: "show",
          label: "Show in file explorer",
          icon: "FolderOpen",
          onSelect: () => {
            openInFileBrowser({ root: worktree, path: isFolder ? target.path : directoryOf(target.path) }).catch(
              (error: unknown) => toast.error(errorMessage(error)),
            );
          },
        },
      ],
      [
        { id: "ignore", label: "Add to .gitignore...", icon: "EyeOff", onSelect: () => setConfirmation(confirmIgnore()) },
        {
          id: "revert",
          label: isFolder ? "Revert changes..." : "Revert change...",
          icon: "Undo2",
          onSelect: () => setConfirmation(confirmRevert()),
        },
      ],
    ];
  }, [changeMenu, selectedPath, ignore, revert, openInFileBrowser, toast, refreshGit, queryClient]);

  const styles = useMemo(() => createStyles(theme), [theme]);

  const commitSection = (
    <CommitSection
      key="commit"
      branch={selected?.branch ?? null}
      files={files}
      lastCommit={log.data?.commits[0] ?? null}
      message={commitMessage}
      mode={tabState.commitMode ?? null}
      busy={gitBusy}
      remoteAction={remoteAction}
      expanded={commitExpanded}
      theme={theme}
      onMessageChange={setCommitMessage}
      onModeChange={(commitMode) => updateTabState({ commitMode })}
      onCommit={handleCommit}
      onRemote={handleRemote}
      onOpenRemoteMenu={openRemoteMenu}
      onToggleExpanded={() => setCommitExpanded((current) => !current)}
    />
  );

  let content: ReactNode;
  if (shownFolder === undefined) {
    content = <Loading />;
  } else if (shownFolder === null) {
    content = <Text style={styles.message}>This workspace has no directory.</Text>;
  } else if (worktrees.isError) {
    content = <Text style={styles.message}>Not a Git repository. {worktrees.error.message}</Text>;
  } else if (!worktrees.data) {
    content = <Loading />;
  } else if (worktreeList.length === 0) {
    // In no repository: a focused one is gone, and a root folder lists the repositories inside it,
    // the list filling in once the search answers
    content = focusedRepository ? (
      <Text style={styles.message}>Not a Git repository.</Text>
    ) : (
      <RepositorySection
        repositories={rootRepositories.data?.repositories ?? null}
        incomplete={rootRepositories.data?.incomplete ?? false}
        error={rootRepositories.isError ? rootRepositories.error.message : null}
        styles={styles}
        onSelect={(picked) => updateTabState({ repository: picked.path, worktree: null })}
      />
    );
  } else if (commitExpanded) {
    content = commitSection;
  } else {
    content = (
      <SplitSections
        theme={theme}
        fractions={sectionFractions}
        onFractionsChange={(fractions) => {
          setSectionOverride(fractions);
          savePreferences({ gitSections: fractions });
        }}
        sections={[
          <WorktreeSection
            key="worktrees"
            worktrees={worktreeList}
            selectedPath={selectedPath}
            summaries={summaries}
            now={now}
            theme={theme}
            styles={styles}
            onSelect={(worktree) => updateTabState({ worktree: worktree.path })}
            onRowMenu={longPressWorktree}
            menuPath={worktreeMenu?.worktree.path ?? null}
          />,
          <FilesSection
            key="files"
            files={files}
            loading={status.isPending}
            error={status.isError ? status.error.message : null}
            filter={tabState.filter}
            grouped={changesGrouped}
            folders={changesFolders}
            theme={theme}
            styles={styles}
            onFilterChange={(filter) => updateTabState({ filter })}
            onGroupedChange={(grouped) => updateListDisplay({ changesGrouped: grouped })}
            onFoldersChange={(folders) => updateListDisplay({ changesFolders: folders })}
            onSetStaged={onSetStaged}
            onOpen={openDiff}
            onRowMenu={longPressChange}
          />,
          commitSection,
          <HistorySection
            key="history"
            commits={log.data?.commits ?? []}
            loading={log.isPending}
            error={log.isError ? log.error.message : null}
            now={now}
            theme={theme}
            styles={styles}
            uncommitBusy={gitBusy !== null}
            remoteAction={remoteAction}
            remoteBusy={gitBusy === remoteAction}
            onCheckout={setCheckoutCommit}
            onOpen={openCommit}
            onUncommit={handleUncommit}
            onRemote={handleRemote}
            onOpenRemoteMenu={openRemoteMenu}
          />,
        ]}
      />
    );
  }

  return (
    <View ref={rootRef} style={styles.screen} onLayout={handleLayout}>
      {focusedRepository ? (
        <FocusedRepositoryBar
          repository={focusedRepository}
          theme={theme}
          styles={styles}
          onClear={() => updateTabState({ repository: null, worktree: null })}
        />
      ) : null}
      {content}
      {changeMenu ? (
        <ContextMenu
          groups={changeMenuGroups}
          x={changeMenu.x}
          y={changeMenu.y}
          bounds={bounds}
          theme={theme}
          onClose={() => setChangeMenu(null)}
        />
      ) : null}
      {worktreeMenu ? (
        <ContextMenu
          groups={worktreeMenuGroups}
          x={worktreeMenu.x}
          y={worktreeMenu.y}
          bounds={bounds}
          theme={theme}
          onClose={() => setWorktreeMenu(null)}
        />
      ) : null}
      {remoteMenu ? (
        <RemoteMenu
          placement={remoteMenu}
          theme={theme}
          onSelect={handleRemote}
          onClose={() => setRemoteMenu(null)}
        />
      ) : null}
      <CheckoutModal
        commit={checkoutCommit}
        worktree={selected}
        dirty={dirty}
        theme={theme}
        onClose={() => setCheckoutCommit(null)}
        onConfirm={confirmCheckout}
      />
      <ConfirmModal confirmation={confirmation} theme={theme} onClose={() => setConfirmation(null)} />
    </View>
  );
}

type Styles = ReturnType<typeof createStyles>;

function SectionHeader({
  title,
  styles,
  children,
}: {
  title: string;
  styles: Styles;
  children?: ReactNode;
}) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

/** Names the focused repository; its button goes back to the root folder's repository, or the list outside Git */
function FocusedRepositoryBar({
  repository,
  theme,
  styles,
  onClear,
}: {
  repository: string;
  theme: PluginTheme;
  styles: Styles;
  onClear(): void;
}) {
  const name = baseName(repository);
  return (
    <View style={styles.focusBar}>
      <Icon name="FolderGit2" size={ICON_SIZE} color={REPOSITORY_COLOR} />
      <Text numberOfLines={1} style={styles.focusName}>
        {name}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Stop focusing ${name}`}
        hitSlop={6}
        onPress={onClear}
        style={({ pressed }) => [styles.checkoutButton, pressed ? styles.rowPressed : null]}
      >
        <Icon name="X" size={ICON_SIZE} color={theme.colors.foregroundMuted} />
      </Pressable>
    </View>
  );
}

function WorktreeSection({
  worktrees,
  selectedPath,
  summaries,
  now,
  theme,
  styles,
  onSelect,
  onRowMenu,
  menuPath,
}: {
  worktrees: readonly Worktree[];
  selectedPath: string | null;
  /** Each row's totals and last change, by worktree path, once loaded */
  summaries: ReadonlyMap<string, WorktreeSummary>;
  now: number;
  theme: PluginTheme;
  styles: Styles;
  onSelect(worktree: Worktree): void;
  /** Long press on a row opens its menu; right-click is handled by the panel */
  onRowMenu(path: string, event: GestureResponderEvent): void;
  /** The worktree whose context menu is open */
  menuPath: string | null;
}) {
  // The row under the pointer, and the one whose menu is open, get the selected row's highlight,
  // as rows do in Paseo's own file tree; a lighter shade is hard to tell from the background
  const [hoveredPath, setHoveredPath] = useState<string | null>(null);
  return (
    <View style={styles.section}>
      <SectionHeader title="Branches and worktrees" styles={styles} />
      <FlatList
        data={worktrees}
        keyExtractor={(worktree) => worktree.path}
        renderItem={({ item }) => {
          const isSelected = item.path === selectedPath;
          const highlighted = isSelected || item.path === hoveredPath || item.path === menuPath;
          let status = "";
          if (item.current) status = "Active · ";
          else if (item.missing) status = "Missing on disk (git worktree prune removes it) · ";
          return (
            <Pressable
              {...gitRowDataProps("worktree", item.path)}
              accessibilityRole="button"
              accessibilityState={{ selected: isSelected, disabled: item.missing }}
              disabled={item.missing}
              onPress={() => onSelect(item)}
              onLongPress={(event) => onRowMenu(item.path, event)}
              onHoverIn={() => setHoveredPath(item.path)}
              onHoverOut={() => setHoveredPath((current) => (current === item.path ? null : current))}
              style={({ pressed }) => [
                styles.row,
                highlighted ? styles.rowHighlighted : null,
                pressed ? styles.rowPressed : null,
                item.missing ? styles.rowMissing : null,
              ]}
            >
              <Icon
                name={item.missing ? "FolderX" : item.current ? "GitBranch" : "FolderGit2"}
                size={ICON_SIZE}
                color={item.current ? theme.colors.accent : theme.colors.foregroundMuted}
              />
              <View style={styles.rowText}>
                <Text numberOfLines={1} style={styles.rowTitle}>
                  {item.branch ?? `detached ${item.head.slice(0, 8)}`}
                </Text>
                <Text numberOfLines={1} style={styles.rowDetail}>
                  {status}
                  {item.path}
                </Text>
              </View>
              <View style={styles.rowTrailing}>
                <LineTotals
                  additions={summaries.get(item.path)?.additions ?? 0}
                  deletions={summaries.get(item.path)?.deletions ?? 0}
                  theme={theme}
                />
                <Text style={styles.rowDetail}>{formatRelativeTime(summaries.get(item.path)?.modifiedAt ?? null, now)}</Text>
              </View>
            </Pressable>
          );
        }}
      />
    </View>
  );
}

/** The repositories inside a root folder outside Git; pressing one shows it */
function RepositorySection({
  repositories,
  incomplete,
  error,
  styles,
  onSelect,
}: {
  /** Null while the search runs */
  repositories: readonly Repository[] | null;
  /** The search stopped early, so repositories may be missing */
  incomplete: boolean;
  error: string | null;
  styles: Styles;
  onSelect(repository: Repository): void;
}) {
  // The row under the pointer gets the selected row's highlight, as worktree rows do
  const [hoveredPath, setHoveredPath] = useState<string | null>(null);
  const note = incomplete ? (
    <Text style={styles.message}>
      The search stopped early in this very large folder, so some repositories may be missing.
    </Text>
  ) : null;
  let body: ReactNode;
  if (error) body = <Text style={styles.message}>{error}</Text>;
  else if (!repositories) body = <Text style={styles.message}>Searching for repositories…</Text>;
  else if (repositories.length === 0) {
    body = (
      <View>
        <Text style={styles.message}>No Git repositories in this folder.</Text>
        {note}
      </View>
    );
  } else {
    body = (
      <FlatList
        data={repositories}
        keyExtractor={(repository) => repository.path}
        ListFooterComponent={note}
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Show the repository ${item.relativePath}`}
            onPress={() => onSelect(item)}
            onHoverIn={() => setHoveredPath(item.path)}
            onHoverOut={() => setHoveredPath((current) => (current === item.path ? null : current))}
            style={({ pressed }) => [
              styles.row,
              item.path === hoveredPath ? styles.rowHighlighted : null,
              pressed ? styles.rowPressed : null,
            ]}
          >
            <Icon name="FolderGit2" size={ICON_SIZE} color={REPOSITORY_COLOR} />
            <View style={styles.rowText}>
              <Text numberOfLines={1} style={[styles.rowTitle, styles.repositoryName]}>
                {item.relativePath}
              </Text>
              <Text numberOfLines={1} style={styles.rowDetail}>
                {item.branch ?? "detached HEAD"}
              </Text>
            </View>
          </Pressable>
        )}
      />
    );
  }
  return (
    <View style={styles.section}>
      <SectionHeader title={repositories ? `Repositories (${repositories.length})` : "Repositories"} styles={styles} />
      {body}
    </View>
  );
}

/** A group or folder chevron hung into the margin left of the row's content */
function HangingChevron({ collapsed, left, theme }: { collapsed: boolean; left: number; theme: PluginTheme }) {
  return (
    <View style={{ position: "absolute", top: 0, bottom: 0, left, justifyContent: "center" }}>
      <Icon name={collapsed ? "ChevronRight" : "ChevronDown"} size={CHEVRON_SIZE} color={theme.colors.foregroundMuted} />
    </View>
  );
}

function ToolbarToggle({
  label,
  checked,
  theme,
  styles,
  onChange,
}: {
  label: string;
  checked: boolean;
  theme: PluginTheme;
  styles: Styles;
  onChange(checked: boolean): void;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      onPress={() => onChange(!checked)}
      style={styles.headerButton}
    >
      <Checkbox checked={checked} theme={theme} accessibilityLabel={label} onChange={onChange} />
      <Text style={styles.rowDetail}>{label}</Text>
    </Pressable>
  );
}

/** Checked stages every path in the family; unchecking unstages what is staged */
function toggleFamily(family: StageFamily, onSetStaged: (paths: readonly string[], staged: boolean) => void): void {
  if (family.state === "checked") onSetStaged(family.stagedPaths, false);
  else onSetStaged(family.paths, true);
}

function StageAllCheckbox({
  label,
  family,
  theme,
  onSetStaged,
}: {
  label: string;
  family: StageFamily;
  theme: PluginTheme;
  onSetStaged(paths: readonly string[], staged: boolean): void;
}) {
  const checked = family.state === "checked";
  return (
    <Checkbox
      checked={checked}
      mixed={family.state === "mixed"}
      color={STAGED_COLOR}
      size={CHANGE_CHECKBOX_SIZE}
      theme={theme}
      accessibilityLabel={`${checked ? "Unstage" : "Stage"} ${label.toLowerCase()}`}
      onChange={() => toggleFamily(family, onSetStaged)}
    />
  );
}

function StageAllRow({
  label,
  family,
  color,
  theme,
  styles,
  onSetStaged,
}: {
  label: string;
  family: StageFamily;
  color: string;
  theme: PluginTheme;
  styles: Styles;
  onSetStaged(paths: readonly string[], staged: boolean): void;
}) {
  if (family.paths.length === 0) return null;
  const checked = family.state === "checked";
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: family.state === "mixed" ? "mixed" : checked }}
      onPress={() => toggleFamily(family, onSetStaged)}
      style={styles.compactRow}
    >
      <StageAllCheckbox label={label} family={family} theme={theme} onSetStaged={onSetStaged} />
      <Text style={[styles.changeName, { color }]}>
        {label} ({family.paths.length})
      </Text>
    </Pressable>
  );
}

function FilesSection({
  files,
  loading,
  error,
  filter,
  grouped,
  folders,
  theme,
  styles,
  onFilterChange,
  onGroupedChange,
  onFoldersChange,
  onSetStaged,
  onOpen,
  onRowMenu,
}: {
  files: readonly GitFile[];
  loading: boolean;
  error: string | null;
  filter: FileFilter;
  grouped: boolean;
  folders: boolean;
  theme: PluginTheme;
  styles: Styles;
  onFilterChange(filter: FileFilter): void;
  onGroupedChange(grouped: boolean): void;
  onFoldersChange(folders: boolean): void;
  onSetStaged(paths: readonly string[], staged: boolean): void;
  onOpen(file: GitFile): void;
  /** Long press on a file or folder row opens its menu; right-click is handled by the panel */
  onRowMenu(key: string, event: GestureResponderEvent): void;
}) {
  const [filterOpen, setFilterOpen] = useState(false);
  // Collapsed groups and folders; not persisted
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const toggleCollapsed = useCallback((key: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const rows = useMemo(
    () => buildChangeRows(files, { filter, grouped, folders, collapsed }),
    [files, filter, grouped, folders, collapsed],
  );
  const visibleCount = useMemo(() => files.filter((file) => matchesFilter(file, filter)).length, [files, filter]);
  const families = useMemo(() => stageFamilies(files), [files]);
  const stagedPaths = useMemo(() => files.filter((file) => file.staged).map((file) => file.path), [files]);
  const renderRow = useCallback(
    ({ item }: { item: ChangeRow }) => {
      switch (item.kind) {
        case "group":
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: !item.collapsed }}
              onPress={() => toggleCollapsed(item.key)}
              style={({ pressed }) => [styles.compactRow, styles.groupRow, pressed ? styles.rowPressed : null]}
            >
              <HangingChevron collapsed={item.collapsed} left={ROW_INSET - CHEVRON_SIZE} theme={theme} />
              <Text style={[styles.groupTitle, { color: CATEGORY_COLORS[item.category] }]}>
                {CATEGORY_LABELS[item.category]}
              </Text>
              <Text style={styles.rowDetail}>{item.count}</Text>
              {families[item.category].paths.length === 0 ? null : (
                <StageAllCheckbox
                  label={`All ${item.category}`}
                  family={families[item.category]}
                  theme={theme}
                  onSetStaged={onSetStaged}
                />
              )}
            </Pressable>
          );
        case "folder":
          return (
            <Pressable
              {...gitRowDataProps("change", item.key)}
              accessibilityRole="button"
              accessibilityState={{ expanded: !item.collapsed }}
              onPress={() => toggleCollapsed(item.key)}
              onLongPress={(event) => onRowMenu(item.key, event)}
              style={({ pressed }) => [
                styles.compactRow,
                { paddingLeft: ROW_INSET + item.depth * INDENT_WIDTH },
                pressed ? styles.rowPressed : null,
              ]}
            >
              <HangingChevron
                collapsed={item.collapsed}
                left={ROW_INSET + item.depth * INDENT_WIDTH - CHEVRON_SIZE}
                theme={theme}
              />
              <Icon name={item.collapsed ? "Folder" : "FolderOpen"} size={12} color={theme.colors.foregroundMuted} />
              <Text numberOfLines={1} style={[styles.rowDetail, styles.fileDirectory]}>
                {item.name}
              </Text>
            </Pressable>
          );
        case "file":
          return (
            <FileRow
              rowKey={item.key}
              file={item.file}
              depth={item.depth}
              showDirectory={!folders}
              theme={theme}
              styles={styles}
              onSetStaged={onSetStaged}
              onOpen={onOpen}
              onRowMenu={onRowMenu}
            />
          );
      }
    },
    [folders, families, theme, styles, toggleCollapsed, onSetStaged, onOpen, onRowMenu],
  );
  let body: ReactNode;
  if (error) body = <Text style={styles.message}>{error}</Text>;
  else if (loading) body = <Loading />;
  else if (visibleCount === 0) body = <Text style={styles.message}>No matching changes.</Text>;
  else {
    body = <FlatList data={rows} keyExtractor={(row) => row.key} renderItem={renderRow} extraData={renderRow} />;
  }
  return (
    <View style={styles.section}>
      <SectionHeader title={`Changes (${visibleCount}/${files.length})`} styles={styles}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Filter changes"
          accessibilityState={{ expanded: filterOpen }}
          hitSlop={6}
          onPress={() => setFilterOpen((open) => !open)}
          style={styles.headerButton}
        >
          <Icon name="ListFilter" size={ICON_SIZE} color={theme.colors.foregroundMuted} />
          <Text style={styles.rowDetail}>Filter</Text>
          <Icon name={filterOpen ? "ChevronUp" : "ChevronDown"} size={12} color={theme.colors.foregroundMuted} />
        </Pressable>
      </SectionHeader>
      <View style={styles.toolbar}>
        <ToolbarToggle label="Group" checked={grouped} theme={theme} styles={styles} onChange={onGroupedChange} />
        <ToolbarToggle label="Folders" checked={folders} theme={theme} styles={styles} onChange={onFoldersChange} />
        <View style={styles.toolbarSpacer} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Unstage all changes"
          accessibilityState={{ disabled: stagedPaths.length === 0 }}
          disabled={stagedPaths.length === 0}
          hitSlop={6}
          onPress={() => onSetStaged(stagedPaths, false)}
          style={[styles.headerButton, { opacity: stagedPaths.length === 0 ? 0.4 : 1 }]}
        >
          <Icon name="ListMinus" size={ICON_SIZE} color={theme.colors.foregroundMuted} />
          <Text style={styles.rowDetail}>Unstage all</Text>
        </Pressable>
      </View>
      {error || loading || grouped ? null : (
        <>
          <StageAllRow
            label="All tracked"
            family={families.tracked}
            color={TRACKED_COLOR}
            theme={theme}
            styles={styles}
            onSetStaged={onSetStaged}
          />
          <StageAllRow
            label="All untracked"
            family={families.untracked}
            color={UNTRACKED_COLOR}
            theme={theme}
            styles={styles}
            onSetStaged={onSetStaged}
          />
        </>
      )}
      {body}
      {filterOpen ? (
        <>
          <Pressable
            style={StyleSheet.absoluteFill}
            accessibilityLabel="Close filter"
            onPress={() => setFilterOpen(false)}
          />
          <View style={styles.dropdown} accessibilityRole="menu">
            {FILTER_OPTIONS.map((option) => (
              <Pressable
                key={option.key}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: filter[option.key] }}
                onPress={() => onFilterChange({ ...filter, [option.key]: !filter[option.key] })}
                style={styles.dropdownRow}
              >
                <Checkbox
                  checked={filter[option.key]}
                  color={option.color}
                  theme={theme}
                  accessibilityLabel={`Show ${option.label.toLowerCase()} files`}
                  onChange={(checked) => onFilterChange({ ...filter, [option.key]: checked })}
                />
                <Text style={{ color: option.color, fontSize: FONT_SIZE }}>{option.label}</Text>
              </Pressable>
            ))}
          </View>
        </>
      ) : null}
    </View>
  );
}

const FileRow = memo(function FileRow({
  rowKey,
  file,
  depth,
  showDirectory,
  theme,
  styles,
  onSetStaged,
  onOpen,
  onRowMenu,
}: {
  rowKey: string;
  file: GitFile;
  depth: number;
  /** Flat lists show each file's folder after its name */
  showDirectory: boolean;
  theme: PluginTheme;
  styles: Styles;
  onSetStaged(paths: readonly string[], staged: boolean): void;
  onOpen(file: GitFile): void;
  onRowMenu(key: string, event: GestureResponderEvent): void;
}) {
  return (
    <View {...gitRowDataProps("change", rowKey)} style={[styles.compactRow, { paddingLeft: ROW_INSET + depth * INDENT_WIDTH }]}>
      <Checkbox
        checked={file.staged}
        color={STAGED_COLOR}
        size={CHANGE_CHECKBOX_SIZE}
        theme={theme}
        accessibilityLabel={`${file.staged ? "Unstage" : "Stage"} ${file.path}`}
        onChange={(staged) => onSetStaged([file.path], staged)}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open diff for ${file.path}`}
        onPress={() => onOpen(file)}
        onLongPress={(event) => onRowMenu(rowKey, event)}
        style={({ pressed }) => [styles.fileButton, pressed ? styles.rowPressed : null]}
      >
        <Text numberOfLines={1} style={[styles.changeName, { color: changeColor(file) }]}>
          {basename(file.path)}
        </Text>
        <Text numberOfLines={1} style={[styles.changeDetail, styles.fileDirectory]}>
          {showDirectory ? directoryOf(file.path) : ""}
        </Text>
        <LineTotals
          additions={file.additions}
          deletions={file.deletions}
          theme={theme}
          fontSize={CHANGE_DETAIL_FONT_SIZE}
        />
      </Pressable>
    </View>
  );
});

function HistorySection({
  commits,
  loading,
  error,
  now,
  theme,
  styles,
  uncommitBusy,
  remoteAction,
  remoteBusy,
  onCheckout,
  onOpen,
  onUncommit,
  onRemote,
  onOpenRemoteMenu,
}: {
  commits: readonly Commit[];
  loading: boolean;
  error: string | null;
  now: number;
  theme: PluginTheme;
  styles: Styles;
  /** A git operation is running, so the undo button is disabled */
  uncommitBusy: boolean;
  remoteAction: RemoteAction;
  /** `remoteAction` is running */
  remoteBusy: boolean;
  onCheckout(commit: Commit): void;
  /** Shows the commit's changes in its own tab */
  onOpen(commit: Commit): void;
  onUncommit(): void;
  onRemote(action: RemoteAction): void;
  onOpenRemoteMenu(anchor: View | null): void;
}) {
  // The row under the pointer gets the selected row's highlight, as worktree rows do
  const [hoveredSha, setHoveredSha] = useState<string | null>(null);
  let body: ReactNode;
  if (error) body = <Text style={styles.message}>{error}</Text>;
  else if (loading) body = <Loading />;
  else if (commits.length === 0) body = <Text style={styles.message}>No commits yet.</Text>;
  else {
    body = (
      <FlatList
        data={commits}
        keyExtractor={(commit) => commit.sha}
        renderItem={({ item, index }) => (
          <View style={[styles.commitRow, item.sha === hoveredSha ? styles.rowHighlighted : null]}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Show commit ${item.shortSha}: ${item.subject}`}
              onPress={() => onOpen(item)}
              onHoverIn={() => setHoveredSha(item.sha)}
              onHoverOut={() => setHoveredSha((current) => (current === item.sha ? null : current))}
              style={({ pressed }) => [styles.commitButton, pressed ? styles.rowPressed : null]}
            >
              <Icon
                name={item.isHead ? "CircleDot" : "GitCommitHorizontal"}
                size={ICON_SIZE}
                color={item.isHead ? theme.colors.accent : theme.colors.foregroundMuted}
              />
              <View style={styles.rowText}>
                <Text numberOfLines={1} style={styles.rowTitle}>
                  {item.subject}
                </Text>
                <Text numberOfLines={1} style={styles.rowDetail}>
                  {item.shortSha} · {item.author} · {formatRelativeTime(item.time, now)}
                  {item.branches.length > 0 ? ` · ${item.branches.join(", ")}` : ""}
                </Text>
              </View>
            </Pressable>
            {/* The newest commit can be undone unless it is the repository's first */}
            {index === 0 && item.isHead && commits.length > 1 ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Uncommit ${item.shortSha}, keeping its changes staged`}
                accessibilityState={{ disabled: uncommitBusy }}
                disabled={uncommitBusy}
                hitSlop={6}
                onPress={onUncommit}
                style={({ pressed }) => [
                  styles.checkoutButton,
                  pressed ? styles.rowPressed : null,
                  { opacity: uncommitBusy ? 0.5 : 1 },
                ]}
              >
                <Icon name="Undo2" size={ICON_SIZE} color={theme.colors.foregroundMuted} />
              </Pressable>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Check out ${item.shortSha}`}
              hitSlop={6}
              onPress={() => onCheckout(item)}
              style={({ pressed }) => [styles.checkoutButton, pressed ? styles.rowPressed : null]}
            >
              <Icon name="GitBranchPlus" size={ICON_SIZE} color={theme.colors.foregroundMuted} />
            </Pressable>
          </View>
        )}
      />
    );
  }
  return (
    <View style={styles.section}>
      <SectionHeader title="History" styles={styles}>
        <RemoteButton
          action={remoteAction}
          busy={remoteBusy}
          theme={theme}
          onRun={onRemote}
          onOpenMenu={onOpenRemoteMenu}
        />
      </SectionHeader>
      {body}
    </View>
  );
}

function createStyles(theme: PluginTheme) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.colors.surface0 },
    section: { flex: 1, minHeight: 0 },
    focusBar: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingLeft: 10,
      paddingRight: 6,
      paddingVertical: 2,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.border,
    },
    focusName: { flex: 1, minWidth: 0, color: REPOSITORY_COLOR, fontSize: FONT_SIZE },
    repositoryName: { color: REPOSITORY_COLOR },
    sectionHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.border,
    },
    sectionTitle: {
      flex: 1,
      color: theme.colors.foregroundMuted,
      fontSize: SMALL_FONT_SIZE,
      fontWeight: "600",
      textTransform: "uppercase",
      letterSpacing: 0.5,
    },
    headerButton: { flexDirection: "row", alignItems: "center", gap: 4 },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 10,
      paddingVertical: 4,
    },
    rowHighlighted: { backgroundColor: theme.colors.surface2 },
    rowPressed: { backgroundColor: theme.colors.surface1 },
    // A history row presses as a whole but for its buttons, which sit beside its pressable part
    commitRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingRight: 10 },
    commitButton: {
      flex: 1,
      minWidth: 0,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingLeft: 10,
      paddingVertical: 4,
    },
    rowMissing: { opacity: 0.5 },
    rowText: { flex: 1, minWidth: 0 },
    rowTitle: { color: theme.colors.foreground, fontSize: FONT_SIZE },
    rowDetail: { color: theme.colors.foregroundMuted, fontSize: SMALL_FONT_SIZE },
    rowTrailing: { alignItems: "flex-end", gap: 2 },
    fileButton: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 6 },
    fileName: { flexShrink: 0, maxWidth: "60%", fontSize: FONT_SIZE },
    changeName: { flexShrink: 0, maxWidth: "60%", fontSize: CHANGE_FONT_SIZE },
    changeDetail: { color: theme.colors.foregroundMuted, fontSize: CHANGE_DETAIL_FONT_SIZE },
    fileDirectory: { flex: 1, minWidth: 0 },
    // Changes list rows stay dense: a hairline of padding around one line of text
    compactRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: ROW_INSET,
      paddingVertical: 1,
    },
    groupRow: { marginTop: 2 },
    groupTitle: { fontSize: SMALL_FONT_SIZE, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.5 },
    toolbar: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingHorizontal: ROW_INSET,
      paddingVertical: 3,
    },
    toolbarSpacer: { flex: 1 },
    checkoutButton: { padding: 4, borderRadius: 4 },
    message: { padding: 12, color: theme.colors.foregroundMuted, fontSize: FONT_SIZE },
    dropdown: {
      position: "absolute",
      top: 30,
      right: 8,
      paddingVertical: 4,
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
      shadowColor: "#000",
      shadowOpacity: 0.2,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 4 },
      elevation: 8,
    },
    dropdownRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 12,
      paddingVertical: 6,
    },
  });
}
