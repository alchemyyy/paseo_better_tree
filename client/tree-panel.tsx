import {
  type PluginWorkspacePanelProps,
  usePaseo,
  useRpc,
  useSettings,
  useTabState,
  useWorkspace,
} from "@getpaseo/plugin/client";
import { copyText, FlatList, Icon, Loading, useToast } from "@getpaseo/plugin/client/ui";
import type { PluginTheme } from "@getpaseo/plugin";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, type ReactElement, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type FlatList as NativeFlatList,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  Pressable,
  Text,
  TextInput,
  type TextStyle,
  View,
} from "react-native";
import {
  copyEntryRpc,
  createEntryRpc,
  DEFAULT_FONT_SIZE,
  DEFAULT_FONT_WEIGHT,
  DEFAULT_ROW_PADDING,
  FONT_SIZE_STEP,
  FONT_WEIGHT_STEP,
  listDirectoryRpc,
  MAX_FONT_SIZE,
  MAX_FONT_WEIGHT,
  MAX_ROW_PADDING,
  MIN_FONT_SIZE,
  MIN_FONT_WEIGHT,
  MIN_ROW_PADDING,
  moveEntryRpc,
  openInFileBrowserRpc,
  openInTextEditorRpc,
  openTerminalRpc,
  openWithDefaultAppRpc,
  preferences,
  renameEntryRpc,
  ROW_PADDING_STEP,
  searchTreeRpc,
  trashEntryRpc,
  type TreeEntry,
} from "../shared/contracts";
import { filterMatchRanges, parseTreeFilter, type TreeFilter } from "../shared/tree-filter";
import { Checkbox } from "./checkbox";
import { ContextMenu, type ContextMenuGroups, type ContextMenuItem } from "./context-menu";
import { subscribeTreeReveals, takeTreeReveal, useStockViews } from "./stock-views";
import { type Confirmation, ConfirmModal, trashName } from "./confirm-modal";
import { setFileClipboard, useFileClipboard } from "./file-clipboard";
import { REPOSITORY_COLOR } from "./git-colors";
import { focusGitRepository, followTreeRoot } from "./git-focus";
import { useGitChangeColors } from "./git-live";
import { findPaneBridge, type PaneBridge } from "./host-bridge";
import { useExclusivePane } from "./exclusive-pane";
import { useGlobalLayout } from "./global-layout";
import { savePreferences } from "./preference-saver";
import { FileIcon } from "./file-icon";
import { FilterBar } from "./filter-bar";
import {
  findLayoutStore,
  findPanelHost,
  hideStockOnlyExplorer,
  type LayoutStoreApi,
  openFileInFileArea,
} from "./layout-guard";
import { openGitPanel } from "./panel-openers";
import { GIT_PANEL_ID } from "./panel-ids";
import { markOncePerSession } from "./session-memory";
import { shortcutLabel, type TreeCommand } from "./shortcuts";
import {
  baseName,
  buildFilterView,
  canMoveAbsolute,
  copyableRelativePath,
  deselectWhere,
  flattenTree,
  formatQuotedPath,
  isSameOrInsideAbsolute,
  joinPath,
  NO_SELECTION,
  normalizeAbsolute,
  parentDirectory,
  parentPath,
  parseQuotedPaths,
  relativeInside,
  resolvePath,
  relativeLinkPath,
  remapPath,
  ROOT_PATH,
  selectForMenu,
  selectPaths,
  selectRange,
  toggleSelected,
  type TreeRow,
  type TreeSelection,
} from "./tree-model";
import { PIN_ACTIVE_ICON } from "./icons";
import {
  closeTreeViews,
  openTreeView,
  type TreeTabState,
  TreeTabStateSchema,
  usePinnedFolders,
} from "./tree-views";
import {
  attachTreeDomEvents,
  type ComposerSnapshot,
  type ComposerTarget,
  findComposerTarget,
  focusView,
  installComposerTracking,
  isMacClient,
  registerTreeDragAndDrop,
  setRowDraggable,
  subscribeComposerText,
  treeActionDataProps,
  treeBodyDataProps,
  treeRowDataProps,
} from "./web";

// shortcut: polls expanded directories instead of watching, upgrade if large trees feel slow
const REFRESH_INTERVAL_MS = 4000;
const INDENT_WIDTH = 12;
const ROW_ICON_SIZE = 14;
const FILE_OPEN_SOURCE = "explorerFiles";
/** Typing pauses this long before the filter searches */
const FILTER_DELAY_MS = 200;
// shortcut: a filter searches again on a timer instead of watching the folder, like the listings
const FILTER_REFRESH_INTERVAL_MS = 10_000;
/** Filter matches in names: a translucent orange, like VS Code's */
const FILTER_MATCH_STYLE = { backgroundColor: "rgba(234, 92, 0, 0.33)" };
const NO_PATHS: ReadonlySet<string> = new Set();
const NONE_CLOSED = { key: "", paths: NO_PATHS };

const DEFAULT_TAB_STATE: TreeTabState = { expanded: [] };

/**
 * The Explorer dock cannot split, so placing the tree beside the chat means moving it into the
 * workspace side pane, where the saved pane arrangement takes over. Explorer, then holding only
 * Paseo's own Files and Changes, is hidden rather than left showing them
 */
function moveTreeOutOfExplorer(bridge: PaneBridge, store: LayoutStoreApi | null): void {
  if (bridge.host !== "explorer" || !bridge.openTargetToSide || bridge.target.kind !== "plugin") return;
  // An existing tab moves to the side pane (packages/app/src/workspace-tabs/open-beside.ts)
  bridge.openTargetToSide(bridge.target);
  if (store) hideStockOnlyExplorer(store, `${bridge.serverId}:${bridge.workspaceId}`);
}

interface MenuState {
  /** null: blank space, which acts on the tree's root folder */
  entry: TreeEntry | null;
  x: number;
  y: number;
}

/** Inline name editing: renaming an entry, or naming a new one in `parent` */
type EditState =
  | { type: "rename"; path: string }
  | { type: "new"; parent: string; kind: TreeEntry["kind"] };

/** Key of the placeholder row holding a new entry's name editor; relative paths never start with "/" */
const NEW_ENTRY_PATH = "/new-entry";
const SHORTCUT_LABELS_MAC = isMacClient();

