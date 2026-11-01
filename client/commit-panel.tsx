import type { PluginTheme } from "@getpaseo/plugin";
import { type PluginWorkspacePanelProps, useRpc, useSettings, useTabState } from "@getpaseo/plugin/client";
import { copyText, FlatList, Icon, Loading, ScrollView, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { memo, type ReactNode, useCallback, useId, useMemo, useRef, useState } from "react";
import { type LayoutChangeEvent, Platform, Pressable, StyleSheet, Text, type TextStyle, View } from "react-native";
import { DEFAULT_FONT_SIZE, DEFAULT_FONT_WEIGHT, DEFAULT_ROW_PADDING, preferences } from "../shared/contracts";
import {
  type CommitDetails,
  type CommitFile,
  type CommitFileStatus,
  gitCommitDetailsRpc,
  gitCommitFileDiffRpc,
  gitCommitFileRpc,
} from "../shared/git-contracts";
import { buildPathRows, type PathRow } from "./change-list";
import { type CommitTabState, CommitTabStateSchema, type CommitViewMode } from "./commit-tabs";
import type { DiffViewMode, EditorLook } from "./diff-editor";
import { DiffLineView, lookFromTheme, ModeSelector, MONOSPACE, useMountedDiff } from "./diff-views";
import { FileIcon } from "./file-icon";
import { DELETED_COLOR, TRACKED_COLOR, UNTRACKED_COLOR } from "./git-colors";
import { type DiffLine, formatRelativeTime, parseUnifiedDiff } from "./git-model";
import { LineTotals } from "./line-totals";
import { savePreferences, trackPreferences } from "./preference-saver";
import { ResizeDivider } from "./resize-divider";
import { baseName, parentPath } from "./tree-model";
import type { DragHandlers } from "./web";

const NullableCommitTabStateSchema = CommitTabStateSchema.nullable();
const NO_FILES: readonly CommitFile[] = [];
const NONE_COLLAPSED: ReadonlySet<string> = new Set();
// The changes tree's share of the tab, which its divider changes
const DEFAULT_TREE_SHARE = 0.3;
const MIN_TREE_SHARE = 0.1;
const MAX_TREE_SHARE = 0.9;
// Tree rows indent like the file tree's
const INDENT_WIDTH = 12;
const ICON_SIZE = 14;
const BODY_MAX_HEIGHT = 120;
const VIEW_MODES: readonly { mode: CommitViewMode; label: string }[] = [
  { mode: "unified", label: "Unified" },
  { mode: "changes", label: "Changes only" },
  { mode: "split", label: "Split" },
  { mode: "file", label: "File" },
];
const STATUS_LETTERS: Record<CommitFileStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  "type-changed": "T",
};
const STATUS_LABELS: Record<CommitFileStatus, string> = {
  added: "Added",
  modified: "Modified",
  deleted: "Deleted",
  renamed: "Renamed",
  copied: "Copied",
  "type-changed": "Type changed",
};
// New files as the changes list colors them, edits as tracked changes
const STATUS_COLORS: Record<CommitFileStatus, string> = {
  added: UNTRACKED_COLOR,
  modified: TRACKED_COLOR,
  deleted: DELETED_COLOR,
  renamed: TRACKED_COLOR,
  copied: UNTRACKED_COLOR,
  "type-changed": TRACKED_COLOR,
};

type Styles = ReturnType<typeof createStyles>;
type FileRow = Extract<PathRow<CommitFile>, { kind: "file" }>;

/** The file tree's row spacing, text weight, and text size, which the changes tree shares */
interface TreeDisplay {
  rowPadding: number;
  fontWeight: number;
  fontSize: number;
}

/**
 * A commit in its own tab: its message, then its changed files as a tree beside an editor view of
 * the selected file, with a divider between them like editor-enhancements' Markdown Split
 */
export function CommitPanel({ theme, tab, layout }: PluginWorkspacePanelProps) {
  const [state, setState] = useTabState(tab, NullableCommitTabStateSchema, null);
  const styles = useMemo(() => createStyles(theme), [theme]);
  if (!state) {
    return (
      <View style={styles.screen}>
        <Text style={styles.message}>Pick a commit in the Git panel's History.</Text>
      </View>
    );
  }
  return <CommitView state={state} setState={setState} stacked={layout.compact} theme={theme} styles={styles} />;
}

