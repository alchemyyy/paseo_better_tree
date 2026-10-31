import type { PluginTheme } from "@getpaseo/plugin";
import { type PluginWorkspacePanelProps, useRpc, useTabState } from "@getpaseo/plugin/client";
import { FlatList, Loading } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { z } from "zod";
import { diffSourcesRpc } from "../shared/diff-contracts";
import { gitDiffRpc } from "../shared/git-contracts";
import { codemirror } from "./codemirror";
import { DIFF_CONFIG, type DiffViewHandle, type EditorLook, mountDiffView } from "./diff-editor";
import { DiffTabStateSchema } from "./diff-tabs";
import { closeOriginalSide, openOriginalSide } from "./split-panes";
import { joinSplit } from "./split-sync";
import { joinPath } from "./tree-model";
import { ADDITION_BACKGROUND, DELETION_BACKGROUND, HUNK_BACKGROUND } from "./git-colors";
import { type DiffLine, parseUnifiedDiff } from "./git-model";

const REFRESH_INTERVAL_MS = 4000;
const FONT_SIZE = 12;
const LINE_HEIGHT = 18;
const NUMBER_WIDTH = 44;
const MONOSPACE = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });
const NullableDiffStateSchema = DiffTabStateSchema.nullable();

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

const OriginalSideSchema = z.object({
  side: z.literal("original"),
  path: z.string(),
  pairKey: z.string(),
  openedAt: z.number(),
});
const DiffPanelStateSchema = z.union([OriginalSideSchema, DiffTabStateSchema]).nullable();
type RichMode = "unified" | "changes" | "split";
const RICH_MODES: readonly { mode: RichMode; label: string }[] = [
  { mode: "unified", label: "Unified" },
  { mode: "changes", label: "Changes only" },
  { mode: "split", label: "Split" },
];
const DIFF_FONT = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