interface DisplayPreferences {
  rowPadding: number;
  fontWeight: number;
  fontSize: number;
  treeGitChanges: boolean;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

/**
 * The primary tree (`primary`) owns the workspace's auto-placement; pinned folder views are the
 * same tree without it.
 */
export function createTreePanel({ primary }: { primary: boolean }) {
  return function TreePanelInstance(props: PluginWorkspacePanelProps) {
    return <TreePanel {...props} primary={primary} />;
  };
}

function TreePanel({
  workspaceId,
  theme,
  layout,
  tab,
  primary,
}: PluginWorkspacePanelProps & { primary: boolean }) {
  const workspace = useWorkspace(workspaceId, ({ directory, name }) => ({ directory, name }));
  const workspaceDirectory = workspace?.directory ?? null;
  const paseo = usePaseo();
  const toast = useToast();
  const listDirectory = useRpc(listDirectoryRpc);
  const openInTextEditor = useRpc(openInTextEditorRpc);
  const openInFileBrowser = useRpc(openInFileBrowserRpc);
  const openTerminal = useRpc(openTerminalRpc);
  const openWithDefaultApp = useRpc(openWithDefaultAppRpc);
  const moveEntry = useRpc(moveEntryRpc);
  const createEntry = useRpc(createEntryRpc);
  const renameEntry = useRpc(renameEntryRpc);
  const copyEntry = useRpc(copyEntryRpc);
  const trashEntry = useRpc(trashEntryRpc);
  const fileClipboard = useFileClipboard();
  const queryClient = useQueryClient();
  const settings = useSettings(preferences);
  const [tabState, setTabState] = useTabState(tab, TreeTabStateSchema, DEFAULT_TAB_STATE);
  const tabStateRef = useRef(tabState);
  tabStateRef.current = tabState;
  // Every write keeps the view's folder and pin time
  const updateTabState = useCallback(
    (patch: Partial<TreeTabState>) => setTabState({ ...tabStateRef.current, ...patch }),
    [setTabState],
  );
  /** Absolute folder this view lists; defaults to the workspace directory */
  const root = tabState.viewRoot ?? workspaceDirectory;
  const expanded = useMemo(() => new Set(tabState.expanded), [tabState.expanded]);
  const expandedRef = useRef(tabState.expanded);
  expandedRef.current = tabState.expanded;
  /** Folder under an in-progress tree drag; ROOT_PATH highlights the whole list */
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const rootRef = useRef<View>(null);
  const rootOffsetRef = useRef({ x: 0, y: 0 });
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [selection, setSelection] = useState<TreeSelection>(NO_SELECTION);
  const [editing, setEditing] = useState<EditState | null>(null);
  const [deleting, setDeleting] = useState<TreeEntry | null>(null);
  const agentCwdCacheRef = useRef(new Map<string, string>());

  // Row spacing and text weight and size: local values apply instantly, the settings save is debounced
  const [displayOverrides, setDisplayOverrides] = useState<Partial<DisplayPreferences>>({});
  const display: DisplayPreferences = {
    rowPadding:
      displayOverrides.rowPadding ??
      (settings.status === "ready" ? settings.values.rowPadding : DEFAULT_ROW_PADDING),
    fontWeight:
      displayOverrides.fontWeight ??
      (settings.status === "ready" ? settings.values.fontWeight : DEFAULT_FONT_WEIGHT),
    fontSize:
      displayOverrides.fontSize ?? (settings.status === "ready" ? settings.values.fontSize : DEFAULT_FONT_SIZE),
    treeGitChanges:
      displayOverrides.treeGitChanges ?? (settings.status === "ready" ? settings.values.treeGitChanges : false),
  };
  const { rowPadding, fontWeight, fontSize, treeGitChanges } = display;
  const gitColors = useGitChangeColors(workspaceDirectory, treeGitChanges);
  const displayRef = useRef(display);
  displayRef.current = display;
  useGlobalLayout(rootRef, settings);
  const updateDisplay = useCallback((patch: Partial<DisplayPreferences>) => {
    displayRef.current = { ...displayRef.current, ...patch };
    setDisplayOverrides((current) => ({ ...current, ...patch }));
    savePreferences(patch);
  }, []);
  const displayHandlers = useMemo(
    () => ({
      onZoomStep: (direction: 1 | -1) =>
        updateDisplay({
          rowPadding: clamp(
            displayRef.current.rowPadding + direction * ROW_PADDING_STEP,
            MIN_ROW_PADDING,
            MAX_ROW_PADDING,
          ),
        }),
      onWeightStep: (direction: 1 | -1) =>
        updateDisplay({
          fontWeight: clamp(
            displayRef.current.fontWeight + direction * FONT_WEIGHT_STEP,
            MIN_FONT_WEIGHT,
            MAX_FONT_WEIGHT,
          ),
        }),
      onSizeStep: (direction: 1 | -1) =>
        updateDisplay({
          fontSize: clamp(displayRef.current.fontSize + direction * FONT_SIZE_STEP, MIN_FONT_SIZE, MAX_FONT_SIZE),
        }),
      onResetZoom: () => updateDisplay({ rowPadding: DEFAULT_ROW_PADDING }),
      onResetWeight: () => updateDisplay({ fontWeight: DEFAULT_FONT_WEIGHT }),
      onResetSize: () => updateDisplay({ fontSize: DEFAULT_FONT_SIZE }),
    }),
    [updateDisplay],
  );

  // Directory listings for the root and every expanded folder
  const directoryPaths = useMemo(() => [ROOT_PATH, ...tabState.expanded], [tabState.expanded]);
  const combineListings = useCallback(
    (
      results: {
        data?: { entries: TreeEntry[] };
        isPending: boolean;
        isError: boolean;
        error: Error | null;
      }[],
    ) => {
      const directories = new Map<string, readonly TreeEntry[]>();
      results.forEach((result, index) => {
        if (result.data) directories.set(directoryPaths[index], result.data.entries);
        // A folder deleted while expanded shows as empty instead of loading forever
        else if (result.isError) directories.set(directoryPaths[index], []);
      });
      const rootResult = results[0];
      return {
        directories,
        rootPending: rootResult?.isPending ?? true,
        rootError: rootResult?.isError ? rootResult.error : null,
      };
    },
    [directoryPaths],
  );
  const { directories, rootPending, rootError } = useQueries({
    queries: directoryPaths.map((path) => ({
      queryKey: ["better-tree", "directory", root, path],
      queryFn: () => listDirectory({ root: root ?? "", path }),
      enabled: root !== null,
      refetchInterval: REFRESH_INTERVAL_MS,
    })),
    combine: combineListings,
  });
  const treeRows = useMemo(() => flattenTree(directories, expanded), [directories, expanded]);

  // Filter: typing pauses briefly before it searches the whole view; clearing it ends it at once
  const filterInputRef = useRef<TextInput>(null);
  const [filterText, setFilterText] = useState(() => tabState.filter ?? "");
  const [filterQuery, setFilterQuery] = useState(() => (tabState.filter ?? "").trim());
  /** Filter text whose first match Enter asked for before its results arrived */
  const [submittedFilter, setSubmittedFilter] = useState<string | null>(null);
  /** Folders closed among the results of the filter `key` (view folder and filter text) */
  const [closedInFilter, setClosedInFilter] = useState<{ key: string; paths: ReadonlySet<string> }>(NONE_CLOSED);
  useEffect(() => {
    setSubmittedFilter(null);
    const query = filterText.trim();
    if (query === "") {
      setFilterQuery("");
      // Filtering again starts with every match shown
      setClosedInFilter(NONE_CLOSED);
      return;
    }
    const timer = setTimeout(() => setFilterQuery(query), FILTER_DELAY_MS);
    return () => clearTimeout(timer);
  }, [filterText]);
  // Paseo re-creates the panel whenever panes are added or removed, so the filter lives in tab state
  useEffect(() => {
    if ((tabStateRef.current.filter ?? "") === filterQuery) return;
    updateTabState({ filter: filterQuery === "" ? undefined : filterQuery });
  }, [filterQuery, updateTabState]);
  const filter = useMemo(() => parseTreeFilter(filterQuery), [filterQuery]);
  const filtering = filter !== null;
  const searchTree = useRpc(searchTreeRpc);
  const search = useQuery({
    // Under the listings' key, so whatever refreshes the listings refreshes the filter too
    queryKey: ["better-tree", "directory", root, { filter: filterQuery }],
    queryFn: () => searchTree({ root: root ?? "", query: filterQuery }),
    enabled: root !== null && filtering,
    // The previous filter's results stay up while the next one searches
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[2] === root ? previous : undefined),
    refetchInterval: FILTER_REFRESH_INTERVAL_MS,
  });
  const filterView = useMemo(() => (search.data ? buildFilterView(search.data.entries) : null), [search.data]);
  // Another filter shows every match again
  const filterKey = `${root}\n${filterQuery}`;
  const filterClosed = closedInFilter.key === filterKey ? closedInFilter.paths : NO_PATHS;
  const filterRows = useMemo(() => {
    if (!filterView) return [];
    const open = new Set([...filterView.parents].filter((path) => !filterClosed.has(path)));
    return flattenTree(filterView.directories, open);
  }, [filterView, filterClosed]);
  const toggleFilterFolder = useCallback(
    (path: string) =>
      setClosedInFilter((current) => {
        const paths = new Set(current.key === filterKey ? current.paths : NO_PATHS);
        if (!paths.delete(path)) paths.add(path);
        return { key: filterKey, paths };
      }),
    [filterKey],
  );
  const focusFilter = useCallback(() => {
    const input = filterInputRef.current;
    if (!input) return;
    input.focus();
    // On web the ref is the DOM input itself: select its text, so typing replaces it
    if ("select" in input && typeof input.select === "function") input.select();
  }, []);
  const rows = filtering ? filterRows : treeRows;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  // In the order shown; rows hidden in closed folders or by the filter drop out
  const selectedEntries = useMemo(
    () => rows.filter((row) => selection.paths.has(row.entry.path)).map((row) => row.entry),
    [rows, selection],
  );
  const selectedEntriesRef = useRef(selectedEntries);
  selectedEntriesRef.current = selectedEntries;
  // A new entry's name editor sits first in its folder, as in VS Code
  const displayRows = useMemo(() => {
    if (editing?.type !== "new") return rows;
    const placeholder = (depth: number): TreeRow => ({
      entry: { name: "", path: NEW_ENTRY_PATH, kind: editing.kind },
      depth,
      expanded: false,
      loading: false,
    });
    const parentIndex = rows.findIndex((row) => row.entry.path === editing.parent);
    if (parentIndex < 0) return [placeholder(0), ...rows];
    return [
      ...rows.slice(0, parentIndex + 1),
      placeholder(rows[parentIndex]!.depth + 1),
      ...rows.slice(parentIndex + 1),
    ];
  }, [rows, editing]);