function CommitView({
  state,
  setState,
  stacked,
  theme,
  styles,
}: {
  state: CommitTabState;
  setState(state: CommitTabState): void;
  /** Phones put the tree above the editor view instead of beside it */
  stacked: boolean;
  theme: PluginTheme;
  styles: Styles;
}) {
  const stateRef = useRef(state);
  stateRef.current = state;
  const updateState = useCallback(
    (patch: Partial<CommitTabState>) => setState({ ...stateRef.current, ...patch }),
    [setState],
  );
  // Split views of this tab scroll in pairs of their own
  const pairPrefix = useId();
  const loadDetails = useRpc(gitCommitDetailsRpc);
  // A commit never changes, so its details load once
  const details = useQuery({
    queryKey: ["better-tree", "commit", state.worktree, state.sha],
    queryFn: () => loadDetails({ worktree: state.worktree, sha: state.sha }),
    staleTime: Infinity,
  });
  const files = details.data?.files ?? NO_FILES;
  // Collapsed folders; not persisted, like the changes list's
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(NONE_COLLAPSED);
  const rows = useMemo(() => buildPathRows(files, "", collapsed), [files, collapsed]);
  const selected = useMemo(() => {
    const chosen = files.find((file) => file.path === state.file);
    if (chosen) return chosen;
    // The first file in tree order, whatever is collapsed
    const first = buildPathRows(files, "", NONE_COLLAPSED).find((row): row is FileRow => row.kind === "file");
    return first?.file ?? null;
  }, [files, state.file]);
  const toggleFolder = useCallback((key: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const selectFile = useCallback((path: string) => updateState({ file: path }), [updateState]);
  const changeMode = useCallback((mode: CommitViewMode) => updateState({ mode }), [updateState]);

  const settings = useSettings(preferences);
  trackPreferences(settings);
  const values = settings.status === "ready" ? settings.values : null;
  const rowPadding = values?.rowPadding ?? DEFAULT_ROW_PADDING;
  const fontWeight = values?.fontWeight ?? DEFAULT_FONT_WEIGHT;
  const fontSize = values?.fontSize ?? DEFAULT_FONT_SIZE;
  const display = useMemo((): TreeDisplay => ({ rowPadding, fontWeight, fontSize }), [rowPadding, fontWeight, fontSize]);

  // The tree's share is global; the local value applies while dragging and bridges the debounced save
  const [shareOverride, setShareOverride] = useState<number | null>(null);
  const share = Math.min(MAX_TREE_SHARE, Math.max(MIN_TREE_SHARE, shareOverride ?? values?.commitTreeShare ?? DEFAULT_TREE_SHARE));
  const shareRef = useRef(share);
  shareRef.current = share;
  const bodySizeRef = useRef(1);
  const dragRef = useRef<{ start: number; latest: number | null } | null>(null);
  const dividerHandlers = useMemo(
    (): DragHandlers => ({
      onStart: () => {
        dragRef.current = { start: shareRef.current, latest: null };
      },
      onMove: (delta) => {
        const drag = dragRef.current;
        if (!drag) return;
        drag.latest = Math.min(MAX_TREE_SHARE, Math.max(MIN_TREE_SHARE, drag.start + delta / bodySizeRef.current));
        setShareOverride(drag.latest);
      },
      onEnd: () => {
        const latest = dragRef.current?.latest;
        dragRef.current = null;
        if (latest != null) savePreferences({ commitTreeShare: latest });
      },
    }),
    [],
  );
  const handleBodyLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { width, height } = event.nativeEvent.layout;
      bodySizeRef.current = Math.max(1, stacked ? height : width);
    },
    [stacked],
  );

  let body: ReactNode;
  if (details.isError) {
    body = <Text style={styles.error}>{details.error.message}</Text>;
  } else if (!details.data) {
    body = <Loading />;
  } else if (files.length === 0) {
    body = <Text style={styles.message}>This commit changes no files.</Text>;
  } else {
    const extent = `${share * 100}%` as const;
    body = (
      <View style={[styles.body, { flexDirection: stacked ? "column" : "row" }]} onLayout={handleBodyLayout}>
        <View style={[styles.treePane, stacked ? { height: extent } : { width: extent }]}>
          <CommitFileTree
            rows={rows}
            count={files.length}
            selectedPath={selected?.path ?? null}
            display={display}
            theme={theme}
            styles={styles}
            onSelectFile={selectFile}
            onToggleFolder={toggleFolder}
          />
        </View>
        <ResizeDivider
          axis={stacked ? "y" : "x"}
          theme={theme}
          accessibilityLabel="Resize the changes tree"
          handlers={dividerHandlers}
        />
        <View style={styles.editorPane}>
          {selected ? (
            <CommitFileView
              // A new file starts a new view, scrolled to its top
              key={selected.path}
              worktree={state.worktree}
              details={details.data}
              file={selected}
              mode={state.mode ?? "unified"}
              pairPrefix={pairPrefix}
              theme={theme}
              styles={styles}
              onModeChange={changeMode}
            />
          ) : null}
        </View>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <CommitHeader state={state} details={details.data ?? null} theme={theme} styles={styles} />
      {body}
    </View>
  );
}

function CommitHeader({
  state,
  details,
  theme,
  styles,
}: {
  state: CommitTabState;
  details: CommitDetails | null;
  theme: PluginTheme;
  styles: Styles;
}) {
  const toast = useToast();
  const shortSha = details?.shortSha ?? state.shortSha;
  const totals = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const file of details?.files ?? NO_FILES) {
      additions += file.additions;
      deletions += file.deletions;
    }
    return { additions, deletions };
  }, [details]);
  const copySha = useCallback(() => {
    copyText(state.sha).then(
      () => toast.show(`Copied ${state.sha}`, { variant: "success" }),
      (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
    );
  }, [state.sha, toast]);
  const fileCount = details?.files.length ?? 0;
  const firstParent = details?.parents[0];
  return (
    <View style={styles.header}>
      <View style={styles.headerTitleRow}>
        <Icon name="GitCommitHorizontal" size={ICON_SIZE} color={theme.colors.foregroundMuted} />
        <Text selectable numberOfLines={2} style={styles.subject}>
          {details?.subject ?? state.subject}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Copy the commit id ${state.sha}`}
          hitSlop={6}
          onPress={copySha}
          style={({ pressed }) => [styles.iconButton, pressed ? styles.pressed : null]}
        >
          <Icon name="Copy" size={ICON_SIZE} color={theme.colors.foregroundMuted} />
        </Pressable>
      </View>
      <Text numberOfLines={1} style={styles.headerDetail}>
        <Text selectable style={styles.sha}>
          {shortSha}
        </Text>
        {details
          ? ` · ${details.author} · ${formatRelativeTime(details.time, Date.now())}, ${new Date(details.time).toLocaleString()}` +
            ` · ${fileCount} ${fileCount === 1 ? "file" : "files"}  `
          : null}
        {details ? <LineTotals additions={totals.additions} deletions={totals.deletions} theme={theme} fontSize={12} /> : null}
      </Text>
      {details && details.parents.length > 1 && firstParent ? (
        <Text numberOfLines={1} style={styles.headerDetail}>
          A merge: its changes against its first parent, {firstParent.slice(0, shortSha.length)}
        </Text>
      ) : null}
      {details?.body ? (
        <ScrollView style={styles.messageBody}>
          <Text selectable style={styles.bodyText}>
            {details.body}
          </Text>
        </ScrollView>
      ) : null}
    </View>
  );
}

function CommitFileTree({
  rows,
  count,
  selectedPath,
  display,
  theme,
  styles,
  onSelectFile,
  onToggleFolder,
}: {
  rows: readonly PathRow<CommitFile>[];
  count: number;
  selectedPath: string | null;
  display: TreeDisplay;
  theme: PluginTheme;
  styles: Styles;
  onSelectFile(path: string): void;
  onToggleFolder(key: string): void;
}) {
  const renderRow = useCallback(
    ({ item }: { item: PathRow<CommitFile> }) => (
      <CommitTreeRow
        row={item}
        selected={item.kind === "file" && item.file.path === selectedPath}
        display={display}
        theme={theme}
        onSelectFile={onSelectFile}
        onToggleFolder={onToggleFolder}
      />
    ),
    [selectedPath, display, theme, onSelectFile, onToggleFolder],
  );
  return (
    <View style={styles.tree}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Changes ({count})</Text>
      </View>
      <FlatList data={rows} keyExtractor={(row) => row.key} renderItem={renderRow} extraData={renderRow} />
    </View>
  );
}

const CommitTreeRow = memo(function CommitTreeRow({
  row,
  selected,
  display,
  theme,
  onSelectFile,
  onToggleFolder,
}: {
  row: PathRow<CommitFile>;
  selected: boolean;
  display: TreeDisplay;
  theme: PluginTheme;
  onSelectFile(path: string): void;
  onToggleFolder(key: string): void;
}) {
  const { rowPadding, fontWeight, fontSize } = display;
  const iconSize = fontSize + 1;
  const muted = theme.colors.foregroundMuted;
  const rowStyle = {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: rowPadding,
    paddingLeft: 6 + row.depth * INDENT_WIDTH,
    paddingRight: 8,
  } as const;
  const textStyle = { flexShrink: 1, fontSize, fontWeight: String(fontWeight) as TextStyle["fontWeight"] };
  if (row.kind === "folder") {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={row.name}
        accessibilityState={{ expanded: !row.collapsed }}
        onPress={() => onToggleFolder(row.key)}
        style={({ pressed }) => [rowStyle, { backgroundColor: pressed ? theme.colors.surface1 : undefined }]}
      >
        <Icon name={row.collapsed ? "ChevronRight" : "ChevronDown"} size={iconSize} color={muted} />
        <Icon name={row.collapsed ? "Folder" : "FolderOpen"} size={iconSize} color={muted} />
        <Text numberOfLines={1} style={[textStyle, { color: theme.colors.foreground }]}>
          {row.name}
        </Text>
      </Pressable>
    );
  }
  const { file } = row;
  const color = STATUS_COLORS[file.status];
  const smallSize = fontSize - 2;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${file.path}, ${STATUS_LABELS[file.status].toLowerCase()}`}
      accessibilityState={{ selected }}
      onPress={() => onSelectFile(file.path)}
      style={({ pressed }) => [
        rowStyle,
        { backgroundColor: selected ? theme.colors.surface2 : pressed ? theme.colors.surface1 : undefined },
      ]}
    >
      {/* Under a folder's chevron */}
      <View style={{ width: iconSize }} />
      <FileIcon icon={file.icon} size={iconSize} theme={theme} />
      <Text
        numberOfLines={1}
        style={[textStyle, { color, textDecorationLine: file.status === "deleted" ? "line-through" : "none" }]}
      >
        {baseName(file.path)}
      </Text>
      {file.previousPath ? (
        <Text numberOfLines={1} style={{ flexShrink: 2, color: muted, fontSize: smallSize }}>
          ←{" "}
          {parentPath(file.previousPath) === parentPath(file.path) ? baseName(file.previousPath) : file.previousPath}
        </Text>
      ) : null}
      <View style={{ flex: 1 }} />
      <LineTotals additions={file.additions} deletions={file.deletions} theme={theme} fontSize={smallSize} />
      <Text style={{ color, fontSize: smallSize, fontWeight: "600" }}>{STATUS_LETTERS[file.status]}</Text>
    </Pressable>
  );
});