function hexLuminance(color: string): number {
  const hex = color.replace("#", "");
  if (!/^[0-9a-f]{6}/i.test(hex)) return 0;
  const [red, green, blue] = [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
  return (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
}

function lookFromTheme(theme: PluginTheme): EditorLook {
  return {
    dark: hexLuminance(theme.colors.foreground) > hexLuminance(theme.colors.surface0),
    background: theme.colors.surface0,
    foreground: theme.colors.foreground,
    mutedForeground: theme.colors.foregroundMuted,
    gutterBackground: theme.colors.surface0,
    fontFamily: DIFF_FONT,
    fontSize: "12.5px",
    lineHeight: "1.55",
  };
}

/**
 * A file's diff against HEAD. A Git-panel tab shows unified, changes-only, or the current side of
 * a split (whose original side opens in a pane to its right); a split's original side is a tab too.
 */
export function DiffPanel(props: PluginWorkspacePanelProps) {
  const [state] = useTabState(props.tab, DiffPanelStateSchema, null);
  if (Platform.OS !== "web") return <LegacyDiffPanel {...props} />;
  if (state && "side" in state) return <OriginalSidePanel {...props} path={state.path} pairKey={state.pairKey} />;
  return <RichDiffPanel {...props} />;
}

function useDiffSources(absolutePath: string | null) {
  const loadSources = useRpc(diffSourcesRpc);
  return useQuery({
    queryKey: ["better-tree", "diff-sources", absolutePath],
    queryFn: () => loadSources({ path: absolutePath! }),
    enabled: absolutePath !== null,
    refetchInterval: REFRESH_INTERVAL_MS,
  });
}

/** Mounts the plugin's diff view into a View and keeps its sources current */
function useMountedDiff(
  hostRef: React.RefObject<View | null>,
  sources: { original: string | null; current: string | null; absolutePath: string } | undefined,
  mode: "unified" | "changes" | "original" | "current",
  look: EditorLook,
  pairKey: string | null,
) {
  const handleRef = useRef<DiffViewHandle | null>(null);
  const sourcesRef = useRef({ original: "", current: "" });
  const ready = sources !== undefined && sources.original !== null && sources.current !== null;
  const filename = sources ? basename(sources.absolutePath) : "";
  useEffect(() => {
    if (!ready || !sources || sources.original === null || sources.current === null) return;
    sourcesRef.current = { original: sources.original, current: sources.current };
    const handle = mountDiffView(hostRef.current, {
      original: sources.original,
      current: sources.current,
      filename,
      mode,
      look,
    });
    handleRef.current = handle;
    const side = mode === "original" || mode === "current" ? mode : null;
    const leave = handle && pairKey && side ? joinSplit(pairKey, side, handle, () => sourcesRef.current) : null;
    return () => {
      leave?.();
      handle?.destroy();
      handleRef.current = null;
    };
    // Sources stream in through setSources below; only a new view needs a remount
  }, [ready, filename, mode, look, pairKey]);
  useEffect(() => {
    if (!sources || sources.original === null || sources.current === null) return;
    sourcesRef.current = { original: sources.original, current: sources.current };
    handleRef.current?.setSources(sources.original, sources.current);
  }, [sources?.original, sources?.current]);
}

function sourcesMessage(
  query: { isPending: boolean; isError: boolean; error: Error | null; data?: { original: string | null; current: string | null } },
): string | null {
  if (query.isPending) return null;
  if (query.isError) return query.error?.message ?? "Could not load the file";
  if (query.data?.current === null) return "This file cannot be shown as a diff (binary, deleted, or too large).";
  if (query.data?.original === null) return "This file is not in a Git repository, so there is nothing to compare.";
  return null;
}

function RichDiffPanel({ theme, tab }: PluginWorkspacePanelProps) {
  const [spec, setSpec] = useTabState(tab, NullableDiffStateSchema, null);
  const absolutePath = spec ? (spec.worktree ? joinPath(spec.worktree, spec.path) : spec.path) : null;
  const mode: RichMode = spec?.mode ?? "unified";
  const query = useDiffSources(absolutePath);
  const look = useMemo(() => lookFromTheme(theme), [theme]);
  const hostRef = useRef<View>(null);
  const pairKey = absolutePath ? `diff|${absolutePath}` : null;
  useMountedDiff(hostRef, query.data, mode === "split" ? "current" : mode, look, mode === "split" ? pairKey : null);

  // Split opens the original side in a pane to the right; leaving split closes it
  useEffect(() => {
    if (mode !== "split" || !pairKey || !absolutePath || !query.data) return;
    openOriginalSide(hostRef.current, pairKey, absolutePath);
    return () => closeOriginalSide(hostRef.current, pairKey);
  }, [mode, pairKey, absolutePath, query.data !== undefined]);

  const totals = useMemo(() => {
    const original = query.data?.original;
    const current = query.data?.current;
    if (original == null || current == null) return null;
    return countChangedLines(original, current);
  }, [query.data?.original, query.data?.current]);

  const muted = theme.colors.foregroundMuted;
  const message = !spec ? "Pick a file in the Git panel." : sourcesMessage(query);
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      {spec ? (
        <View style={[headerStyle(theme), { gap: 8 }]}>
          <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontWeight: "600" }}>
            {basename(spec.path)}
          </Text>
          <Text numberOfLines={1} style={{ flex: 1, color: muted, fontSize: 12 }}>
            {spec.path}
            {spec.worktree ? ` · ${basename(spec.worktree)}` : ""}
          </Text>
          {totals ? (
            <>
              <Text style={{ color: theme.colors.statusSuccess, fontSize: 12 }}>+{totals.additions}</Text>
              <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>−{totals.deletions}</Text>
            </>
          ) : null}
          <View style={{ flexDirection: "row", borderRadius: 6, borderWidth: 1, borderColor: theme.colors.border, overflow: "hidden" }}>
            {RICH_MODES.map((option) => {
              const selected = option.mode === mode;
              return (
                <Pressable
                  key={option.mode}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  onPress={() => spec && setSpec({ ...spec, mode: option.mode })}
                  style={{
                    paddingHorizontal: 8,
                    paddingVertical: 2,
                    backgroundColor: selected ? theme.colors.surface2 : "transparent",
                  }}
                >
                  <Text style={{ fontSize: 11, color: selected ? theme.colors.foreground : muted }}>{option.label}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}
      {message ? (
        <Text style={{ padding: 12, color: query.isError ? theme.colors.statusDanger : muted }}>{message}</Text>
      ) : query.isPending && spec ? (
        <Loading />
      ) : null}
      <View ref={hostRef} style={{ flex: 1, minHeight: 0, display: message || query.isPending ? "none" : "flex" }} />
    </View>
  );
}

function OriginalSidePanel({ theme, path, pairKey }: PluginWorkspacePanelProps & { path: string; pairKey: string }) {
  const query = useDiffSources(path);
  const look = useMemo(() => lookFromTheme(theme), [theme]);
  const hostRef = useRef<View>(null);
  useMountedDiff(hostRef, query.data, "original", look, pairKey);
  const message = sourcesMessage(query);
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <View style={[headerStyle(theme), { gap: 8 }]}>
        <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontWeight: "600" }}>
          {basename(path)}
        </Text>
        <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.foregroundMuted, fontSize: 12 }}>
          HEAD (original)
        </Text>
      </View>
      {message ? <Text style={{ padding: 12, color: theme.colors.foregroundMuted }}>{message}</Text> : null}
      {query.isPending ? <Loading /> : null}
      <View ref={hostRef} style={{ flex: 1, minHeight: 0, display: message || query.isPending ? "none" : "flex" }} />
    </View>
  );
}

function headerStyle(theme: PluginTheme) {
  return {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  };
}