  useEffect(() => {
    installComposerTracking();
  }, []);

  // Shortcuts read current state through a ref, so the DOM listeners register once
  const runCommandRef = useRef<(command: TreeCommand) => boolean>(() => false);
  useEffect(
    () =>
      attachTreeDomEvents(rootRef.current, {
        ...displayHandlers,
        onHoverPath: setHoveredPath,
        onContextMenu: (path, x, y) => {
          if (path === null) {
            setMenu({ entry: null, x, y });
            return;
          }
          const entry = rowsRef.current.find((row) => row.entry.path === path)?.entry;
          if (!entry) return;
          setSelection((current) => selectForMenu(current, entry.path));
          setMenu({ entry, x, y });
        },
        onSelectPress: (path, { toggle, range }) =>
          setSelection((current) =>
            range
              ? selectRange(current, path, rowsRef.current.map((row) => row.entry.path), toggle)
              : toggleSelected(current, path),
          ),
        onBlankPress: () => setSelection(NO_SELECTION),
        onCommand: (command) => runCommandRef.current(command),
      }),
    [displayHandlers],
  );

  // The first time this workspace's tree mounts: move it out of Explorer, then open Git below it
  const autoArrange = settings.status === "ready" && settings.values.arrangeBesideChanges;
  const autoOpenGit = settings.status === "ready" && settings.values.autoOpenGit;
  useEffect(() => {
    if (!primary || settings.status !== "ready" || layout.compact) return;
    const bridge = findPaneBridge(rootRef.current);
    const store = findLayoutStore(rootRef.current);
    // Moving only a tree that is still in Explorer lets a placed tree keep its size
    if (autoArrange && bridge?.host === "explorer" && markOncePerSession("arranged", workspaceId)) {
      moveTreeOutOfExplorer(bridge, store);
    }
    if (!autoOpenGit || !markOncePerSession("git-opened", workspaceId)) return;
    const gitPlacement =
      store && bridge ? findPanelHost(store, `${bridge.serverId}:${bridge.workspaceId}`, GIT_PANEL_ID) : null;
    if (gitPlacement === null) openGitPanel(workspaceId);
  }, [primary, settings.status, autoArrange, autoOpenGit, layout.compact, workspaceId]);

  // While the tree sits in a workspace pane, no other tab may open or stay in that pane
  useExclusivePane(rootRef);
  // Paseo's own file tree and Changes opens (chat folder links and the like) come to this
  // plugin's tree and Git panel instead
  useStockViews(rootRef);

  const toggleDirectory = useCallback(
    (path: string) => {
      const next = new Set(expanded);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      updateTabState({ expanded: [...next] });
    },
    [expanded, updateTabState],
  );

  /** Re-roots this view; expanded folders stay open when the new folder contains them */
  const changeViewRoot = useCallback(
    (nextRoot: string) => {
      if (!root) return;
      const previousRoot = root;
      const fromNewRoot = relativeInside(nextRoot, previousRoot);
      const toNewRoot = relativeInside(previousRoot, nextRoot);
      let nextExpanded: string[] = [];
      if (fromNewRoot !== null && fromNewRoot !== "") {
        // Going up: the folder we came from stays open with everything under it
        nextExpanded = [fromNewRoot, ...expandedRef.current.map((path) => `${fromNewRoot}/${path}`)];
      } else if (toNewRoot) {
        // Going down: the folders open inside the new root stay open
        const prefix = `${toNewRoot}/`;
        nextExpanded = expandedRef.current
          .filter((path) => path.startsWith(prefix))
          .map((path) => path.slice(prefix.length));
      }
      const isWorkspaceRoot =
        workspaceDirectory !== null && normalizeAbsolute(nextRoot) === normalizeAbsolute(workspaceDirectory);
      updateTabState({ viewRoot: isWorkspaceRoot ? null : nextRoot, expanded: nextExpanded });
      setSelection(NO_SELECTION);
      // The Git panel follows the main tree's root folder, dropping a repository focused there
      if (primary) {
        const bridge = findPaneBridge(rootRef.current);
        const store = findLayoutStore(rootRef.current);
        if (bridge && store) followTreeRoot(store, bridge);
      }
    },
    [root, workspaceDirectory, primary, updateTabState],
  );

  const listRef = useRef<NativeFlatList<TreeRow>>(null);
  const [scrollTarget, setScrollTarget] = useState<string | null>(null);
  /**
   * Shows an entry in the full tree: ends the filter, opens the folders above it (and a folder
   * itself), then selects it and scrolls it into view
   */
  const revealPath = useCallback(
    (relative: string, isDirectory: boolean) => {
      const parts = relative.split("/");
      const chain = parts
        .slice(0, isDirectory ? parts.length : -1)
        .map((_, index) => parts.slice(0, index + 1).join("/"));
      updateTabState({ expanded: [...new Set([...expandedRef.current, ...chain])] });
      setFilterText("");
      setSelection(selectPaths([relative]));
      setScrollTarget(relative);
    },
    [updateTabState],
  );
  // Rerouted folder links
  const revealFolder = useCallback(
    (path: string) => {
      if (!root) return;
      const absolute = /^([A-Za-z]:[\\/]|[\\/])/.test(path) ? path : joinPath(workspaceDirectory ?? root, path);
      const relative = relativeInside(root, absolute);
      if (relative === null) {
        toast.show(`${path} is outside this tree view`);
        return;
      }
      if (relative !== ROOT_PATH) revealPath(relative, true);
    },
    [root, workspaceDirectory, toast, revealPath],
  );
  const revealFolderRef = useRef(revealFolder);
  revealFolderRef.current = revealFolder;
  useEffect(() => {
    if (!primary || !root) return;
    const bridge = findPaneBridge(rootRef.current);
    if (!bridge) return;
    const workspaceKey = `${bridge.serverId}:${bridge.workspaceId}`;
    const consume = () => {
      const path = takeTreeReveal(workspaceKey);
      if (path !== null) revealFolderRef.current(path);
    };
    // A reveal may have arrived while this tree was still opening
    consume();
    return subscribeTreeReveals(consume);
  }, [primary, root]);
  useEffect(() => {
    if (scrollTarget === null) return;
    const index = displayRows.findIndex((row) => row.entry.path === scrollTarget);
    if (index < 0) return;
    listRef.current?.scrollToIndex({ index, viewPosition: 0.3, animated: true });
    setScrollTarget(null);
  }, [displayRows, scrollTarget]);
  const parentRoot = root ? parentDirectory(root) : null;
  const pinnedFolders = usePinnedFolders(rootRef);