interface CommitFileViewProps {
  worktree: string;
  details: CommitDetails;
  file: CommitFile;
  mode: CommitViewMode;
  /** Unique to this tab, so its split sides pair with each other only */
  pairPrefix: string;
  theme: PluginTheme;
  styles: Styles;
  onModeChange(mode: CommitViewMode): void;
}

/** The editor view of one file: the plugin's CodeMirror diff on web, a plain line diff on native */
function CommitFileView(props: CommitFileViewProps) {
  return Platform.OS === "web" ? <RichCommitFile {...props} /> : <PlainCommitFile {...props} />;
}

/** The file's name and path, its change, and its line totals, with `children` at the end */
function FileBar({ file, theme, styles, children }: { file: CommitFile; theme: PluginTheme; styles: Styles; children?: ReactNode }) {
  const color = STATUS_COLORS[file.status];
  return (
    <View style={styles.fileBar}>
      <Text numberOfLines={1} style={[styles.fileName, { color }]}>
        {baseName(file.path)}
      </Text>
      <Text numberOfLines={1} style={styles.filePath}>
        {file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}
      </Text>
      <Text style={[styles.fileStatus, { color }]}>{STATUS_LABELS[file.status]}</Text>
      <LineTotals additions={file.additions} deletions={file.deletions} theme={theme} fontSize={12} />
      {children}
    </View>
  );
}

