// Shared by the Diff and Commit panels: the editor look taken from the plugin theme, the hook that
// mounts the plugin's CodeMirror diff view, the view selector, and native's plain diff line.
import type { PluginTheme } from "@getpaseo/plugin";
import { memo, type RefObject, useEffect, useRef } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { type DiffViewHandle, type DiffViewMode, type EditorLook, mountDiffView } from "./diff-editor";
import { ADDITION_BACKGROUND, DELETION_BACKGROUND, HUNK_BACKGROUND } from "./git-colors";
import type { DiffLine } from "./git-model";
import { joinSplit } from "./split-sync";

const DIFF_FONT = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const FONT_SIZE = 12;
const LINE_HEIGHT = 18;
const NUMBER_WIDTH = 44;
export const MONOSPACE = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

function hexLuminance(color: string): number {
  const hex = color.replace("#", "");
  if (!/^[0-9a-f]{6}/i.test(hex)) return 0;
  const [red, green, blue] = [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
  return (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
}

export function lookFromTheme(theme: PluginTheme): EditorLook {
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
 * Mounts the plugin's diff view into a View and keeps its sources current. Null texts mount
 * nothing; a split side (`original` or `current` with a `pairKey`) scrolls with its partner.
 */
export function useMountedDiff(
  hostRef: RefObject<View | null>,
  sources: { original: string | null; current: string | null } | undefined,
  filename: string,
  mode: DiffViewMode,
  look: EditorLook,
  pairKey: string | null,
) {
  const handleRef = useRef<DiffViewHandle | null>(null);
  const sourcesRef = useRef({ original: "", current: "" });
  const ready = sources !== undefined && sources.original !== null && sources.current !== null;
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

/** A row of buttons choosing one of `options` */
export function ModeSelector<Mode extends string>({
  options,
  value,
  theme,
  onChange,
}: {
  options: readonly { mode: Mode; label: string }[];
  value: Mode;
  theme: PluginTheme;
  onChange(mode: Mode): void;
}) {
  return (
    <View style={{ flexDirection: "row", borderRadius: 6, borderWidth: 1, borderColor: theme.colors.border, overflow: "hidden" }}>
      {options.map((option) => {
        const selected = option.mode === value;
        return (
          <Pressable
            key={option.mode}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            onPress={() => onChange(option.mode)}
            style={{
              paddingHorizontal: 8,
              paddingVertical: 2,
              backgroundColor: selected ? theme.colors.surface2 : "transparent",
            }}
          >
            <Text style={{ fontSize: 11, color: selected ? theme.colors.foreground : theme.colors.foregroundMuted }}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** One line of a plain unified diff, for native where the CodeMirror view cannot run */
export const DiffLineView = memo(function DiffLineView({ line, theme }: { line: DiffLine; theme: PluginTheme }) {
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