  // Row actions show on hover, or while active: pinned, or already referenced in the message box
  const [hoveredPath, setHoveredPath] = useState<string | null>(null);
  const alwaysShowActions = layout.compact || layout.platform !== "web";
  const [composer, setComposer] = useState<ComposerSnapshot | null>(null);
  const [cwdRevision, setCwdRevision] = useState(0);
  useEffect(() => subscribeComposerText(setComposer), []);
  const attachedPaths = useMemo(() => {
    const attached = new Set<string>();
    if (!composer || !workspaceDirectory) return attached;
    const agentCwd = composer.agentId ? agentCwdCacheRef.current.get(composer.agentId) : undefined;
    // Paths are inserted relative to the chat's working folder, so read them back from there
    const base = composer.draftCwd ?? agentCwd ?? workspaceDirectory;
    for (const path of parseQuotedPaths(composer.text)) attached.add(normalizeAbsolute(resolvePath(base, path)));
    return attached;
  }, [composer, workspaceDirectory, cwdRevision]);
  const isPinned = useCallback(
    (entry: TreeEntry) =>
      entry.kind === "directory" &&
      root !== null &&
      pinnedFolders.has(normalizeAbsolute(joinPath(root, entry.path))),
    [root, pinnedFolders],
  );
  const gitColorOf = useCallback(
    (entry: TreeEntry) =>
      root !== null && gitColors.size > 0 ? gitColors.get(normalizeAbsolute(joinPath(root, entry.path))) : undefined,
    [root, gitColors],
  );
  const isAttached = useCallback(
    (entry: TreeEntry) => root !== null && attachedPaths.has(normalizeAbsolute(joinPath(root, entry.path))),
    [root, attachedPaths],
  );

  const openFile = useCallback(
    (path: string, side: boolean) => {
      if (!root) return;
      const bridge = findPaneBridge(rootRef.current);
      if (!bridge) {
        toast.error("Opening files needs the Paseo desktop or web app");
        return;
      }
      // File tabs take workspace-relative paths; files outside the workspace go absolute
      const absolute = joinPath(root, path);
      const target = {
        kind: "file" as const,
        path: (workspaceDirectory && relativeInside(workspaceDirectory, absolute)) || absolute,
      };
      if (side && bridge.openTargetToSide) {
        bridge.openTargetToSide(target);
        return;
      }
      // better-chat-management owns where new files open; hand it the file without a placement
      const store = findLayoutStore(rootRef.current);
      const workspaceKey = `${bridge.serverId}:${bridge.workspaceId}`;
      if (store && openFileInFileArea(store, workspaceKey, target.path)) return;
      bridge.openPreferredTarget(target, FILE_OPEN_SOURCE);
    },
    [root, workspaceDirectory, toast],
  );

  /** Pins a folder into its own tree view, or unpins it when it already has one */
  const togglePin = useCallback(
    (entry: TreeEntry, pinned: boolean) => {
      if (!root) return;
      const bridge = findPaneBridge(rootRef.current);
      const store = findLayoutStore(rootRef.current);
      if (!bridge || !store) {
        toast.error("Pinned tree views need the Paseo desktop or web app");
        return;
      }
      const folder = joinPath(root, entry.path);
      if (pinned) closeTreeViews(store, bridge, folder);
      else openTreeView(store, bridge, folder);
    },
    [root, toast],
  );

  /** Shows a repository folder in the workspace's Git panel, opening the panel when it is closed */
  const focusRepository = useCallback(
    (folder: string) => {
      const bridge = findPaneBridge(rootRef.current);
      const store = findLayoutStore(rootRef.current);
      if (!bridge || !store) {
        toast.error("The Git panel needs the Paseo desktop or web app");
        return;
      }
      // The Git panel treats the main tree's own root folder as no focus
      focusGitRepository(store, bridge, folder);
    },
    [toast],
  );

  /** Re-roots this view at a folder; a repository there shows in the Git panel */
  const setAsRoot = useCallback(
    (entry: TreeEntry) => {
      if (!root) return;
      const folder = joinPath(root, entry.path);
      changeViewRoot(folder);
      if (!entry.repository || layout.compact) return;
      // The Git panel follows the main tree's root folder; another tree view's root is focused there
      if (!primary) {
        focusRepository(folder);
        return;
      }
      const bridge = findPaneBridge(rootRef.current);
      const store = findLayoutStore(rootRef.current);
      if (bridge && store && findPanelHost(store, `${bridge.serverId}:${bridge.workspaceId}`, GIT_PANEL_ID) === null) {
        openGitPanel(workspaceId);
      }
    },
    [root, changeViewRoot, layout.compact, primary, focusRepository, workspaceId],
  );

  const resolveAgentCwd = useCallback(
    async (agentId: string): Promise<string | null> => {
      const cached = agentCwdCacheRef.current.get(agentId);
      if (cached) return cached;
      const handle = paseo.agents.ref(agentId);
      if (!handle.cwd) await handle.refresh();
      if (handle.cwd) agentCwdCacheRef.current.set(agentId, handle.cwd);
      return handle.cwd;
    },
    [paseo],
  );