/** Mounts one CodeMirror view of the sources; a new mode or look mounts it again */
function DiffHost({
  sources,
  filename,
  mode,
  look,
  pairKey,
}: {
  sources: { original: string | null; current: string | null };
  filename: string;
  mode: DiffViewMode;
  look: EditorLook;
  pairKey: string | null;
}) {
  const hostRef = useRef<View>(null);
  useMountedDiff(hostRef, sources, filename, mode, look, pairKey);
  return <View ref={hostRef} style={{ flex: 1, minHeight: 0, minWidth: 0 }} />;
}

function RichCommitFile({ worktree, details, file, mode, pairPrefix, theme, styles, onModeChange }: CommitFileViewProps) {
  const loadFile = useRpc(gitCommitFileRpc);
  const sources = useQuery({
    queryKey: ["better-tree", "commit-file", worktree, details.sha, file.path, file.previousPath],
    queryFn: () => loadFile({ worktree, sha: details.sha, path: file.path, previousPath: file.previousPath ?? undefined }),
    enabled: !file.binary,
    staleTime: Infinity,
  });
  const look = useMemo(() => lookFromTheme(theme), [theme]);
  const data = sources.data;
  let message: string | null = null;
  if (file.binary) message = "Binary file: there is no text to show.";
  else if (sources.isError) message = sources.error.message;
  else if (data && (data.original === null || data.current === null)) message = "This file is too large to show, or not text.";
  let notice: string | null = null;
  if (data && data.original !== null && data.original === data.current) {
    // Git counted changed lines that are equal once line endings are normalized
    const lineEndings = file.additions + file.deletions > 0;
    if (file.previousPath) {
      notice = `Renamed from ${file.previousPath}${lineEndings ? "; only its line endings changed." : " without changes."}`;
    } else {
      notice = lineEndings ? "Only the line endings changed." : "The text did not change, only the file's mode or type.";
    }
  }
  const filename = baseName(file.path);
  let view: ReactNode = null;
  if (data && !message) {
    if (mode === "split") {
      const parent = details.parents[0];
      const pairKey = `commit|${pairPrefix}|${file.path}`;
      view = (
        <View style={styles.splitRow}>
          <View style={styles.splitSide}>
            <Text numberOfLines={1} style={styles.sideLabel}>
              {parent ? `Before · ${parent.slice(0, details.shortSha.length)}` : "Before · nothing (first commit)"}
            </Text>
            <DiffHost sources={data} filename={filename} mode="original" look={look} pairKey={pairKey} />
          </View>
          <View style={styles.splitDivider} />
          <View style={styles.splitSide}>
            <Text numberOfLines={1} style={styles.sideLabel}>
              After · {details.shortSha}
            </Text>
            <DiffHost sources={data} filename={filename} mode="current" look={look} pairKey={pairKey} />
          </View>
        </View>
      );
    } else {
      // File shows the commit's text, or for a deletion the text it deleted
      const viewMode: DiffViewMode = mode === "file" ? (file.status === "deleted" ? "original" : "current") : mode;
      view = <DiffHost sources={data} filename={filename} mode={viewMode} look={look} pairKey={null} />;
    }
  }
  return (
    <View style={styles.fileView}>
      <FileBar file={file} theme={theme} styles={styles}>
        {file.binary ? null : <ModeSelector options={VIEW_MODES} value={mode} theme={theme} onChange={onModeChange} />}
      </FileBar>
      {message ? <Text style={sources.isError ? styles.error : styles.message}>{message}</Text> : null}
      {!message && sources.isPending ? <Loading /> : null}
      {notice && !message ? <Text style={styles.notice}>{notice}</Text> : null}
      {view}
    </View>
  );
}