/** Line additions and deletions between two texts, from the same chunks the view draws */
function countChangedLines(original: string, current: string): { additions: number; deletions: number } {
  const { Text: CodeText } = codemirror().state;
  const { Chunk } = codemirror().merge;
  const a = CodeText.of(original.split("\n"));
  const b = CodeText.of(current.split("\n"));
  let additions = 0;
  let deletions = 0;
  for (const chunk of Chunk.build(a, b, DIFF_CONFIG)) {
    if (chunk.toB > chunk.fromB) additions += b.lineAt(chunk.endB).number - b.lineAt(chunk.fromB).number + 1;
    if (chunk.toA > chunk.fromA) deletions += a.lineAt(chunk.endA).number - a.lineAt(chunk.fromA).number + 1;
  }
  return { additions, deletions };
}

/** Line-by-line unified diff for native, where the CodeMirror view cannot run */
function LegacyDiffPanel({ theme, tab }: PluginWorkspacePanelProps) {
  const [spec] = useTabState(tab, NullableDiffStateSchema, null);
  const loadDiff = useRpc(gitDiffRpc);
  const diff = useQuery({
    queryKey: ["better-tree", "git", "diff", spec?.worktree, spec?.path],
    queryFn: () => loadDiff({ worktree: spec!.worktree, path: spec!.path }),
    enabled: spec !== null,
    refetchInterval: REFRESH_INTERVAL_MS,
  });
  const lines = useMemo(() => parseUnifiedDiff(diff.data?.diff ?? ""), [diff.data?.diff]);
  const totals = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const line of lines) {
      if (line.kind === "add") additions++;
      else if (line.kind === "delete") deletions++;
    }
    return { additions, deletions };
  }, [lines]);
  const renderLine = useCallback(
    ({ item }: { item: DiffLine }) => <DiffLineView line={item} theme={theme} />,
    [theme],
  );

  const muted = theme.colors.foregroundMuted;
  let body;
  if (!spec) {
    body = <Text style={{ padding: 12, color: muted }}>Pick a file in the Git panel.</Text>;
  } else if (diff.isPending) {
    body = <Loading />;
  } else if (diff.isError) {
    body = <Text style={{ padding: 12, color: theme.colors.statusDanger }}>{diff.error.message}</Text>;
  } else if (lines.length === 0) {
    body = <Text style={{ padding: 12, color: muted }}>No changes.</Text>;
  } else {
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
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      {spec ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            paddingHorizontal: 12,
            paddingVertical: 8,
            borderBottomWidth: 1,
            borderBottomColor: theme.colors.border,
          }}
        >
          <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontWeight: "600" }}>
            {basename(spec.path)}
          </Text>
          <Text numberOfLines={1} style={{ flex: 1, color: muted, fontSize: 12 }}>
            {spec.path} · {basename(spec.worktree)}
          </Text>
          <Text style={{ color: theme.colors.statusSuccess, fontSize: 12 }}>+{totals.additions}</Text>
          <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>−{totals.deletions}</Text>
        </View>
      ) : null}
      {body}
    </View>
  );
}

const DiffLineView = memo(function DiffLineView({ line, theme }: { line: DiffLine; theme: PluginTheme }) {
  let backgroundColor: string | undefined;
  let color = theme.colors.foreground;
  let marker = " ";
  switch (line.kind) {
    case "add":
      backgroundColor = ADDITION_BACKGROUND;
      marker = "+";
      break;
    case "delete":
      backgroundColor = DELETION_BACKGROUND;
      marker = "-";
      break;
    case "hunk":
      backgroundColor = HUNK_BACKGROUND;
      color = theme.colors.foregroundMuted;
      break;
    case "meta":
      color = theme.colors.foregroundMuted;
      break;
    case "context":
      break;
  }
  const numberStyle = {
    width: NUMBER_WIDTH,
    paddingRight: 6,
    textAlign: "right" as const,
    color: theme.colors.foregroundMuted,
    fontFamily: MONOSPACE,
    fontSize: FONT_SIZE,
    lineHeight: LINE_HEIGHT,
  };
  const showNumbers = line.kind !== "meta" && line.kind !== "hunk";
  return (
    <View style={{ flexDirection: "row", backgroundColor }}>
      {showNumbers ? (
        <>
          <Text style={numberStyle}>{line.oldNumber ?? ""}</Text>
          <Text style={numberStyle}>{line.newNumber ?? ""}</Text>
        </>
      ) : null}
      <Text
        selectable
        style={{
          flex: 1,
          paddingLeft: showNumbers ? 4 : 12,
          paddingRight: 12,
          color,
          fontFamily: MONOSPACE,
          fontSize: FONT_SIZE,
          lineHeight: LINE_HEIGHT,
        }}
      >
        {showNumbers ? `${marker} ${line.text}` : line.text}
      </Text>
    </View>
  );
});