  // An agent's working folder is fetched once; re-read the message box when it arrives
  const composerAgentId = composer?.agentId ?? null;
  useEffect(() => {
    if (!composerAgentId || agentCwdCacheRef.current.has(composerAgentId)) return;
    let cancelled = false;
    resolveAgentCwd(composerAgentId)
      .then(() => {
        if (!cancelled) setCwdRevision((revision) => revision + 1);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [composerAgentId, resolveAgentCwd]);

  /** Inserts the entries' quoted paths into a composer, or copies them when none is open */
  const attachToChat = useCallback(
    async (entries: readonly TreeEntry[], dropComposer?: ComposerTarget) => {
      if (!root || entries.length === 0) return;
      const composer = dropComposer ?? findComposerTarget();
      let baseDirectory = composer?.draftCwd ?? null;
      if (!baseDirectory && composer?.agentId) {
        baseDirectory = await resolveAgentCwd(composer.agentId).catch(() => null);
      }
      const from = baseDirectory ?? workspaceDirectory ?? root;
      const links = entries
        .map((entry) => formatQuotedPath(relativeLinkPath(from, joinPath(root, entry.path))))
        .join(" ");
      if (composer) {
        composer.insert(links);
        return;
      }
      await copyText(links);
      toast.show(`No composer is open. Copied ${entries.length === 1 ? links : `${entries.length} paths`}`);
    },
    [root, workspaceDirectory, resolveAgentCwd, toast],
  );

  /** Runs a daemon-host action on a path; failures show as a toast */
  const runOnHost = useCallback(
    async (action: (input: { root: string; path: string }) => Promise<unknown>, path: string) => {
      if (!root) return;
      try {
        await action({ root, path });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
    },
    [root, toast],
  );

  // Every tree view may list a changed folder
  const invalidateListings = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ["better-tree", "directory"] }),
    [queryClient],
  );

  /** Moves entries into a folder of this view, one at a time; resolves whether every one moved */
  const moveTo = useCallback(
    async (sources: readonly string[], toDirectory: string): Promise<boolean> => {
      if (!root) return false;
      // Expanded folders and the selection follow the moved entries; the destination opens
      let expandedPaths = expandedRef.current;
      const moved: string[] = [];
      for (const source of sources) {
        try {
          const { path: movedAbsolute } = await moveEntry({ source, toDirectory: joinPath(root, toDirectory) });
          const sourceInView = relativeInside(root, source);
          const movedInView = relativeInside(root, movedAbsolute);
          if (sourceInView && movedInView) {
            expandedPaths = expandedPaths.map((path) => remapPath(path, sourceInView, movedInView));
          }
          if (movedInView !== null) moved.push(movedInView);
        } catch (error) {
          toast.error(error instanceof Error ? error.message : String(error));
        }
      }
      if (moved.length > 0) {
        const nextExpanded = new Set(expandedPaths);
        if (toDirectory !== ROOT_PATH) nextExpanded.add(toDirectory);
        updateTabState({ expanded: [...nextExpanded] });
        setSelection(selectPaths(moved));
      }
      await invalidateListings();
      return moved.length === sources.length;
    },
    [root, moveEntry, updateTabState, toast, invalidateListings],
  );

  // The drag controller registers once per root and reads current handlers through refs
  const moveToRef = useRef(moveTo);
  moveToRef.current = moveTo;
  const attachToChatRef = useRef(attachToChat);
  attachToChatRef.current = attachToChat;
  useEffect(() => {
    if (!root) return;
    return registerTreeDragAndDrop(rootRef.current, {
      getEntry: (path) => rowsRef.current.find((row) => row.entry.path === path)?.entry ?? null,
      dragEntries: (path) => {
        if (selectedEntriesRef.current.some((entry) => entry.path === path)) return selectedEntriesRef.current;
        const entry = rowsRef.current.find((row) => row.entry.path === path)?.entry;
        return entry ? [entry] : [];
      },
      absolutePath: (relativePath) => joinPath(root, relativePath),
      plainText: (entries) => entries.map((entry) => formatQuotedPath(entry.path)).join(" "),
      onDropTargetChange: setDropTarget,
      onMove: (sources, toDirectory) => void moveToRef.current(sources, toDirectory),
      onDropIntoComposer: (entries, composer) => void attachToChatRef.current(entries, composer),
    });
  }, [root]);

  /** Opens or closes a folder where it shows: in the tree, or among the filter's results */
  const toggleFolder = useCallback(
    (entry: TreeEntry) => {
      if (!filtering) toggleDirectory(entry.path);
      else if (filterView?.parents.has(entry.path)) toggleFilterFolder(entry.path);
      // Nothing shows inside it here, so it opens in the full tree
      else revealPath(entry.path, true);
    },
    [filtering, filterView, toggleDirectory, toggleFilterFolder, revealPath],
  );

  const pressRow = useCallback(
    (entry: TreeEntry) => {
      setSelection(selectPaths([entry.path]));
      if (entry.kind === "directory") toggleFolder(entry);
      else openFile(entry.path, false);
    },
    [toggleFolder, openFile],
  );

  /** Opens the filter's first matching file, or shows its first matching folder in the tree */
  const openFirstMatch = useCallback(() => {
    const first = filterRows.find((row) => filterView?.matched.has(row.entry.path))?.entry;
    if (!first) return;
    if (first.kind === "directory") {
      revealPath(first.path, true);
      return;
    }
    setSelection(selectPaths([first.path]));
    openFile(first.path, false);
  }, [filterRows, filterView, revealPath, openFile]);
  /** Enter in the filter field; typed faster than the filter searched, it searches now and acts on those results */
  const submitFilter = useCallback(() => {
    const query = filterText.trim();
    if (query === "") return;
    if (query === filterQuery && search.data && !search.isPlaceholderData) {
      openFirstMatch();
      return;
    }
    setFilterQuery(query);
    setSubmittedFilter(query);
  }, [filterText, filterQuery, search.data, search.isPlaceholderData, openFirstMatch]);
  useEffect(() => {
    if (submittedFilter === null || submittedFilter !== filterQuery || !search.data || search.isPlaceholderData) return;
    setSubmittedFilter(null);
    openFirstMatch();
  }, [submittedFilter, filterQuery, search.data, search.isPlaceholderData, openFirstMatch]);
  /** Escape in the filter field clears it, then hands the keyboard back to the tree */
  const escapeFilter = useCallback(() => {
    if (filterText !== "") setFilterText("");
    else focusView(rootRef.current);
  }, [filterText]);

  const longPressRow = useCallback((entry: TreeEntry, event: GestureResponderEvent) => {
    setSelection((current) => selectForMenu(current, entry.path));
    setMenu({
      entry,
      x: event.nativeEvent.pageX - rootOffsetRef.current.x,
      y: event.nativeEvent.pageY - rootOffsetRef.current.y,
    });
  }, []);

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setBounds({ width, height });
    rootRef.current?.measureInWindow((x, y) => {
      rootOffsetRef.current = { x, y };
    });
  }, []);

  /** Opens a folder in this view unless it is the root or already open */
  const expandFolder = useCallback(
    (folder: string) => {
      if (folder !== ROOT_PATH && !expandedRef.current.includes(folder)) {
        updateTabState({ expanded: [...expandedRef.current, folder] });
      }
    },
    [updateTabState],
  );

  const startNewEntry = useCallback(
    (kind: TreeEntry["kind"], entry: TreeEntry | null) => {
      const parent = targetFolderOf(entry);
      // The new entry's name editor shows in the full tree
      if (filtering && parent !== ROOT_PATH) revealPath(parent, true);
      else {
        setFilterText("");
        expandFolder(parent);
      }
      setEditing({ type: "new", parent, kind });
    },
    [filtering, revealPath, expandFolder],
  );

  const finishEditing = useCallback(() => {
    setEditing(null);
    focusView(rootRef.current);
  }, []);

  /** Commits a name editor; resolves false to keep editing after an error */
  const submitName = useCallback(
    async (edit: EditState, name: string): Promise<boolean> => {
      if (!root) return false;
      try {
        if (edit.type === "new") {
          const { path } = await createEntry({ root, path: edit.parent, name, kind: edit.kind });
          await invalidateListings();
          finishEditing();
          setSelection(selectPaths([path]));
          if (edit.kind === "file") openFile(path, false);
        } else {
          const { path } = await renameEntry({ root, path: edit.path, name });
          updateTabState({ expanded: expandedRef.current.map((open) => remapPath(open, edit.path, path)) });
          await invalidateListings();
          finishEditing();
          setSelection(selectPaths([path]));
        }
        return true;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
        return false;
      }
    },
    [root, createEntry, renameEntry, invalidateListings, finishEditing, openFile, updateTabState, toast],
  );

  const copyToClipboard = useCallback(
    async (text: string) => {
      try {
        await copyText(text);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
    },
    [toast],
  );

  const canPasteInto = useCallback(
    (entry: TreeEntry | null) => {
      if (!root || !fileClipboard) return false;
      const folder = joinPath(root, targetFolderOf(entry));
      // A cut entry must change folders; a copy may land beside itself but not inside itself
      return fileClipboard.mode === "cut"
        ? canMoveAbsolute(fileClipboard.path, folder)
        : !isSameOrInsideAbsolute(folder, fileClipboard.path);
    },
    [root, fileClipboard],
  );

  /** Pastes into a folder, a file's folder, or the root; a cut entry moves, then leaves the clipboard */
  const pasteInto = useCallback(
    async (entry: TreeEntry | null) => {
      if (!root || !fileClipboard) return;
      const folder = targetFolderOf(entry);
      if (fileClipboard.mode === "cut") {
        if (await moveTo([fileClipboard.path], folder)) setFileClipboard(null);
        return;
      }
      try {
        const { path: copied } = await copyEntry({ source: fileClipboard.path, toDirectory: joinPath(root, folder) });
        expandFolder(folder);
        const pasted = relativeInside(root, copied);
        setSelection(pasted === null ? NO_SELECTION : selectPaths([pasted]));
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      } finally {
        await invalidateListings();
      }
    },
    [root, fileClipboard, moveTo, copyEntry, expandFolder, toast, invalidateListings],
  );

  /** Moves an entry to the Recycle Bin or Trash; errors reach the confirmation dialog */
  const confirmDelete = useCallback(
    async (entry: TreeEntry) => {
      if (!root) return;
      await trashEntry({ root, path: entry.path });
      const isGone = (path: string) => path === entry.path || path.startsWith(`${entry.path}/`);
      updateTabState({ expanded: expandedRef.current.filter((path) => !isGone(path)) });
      setSelection((current) => deselectWhere(current, isGone));
      if (fileClipboard && isSameOrInsideAbsolute(fileClipboard.path, joinPath(root, entry.path))) {
        setFileClipboard(null);
      }
      await invalidateListings();
      focusView(rootRef.current);
    },
    [root, trashEntry, updateTabState, fileClipboard, invalidateListings],
  );

  const deleteConfirmation = useMemo((): Confirmation | null => {
    if (!deleting || !root) return null;
    const bin = trashName(root);
    return {
      title: "Delete",
      icon: "Trash2",
      message:
        deleting.kind === "directory"
          ? `Are you sure you want to delete the folder "${deleting.name}" and its contents?`
          : `Are you sure you want to delete "${deleting.name}"?`,
      details: [`You can restore it from the ${bin}.`],
      confirmLabel: `Move to ${bin}`,
      busyLabel: "Deleting…",
      danger: true,
      run: () => confirmDelete(deleting),
    };
  }, [deleting, root, confirmDelete]);

  /** Runs a keyboard shortcut on the selection's lead entry; returns whether it applied */
  runCommandRef.current = (command) => {
    if (!root || editing || deleting) return false;
    if (command === "find") {
      focusFilter();
      return true;
    }
    const lead = selection.lead;
    const entry = lead === null ? null : (rows.find((row) => row.entry.path === lead)?.entry ?? null);
    if (command === "paste") {
      if (!canPasteInto(entry)) return false;
      void pasteInto(entry);
      return true;
    }
    if (!entry) return false;
    const absolute = joinPath(root, entry.path);
    switch (command) {
      case "cut":
      case "copy":
        setFileClipboard({ mode: command, path: absolute });
        break;
      case "copyPath":
        void copyToClipboard(absolute);
        break;
      case "copyRelativePath":
        void copyToClipboard(copyableRelativePath(workspaceDirectory, root, entry.path));
        break;
      case "rename":
        setEditing({ type: "rename", path: entry.path });
        break;
      case "delete":
        setDeleting(entry);
        break;
      case "revealInFileBrowser":
        void runOnHost(openInFileBrowser, entry.path);
        break;
    }
    return true;
  };

  const menuGroups = useMemo((): ContextMenuGroups => {
    if (!menu || !root) return [];
    const { entry } = menu;
    const shortcut = (command: TreeCommand) => shortcutLabel(command, SHORTCUT_LABELS_MAC);
    const hostPath = entry?.path ?? ROOT_PATH;
    const createGroup: ContextMenuItem[] = [
      { id: "new-file", label: "New file...", icon: "FilePlus", onSelect: () => startNewEntry("file", entry) },
      { id: "new-folder", label: "New folder...", icon: "FolderPlus", onSelect: () => startNewEntry("directory", entry) },
    ];
    const revealGroup: ContextMenuItem[] = [
      {
        id: "file-browser",
        label: "Open in file browser",
        icon: "FolderOpen",
        shortcut: shortcut("revealInFileBrowser"),
        onSelect: () => void runOnHost(openInFileBrowser, hostPath),
      },
    ];
    if (entry === null || entry.kind === "directory") {
      revealGroup.push({
        id: "terminal",
        label: "Open terminal",
        icon: "SquareTerminal",
        onSelect: () => void runOnHost(openTerminal, hostPath),
      });
    }
    const pasteItem: ContextMenuItem = {
      id: "paste",
      label: "Paste",
      icon: "ClipboardPaste",
      shortcut: shortcut("paste"),
      disabled: !canPasteInto(entry),
      onSelect: () => void pasteInto(entry),
    };
    if (entry === null) return [createGroup, revealGroup, [pasteItem]];

    const absolute = joinPath(root, entry.path);
    // Attaching is what selecting several rows is for, so it takes the selection holding the row
    const attaching = selectedEntries.some((selected) => selected.path === entry.path) ? selectedEntries : [entry];
    const openGroup: ContextMenuItem[] = [];
    if (entry.kind === "directory") {
      const open = filtering
        ? Boolean(filterView?.parents.has(entry.path)) && !filterClosed.has(entry.path)
        : expanded.has(entry.path);
      openGroup.push({
        id: "toggle",
        label: open ? "Collapse" : "Expand",
        icon: open ? "ChevronDown" : "ChevronRight",
        onSelect: () => toggleFolder(entry),
      });
      openGroup.push({
        id: "set-root",
        label: "Set as root folder",
        icon: "FolderRoot",
        onSelect: () => setAsRoot(entry),
      });
      if (!layout.compact) {
        const pinned = isPinned(entry);
        openGroup.push({
          id: "pin",
          label: pinned ? "Unpin tree view" : "Open in new tree view",
          icon: pinned ? "PinOff" : "Pin",
          onSelect: () => togglePin(entry, pinned),
        });
        if (entry.repository) {
          openGroup.push({
            id: "focus-repository",
            label: "Focus git repo",
            icon: "FolderGit2",
            onSelect: () => focusRepository(absolute),
          });
        }
      }
    } else {
      openGroup.push({ id: "open", label: "Open", icon: "FileText", onSelect: () => openFile(entry.path, false) });
      if (!layout.compact) {
        openGroup.push({
          id: "open-side",
          label: "Open to the side",
          icon: "ArrowRightToLine",
          onSelect: () => openFile(entry.path, true),
        });
      }
      openGroup.push(
        {
          id: "text-editor",
          label: "Open in Default Text Editor",
          icon: "SquarePen",
          onSelect: () => void runOnHost(openInTextEditor, entry.path),
        },
        {
          id: "default-app",
          label: "Open with default app",
          icon: "ExternalLink",
          onSelect: () => void runOnHost(openWithDefaultApp, entry.path),
        },
      );
    }
    return [
      filtering
        ? [
            {
              id: "reveal",
              label: "Reveal in tree",
              icon: "LocateFixed",
              onSelect: () => revealPath(entry.path, entry.kind === "directory"),
            },
          ]
        : [],
      entry.kind === "directory" ? createGroup : [],
      openGroup,
      revealGroup,
      [
        {
          id: "attach",
          label: attaching.length > 1 ? `Attach ${attaching.length} items to chat` : "Attach to chat",
          icon: "Paperclip",
          onSelect: () => void attachToChat(attaching),
        },
      ],
      [
        {
          id: "cut",
          label: "Cut",
          icon: "Scissors",
          shortcut: shortcut("cut"),
          onSelect: () => setFileClipboard({ mode: "cut", path: absolute }),
        },
        {
          id: "copy",
          label: "Copy",
          icon: "Copy",
          shortcut: shortcut("copy"),
          onSelect: () => setFileClipboard({ mode: "copy", path: absolute }),
        },
        pasteItem,
      ],
      [
        {
          id: "copy-path",
          label: "Copy path",
          icon: "ClipboardCopy",
          shortcut: shortcut("copyPath"),
          onSelect: () => void copyToClipboard(absolute),
        },
        {
          id: "copy-relative-path",
          label: "Copy relative path",
          icon: "ClipboardCopy",
          shortcut: shortcut("copyRelativePath"),
          onSelect: () => void copyToClipboard(copyableRelativePath(workspaceDirectory, root, entry.path)),
        },
      ],
      [
        {
          id: "rename",
          label: "Rename...",
          icon: "PencilLine",
          shortcut: shortcut("rename"),
          onSelect: () => setEditing({ type: "rename", path: entry.path }),
        },
        {
          id: "delete",
          label: "Delete",
          icon: "Trash2",
          shortcut: shortcut("delete"),
          onSelect: () => setDeleting(entry),
        },
      ],
    ];
  }, [
    menu,
    root,
    workspaceDirectory,
    expanded,
    filtering,
    filterView,
    filterClosed,
    layout.compact,
    toggleFolder,
    revealPath,
    setAsRoot,
    focusRepository,
    isPinned,
    togglePin,
    openFile,
    runOnHost,
    openInTextEditor,
    openInFileBrowser,
    openTerminal,
    openWithDefaultApp,
    attachToChat,
    selectedEntries,
    startNewEntry,
    canPasteInto,
    pasteInto,
    copyToClipboard,
  ]);

  const styles = useMemo(() => createStyles(theme), [theme]);

  const cutPath = fileClipboard?.mode === "cut" ? normalizeAbsolute(fileClipboard.path) : null;
  const renderRow = useCallback(
    ({ item }: { item: TreeRow }) => {
      const isEditing =
        editing !== null &&
        (editing.type === "new" ? item.entry.path === NEW_ENTRY_PATH : item.entry.path === editing.path);
      return (
        <TreeRowView
          row={item}
          selected={selection.paths.has(item.entry.path)}
          dropHighlighted={item.entry.kind === "directory" && item.entry.path === dropTarget}
          pinned={isPinned(item.entry)}
          attached={isAttached(item.entry)}
          cut={cutPath !== null && root !== null && normalizeAbsolute(joinPath(root, item.entry.path)) === cutPath}
          gitColor={gitColorOf(item.entry)}
          showActions={alwaysShowActions || item.entry.path === hoveredPath}
          rowPadding={rowPadding}
          fontWeight={fontWeight}
          fontSize={fontSize}
          theme={theme}
          filter={filtering && filterView?.matched.has(item.entry.path) ? filter : null}
          editor={
            isEditing && editing
              ? {
                  initial: editing.type === "new" ? "" : item.entry.name,
                  onSubmit: (name) => submitName(editing, name),
                  onCancel: finishEditing,
                }
              : undefined
          }
          onPress={pressRow}
          onLongPress={longPressRow}
          onAttach={attachToChat}
          onPin={layout.compact ? undefined : togglePin}
        />
      );
    },
    [
      isPinned,
      isAttached,
      cutPath,
      root,
      gitColorOf,
      alwaysShowActions,
      hoveredPath,
      selection,
      dropTarget,
      rowPadding,
      fontWeight,
      fontSize,
      theme,
      filter,
      filtering,
      filterView,
      editing,
      submitName,
      finishEditing,
      layout.compact,
      pressRow,
      longPressRow,
      attachToChat,
      togglePin,
    ],
  );

  // Toolbar title: workspace-relative inside the workspace, absolute outside it
  let viewLabel = workspace?.name ?? "";
  if (root && workspaceDirectory) {
    const inside = relativeInside(workspaceDirectory, root);
    if (inside === null) viewLabel = root;
    else if (inside !== "") viewLabel = `${workspace?.name ?? baseName(workspaceDirectory)}/${inside}`;
  }
  const atWorkspaceRoot = tabState.viewRoot == null;

  const renderList = (footer: ReactElement | null) => (
    <View {...treeBodyDataProps()} style={styles.body}>
      <FlatList
        ref={listRef}
        data={displayRows}
        keyExtractor={(row) => row.entry.path}
        renderItem={renderRow}
        extraData={renderRow}
        style={dropTarget === ROOT_PATH ? styles.rootDropTarget : undefined}
        contentContainerStyle={styles.listContent}
        ListFooterComponent={footer}
        onScrollToIndexFailed={(info) => {
          // Rows not rendered yet: jump near the row, then aim again once it exists
          listRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
          setTimeout(() => listRef.current?.scrollToIndex({ index: info.index, viewPosition: 0.3 }), 50);
        }}
      />
    </View>
  );

  let body: ReactNode;
  let filterStatus: string | null = null;
  if (!root) {
    body = <Text style={styles.message}>This workspace has no directory.</Text>;
  } else if (filtering) {
    const result = search.data;
    if (!result) {
      body = search.isError ? (
        <Text style={styles.error}>{search.error.message}</Text>
      ) : (
        <Text style={styles.message}>Searching…</Text>
      );
    } else if (result.matchCount === 0) {
      filterStatus = "No matches";
      body = (
        <View>
          <Text style={styles.message}>No files or folders match.</Text>
          <Text style={styles.filterNote}>Gitignored files and the contents of node_modules folders are not searched.</Text>
        </View>
      );
    } else {
      const listed = filterView?.matched.size ?? 0;
      const total = result.matchCount;
      filterStatus =
        listed < total
          ? `${listed.toLocaleString()} of ${total.toLocaleString()}`
          : `${total.toLocaleString()} ${total === 1 ? "match" : "matches"}`;
      const notes: string[] = [];
      if (listed < total) notes.push(`Showing the ${listed.toLocaleString()} matches nearest the top; type more to narrow them down.`);
      if (result.incomplete) notes.push("The search stopped early in this very large folder, so some matches may be missing.");
      body = renderList(notes.length > 0 ? <Text style={styles.filterNote}>{notes.join(" ")}</Text> : null);
    }
  } else if (rootError) {
    body = <Text style={styles.error}>{rootError.message}</Text>;
  } else if (rootPending) {
    body = <Loading />;
  } else {
    body = renderList(null);
  }

  return (
    <View ref={rootRef} style={styles.screen} onLayout={handleLayout}>
      <View style={styles.toolbar}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Go up one folder"
          accessibilityState={{ disabled: parentRoot === null }}
          disabled={parentRoot === null}
          hitSlop={6}
          onPress={() => parentRoot && changeViewRoot(parentRoot)}
          style={{ opacity: parentRoot === null ? 0.4 : 1 }}
        >
          <Icon name="ArrowUp" size={ROW_ICON_SIZE} color={theme.colors.foregroundMuted} />
        </Pressable>
        {atWorkspaceRoot || !workspaceDirectory ? null : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back to the workspace folder"
            hitSlop={6}
            onPress={() => changeViewRoot(workspaceDirectory)}
          >
            <Icon name="House" size={ROW_ICON_SIZE} color={theme.colors.foregroundMuted} />
          </Pressable>
        )}
        <Text style={styles.toolbarTitle} numberOfLines={1}>
          {viewLabel}
        </Text>
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: treeGitChanges }}
          onPress={() => updateDisplay({ treeGitChanges: !treeGitChanges })}
          style={styles.toolbarToggle}
        >
          <Checkbox
            checked={treeGitChanges}
            theme={theme}
            accessibilityLabel="Show Git changes in the tree"
            onChange={(checked) => updateDisplay({ treeGitChanges: checked })}
          />
          <Text style={styles.toolbarLabel}>Changes</Text>
        </Pressable>
        {layout.compact || !primary ? null : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open the Git panel"
            hitSlop={6}
            onPress={() => openGitPanel(workspaceId)}
          >
            <Icon name="GitBranch" size={ROW_ICON_SIZE} color={theme.colors.foregroundMuted} />
          </Pressable>
        )}
      </View>
      <View style={styles.body}>{body}</View>
      {root ? (
        <FilterBar
          inputRef={filterInputRef}
          value={filterText}
          placeholder={
            layout.platform === "web" && !layout.compact
              ? `Filter (${shortcutLabel("find", SHORTCUT_LABELS_MAC)})`
              : "Filter"
          }
          searching={
            filterText.trim() !== filterQuery ||
            (filtering && search.isFetching && (search.isPlaceholderData || !search.data))
          }
          status={filterStatus}
          theme={theme}
          onChange={setFilterText}
          onSubmit={submitFilter}
          onEscape={escapeFilter}
        />
      ) : null}
      {menu ? (
        <ContextMenu
          groups={menuGroups}
          x={menu.x}
          y={menu.y}
          bounds={bounds}
          theme={theme}
          onClose={(reason) => {
            setMenu(null);
            if (reason !== "outside") focusView(rootRef.current);
          }}
        />
      ) : null}
      <ConfirmModal confirmation={deleteConfirmation} theme={theme} onClose={() => setDeleting(null)} />
    </View>
  );
}