/** Git's unified diff of the file, line by line, for native where the CodeMirror view cannot run */
function PlainCommitFile({ worktree, details, file, theme, styles }: CommitFileViewProps) {
  const loadDiff = useRpc(gitCommitFileDiffRpc);
  const diff = useQuery({
    queryKey: ["better-tree", "commit-file-diff", worktree, details.sha, file.path, file.previousPath],
    queryFn: () => loadDiff({ worktree, sha: details.sha, path: file.path, previousPath: file.previousPath ?? undefined }),
    staleTime: Infinity,
  });
  const lines = useMemo(() => parseUnifiedDiff(diff.data?.diff ?? ""), [diff.data?.diff]);
  const renderLine = useCallback(({ item }: { item: DiffLine }) => <DiffLineView line={item} theme={theme} />, [theme]);
  let body: ReactNode;
  if (diff.isPending) body = <Loading />;
  else if (diff.isError) body = <Text style={styles.error}>{diff.error.message}</Text>;
  else if (lines.length === 0) body = <Text style={styles.message}>No changes to show.</Text>;
  else {
    body = (
      <FlatList
        data={lines}
        keyExtractor={(_, index) => String(index)}
        renderItem={renderLine}
        contentContainerStyle={{ paddingVertical: 4 }}
      />
    );
  }
  return (
    <View style={styles.fileView}>
      <FileBar file={file} theme={theme} styles={styles} />
      {body}
    </View>
  );
}