/** Folder that New file, New folder, and Paste act in: a folder itself, a file's folder, or the root */
function targetFolderOf(entry: TreeEntry | null): string {
  if (entry === null) return ROOT_PATH;
  return entry.kind === "directory" ? entry.path : parentPath(entry.path);
}

interface NameEditorProps {
  /** Current name, or "" for a new entry */
  initial: string;
  /** Resolves false to keep editing, after the caller reported the error */
  onSubmit(name: string): Promise<boolean>;
  onCancel(): void;
}

/**
 * A hidden row button keeps its space, so names do not shift when the mouse arrives, but takes
 * no clicks and is skipped by screen readers
 */
function hiddenUnless(visible: boolean): object {
  return visible
    ? {}
    : { pointerEvents: "none", accessibilityElementsHidden: true, importantForAccessibility: "no-hide-descendants" };
}

/** A name with the filter's matches marked, as nested text that keeps the row's color */
function highlightMatches(name: string, filter: TreeFilter): ReactNode {
  const ranges = filterMatchRanges(filter, name);
  if (ranges.length === 0) return name;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) parts.push(<Text key={`text-${at}`}>{name.slice(at, start)}</Text>);
    parts.push(
      <Text key={`match-${start}`} style={FILTER_MATCH_STYLE}>
        {name.slice(start, end)}
      </Text>,
    );
    at = end;
  }
  if (at < name.length) parts.push(<Text key={`text-${at}`}>{name.slice(at)}</Text>);
  return parts;
}

const TreeRowView = memo(function TreeRowView({
  row,
  selected,
  dropHighlighted,
  pinned,
  attached,
  cut,
  gitColor,
  filter,
  showActions,
  rowPadding,
  fontWeight,
  fontSize,
  theme,
  editor,
  onPress,
  onLongPress,
  onAttach,
  onPin,
}: {
  row: TreeRow;
  selected: boolean;
  dropHighlighted: boolean;
  /** This folder has an open pinned tree view */
  pinned: boolean;
  /** This path is already referenced in the message box */
  attached: boolean;
  /** Cut to the file clipboard; shown faded until pasted */
  cut: boolean;
  /** Git change color of the file, or of the strongest change inside the folder */
  gitColor: string | undefined;
  /** The filter whose matches to mark in the name, on a row that matched it */
  filter: TreeFilter | null;
  /** Hovered, or a layout without hover; otherwise only active buttons show */
  showActions: boolean;
  rowPadding: number;
  fontWeight: number;
  /** Text size; the row's icons are one point larger */
  fontSize: number;
  theme: PluginTheme;
  /** Present while this row's name is being typed */
  editor?: NameEditorProps;
  onPress(entry: TreeEntry): void;
  onLongPress(entry: TreeEntry, event: GestureResponderEvent): void;
  onAttach(entries: readonly TreeEntry[]): void;
  /** Pins or unpins; absent where pinned views cannot open (compact layouts) */
  onPin?: (entry: TreeEntry, pinned: boolean) => void;
}) {
  const { entry, depth, expanded, loading } = row;
  const isDirectory = entry.kind === "directory";
  const mutedColor = theme.colors.foregroundMuted;
  const iconSize = fontSize + 1;
  return (
    <View
      {...treeRowDataProps(entry.path)}
      ref={(node) => setRowDraggable(node, !editor)}
      style={{
        flexDirection: "row",
        alignItems: "center",
        backgroundColor: selected || dropHighlighted ? theme.colors.surface2 : undefined,
        outlineStyle: dropHighlighted ? "solid" : undefined,
        outlineWidth: dropHighlighted ? 1 : undefined,
        outlineColor: dropHighlighted ? theme.colors.accent : undefined,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={entry.name}
        accessibilityState={isDirectory ? { expanded } : undefined}
        disabled={editor !== undefined}
        onPress={() => onPress(entry)}
        onLongPress={(event) => onLongPress(entry, event)}
        style={({ pressed }) => ({
          flex: 1,
          minWidth: 0,
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          paddingVertical: rowPadding,
          paddingLeft: 6 + depth * INDENT_WIDTH,
          backgroundColor: pressed ? theme.colors.surface1 : undefined,
          opacity: cut ? 0.5 : 1,
        })}
      >
        <View style={{ width: iconSize }}>
          {isDirectory ? (
            <Icon
              name={expanded ? "ChevronDown" : "ChevronRight"}
              size={iconSize}
              color={mutedColor}
            />
          ) : null}
        </View>
        {isDirectory ? (
          <Icon name={expanded ? "FolderOpen" : "Folder"} size={iconSize} color={mutedColor} />
        ) : (
          <FileIcon icon={entry.icon} size={iconSize} theme={theme} />
        )}
        {editor ? (
          <NameEditor {...editor} fontWeight={fontWeight} fontSize={fontSize} theme={theme} />
        ) : (
          <Text
            numberOfLines={1}
            style={{
              flexShrink: 1,
              // A repository folder's name is violet over any change color
              color: (entry.repository ? REPOSITORY_COLOR : gitColor) ?? theme.colors.foreground,
              fontSize,
              fontWeight: String(fontWeight) as TextStyle["fontWeight"],
            }}
          >
            {filter ? highlightMatches(entry.name, filter) : entry.name}
          </Text>
        )}
        {loading ? <Text style={{ color: mutedColor, fontSize }}>…</Text> : null}
      </Pressable>
      {!editor && isDirectory && onPin ? (
        <Pressable
          {...treeActionDataProps()}
          {...hiddenUnless(showActions || pinned)}
          accessibilityRole="button"
          accessibilityLabel={
            pinned ? `Unpin the tree view of ${entry.name}` : `Open ${entry.name} in a new tree view`
          }
          accessibilityState={{ selected: pinned }}
          hitSlop={4}
          onPress={() => onPin(entry, pinned)}
          style={({ pressed }) => ({
            paddingLeft: 8,
            paddingVertical: rowPadding,
            opacity: showActions || pinned ? (pressed ? 0.5 : 1) : 0,
          })}
        >
          {pinned ? (
            <Icon icon={PIN_ACTIVE_ICON} size={iconSize} color={theme.colors.accent} />
          ) : (
            <Icon name="Pin" size={iconSize} color={mutedColor} />
          )}
        </Pressable>
      ) : null}
      {editor ? null : (
        <Pressable
          {...treeActionDataProps()}
          {...hiddenUnless(showActions || attached)}
          accessibilityRole="button"
          accessibilityLabel={
            attached ? `${entry.name} is in the message; attach it again` : `Attach ${entry.name} to chat`
          }
          accessibilityState={{ selected: attached }}
          hitSlop={4}
          onPress={() => onAttach([entry])}
          style={({ pressed }) => ({
            paddingHorizontal: 8,
            paddingVertical: rowPadding,
            opacity: showActions || attached ? (pressed ? 0.5 : 1) : 0,
          })}
        >
          <Icon name="Paperclip" size={iconSize} color={attached ? theme.colors.accent : mutedColor} />
        </Pressable>
      )}
    </View>
  );
});

/**
 * Inline name field, as in VS Code: Enter or leaving the field commits, Escape cancels. A file's
 * name is selected up to its extension.
 */
function NameEditor({
  initial,
  onSubmit,
  onCancel,
  fontWeight,
  fontSize,
  theme,
}: NameEditorProps & { fontWeight: number; fontSize: number; theme: PluginTheme }) {
  const [text, setText] = useState(initial);
  const inputRef = useRef<TextInput>(null);
  // Enter, blur, and Escape can all arrive for one edit; only the first counts
  const settledRef = useRef(false);
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    const dot = initial.lastIndexOf(".");
    const end = dot > 0 ? dot : initial.length;
    // On web the ref is the DOM input itself; native TextInput refs have setSelection instead
    if ("setSelectionRange" in input && typeof input.setSelectionRange === "function") {
      input.setSelectionRange(0, end);
    } else if (typeof input.setSelection === "function") {
      input.setSelection(0, end);
    }
  }, [initial]);
  const finish = async (commit: boolean) => {
    if (settledRef.current) return;
    settledRef.current = true;
    const name = text.trim();
    if (!commit || name === "" || name === initial) {
      onCancel();
      return;
    }
    if (await onSubmit(name)) return;
    settledRef.current = false;
    inputRef.current?.focus();
  };
  return (
    <TextInput
      ref={inputRef}
      value={text}
      onChangeText={setText}
      onSubmitEditing={() => void finish(true)}
      onBlur={() => void finish(true)}
      onKeyPress={(event) => {
        if (event.nativeEvent.key === "Escape") void finish(false);
      }}
      autoCapitalize="none"
      autoCorrect={false}
      spellCheck={false}
      accessibilityLabel={initial ? `Rename ${initial}` : "Name"}
      style={{
        flex: 1,
        minWidth: 0,
        paddingVertical: 0,
        paddingHorizontal: 4,
        borderWidth: 1,
        borderColor: theme.colors.accent,
        borderRadius: 2,
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface0,
        fontSize,
        fontWeight: String(fontWeight) as TextStyle["fontWeight"],
      }}
    />
  );
}

function createStyles(theme: PluginTheme) {
  return {
    screen: { flex: 1, backgroundColor: theme.colors.surface0 },
    toolbar: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    toolbarTitle: { flex: 1, color: theme.colors.foregroundMuted, fontSize: 12 },
    toolbarToggle: { flexDirection: "row" as const, alignItems: "center" as const, gap: 4 },
    toolbarLabel: { color: theme.colors.foregroundMuted, fontSize: 11 },
    listContent: { paddingVertical: 4 },
    body: { flex: 1 },
    rootDropTarget: { backgroundColor: theme.colors.surface1 },
    message: { padding: 12, color: theme.colors.foregroundMuted },
    error: { padding: 12, color: theme.colors.statusDanger },
    filterNote: { paddingHorizontal: 12, paddingVertical: 6, color: theme.colors.foregroundMuted, fontSize: 11 },
  };
}