function createStyles(theme: PluginTheme) {
  const muted = theme.colors.foregroundMuted;
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.colors.surface0 },
    message: { padding: 12, color: muted, fontSize: 13 },
    error: { padding: 12, color: theme.colors.statusDanger, fontSize: 13 },
    notice: { paddingHorizontal: 12, paddingVertical: 4, color: muted, fontSize: 12 },
    header: {
      gap: 4,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.border,
    },
    headerTitleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    subject: { flex: 1, minWidth: 0, color: theme.colors.foreground, fontSize: 14, fontWeight: "600" },
    headerDetail: { color: muted, fontSize: 12 },
    sha: { color: theme.colors.foreground, fontFamily: MONOSPACE },
    messageBody: { maxHeight: BODY_MAX_HEIGHT },
    bodyText: { color: theme.colors.foreground, fontSize: 12, lineHeight: 18 },
    iconButton: { padding: 4, borderRadius: 4 },
    pressed: { backgroundColor: theme.colors.surface1 },
    body: { flex: 1, minHeight: 0 },
    treePane: { flexShrink: 0, minWidth: 0, minHeight: 0 },
    editorPane: { flex: 1, minWidth: 0, minHeight: 0 },
    tree: { flex: 1, minHeight: 0 },
    sectionHeader: {
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.border,
    },
    sectionTitle: { color: muted, fontSize: 11, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.5 },
    fileView: { flex: 1, minWidth: 0, minHeight: 0 },
    // In a narrow pane the view selector wraps under the file's name
    fileBar: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      columnGap: 8,
      rowGap: 4,
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    fileName: { flexShrink: 1, maxWidth: "40%", fontSize: 13, fontWeight: "600" },
    filePath: { flex: 1, minWidth: 0, color: muted, fontSize: 12 },
    fileStatus: { fontSize: 12 },
    splitRow: { flex: 1, minHeight: 0, flexDirection: "row" },
    splitSide: { flex: 1, minWidth: 0 },
    splitDivider: { width: 1, backgroundColor: theme.colors.border },
    sideLabel: {
      paddingHorizontal: 12,
      paddingVertical: 2,
      color: muted,
      fontSize: 11,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.border,
    },
  });
}
