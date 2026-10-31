import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Modal, TextInput } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import {
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  type TextInputKeyPressEventData,
  View,
} from "react-native";
import type { Commit, CommitMode, GitFile, RemoteAction } from "../shared/git-contracts";
import { canCommit, defaultCommitMode } from "./git-model";
import { RemoteButton } from "./remote-actions";
import { MenuItem, menuStyle, SplitButton } from "./split-button";

const ICON_SIZE = 14;
const COMPACT_ICON_SIZE = 12;
const FONT_SIZE = 13;
const SMALL_FONT_SIZE = 11;
const MONOSPACE = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

const COMMIT_MODE_LABELS: Record<CommitMode, string> = {
  staged: "Commit",
  tracked: "Commit Tracked",
  amend: "Amend",
};

interface KeyboardModifiers {
  ctrlKey?: boolean;
  metaKey?: boolean;
}

/** Zed-style commit editor: branch and remote actions, message, commit split button */
export function CommitSection({
  branch,
  files,
  lastCommit,
  message,
  mode,
  busy,
  remoteAction,
  expanded,
  theme,
  onMessageChange,
  onModeChange,
  onCommit,
  onRemote,
  onOpenRemoteMenu,
  onToggleExpanded,
}: {
  /** Branch of the selected worktree, or null when HEAD is detached */
  branch: string | null;
  files: readonly GitFile[];
  /** HEAD, for labeling a detached worktree */
  lastCommit: Commit | null;
  message: string;
  /** The user's chosen mode, or null to follow the staged files */
  mode: CommitMode | null;
  /** Which git operation is running, if any */
  busy: "commit" | "uncommit" | RemoteAction | null;
  /** The remote action last chosen in this panel */
  remoteAction: RemoteAction;
  expanded: boolean;
  theme: PluginTheme;
  onMessageChange(message: string): void;
  onModeChange(mode: CommitMode): void;
  onCommit(mode: CommitMode): void;
  onRemote(action: RemoteAction): void;
  onOpenRemoteMenu(anchor: View | null): void;
  onToggleExpanded(): void;
}) {
  const [commitMenuOpen, setCommitMenuOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const activeMode = mode ?? defaultCommitMode(files);
  const commitEnabled = busy === null && canCommit(activeMode, files, message);
  const muted = theme.colors.foregroundMuted;

  // Ctrl+Enter (Cmd+Enter on macOS) commits from the message editor on web
  const handleKeyPress = (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
    const modifiers = event.nativeEvent as TextInputKeyPressEventData & KeyboardModifiers;
    if (event.nativeEvent.key !== "Enter" || !(modifiers.ctrlKey || modifiers.metaKey)) return;
    event.preventDefault();
    if (commitEnabled) onCommit(activeMode);
  };

  const editorStyle = {
    color: theme.colors.foreground,
    fontFamily: MONOSPACE,
    fontSize: FONT_SIZE,
  };

  return (
    <View style={styles.section}>
      <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
        <Icon name="GitBranch" size={COMPACT_ICON_SIZE} color={muted} />
        <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.foreground, fontSize: SMALL_FONT_SIZE }}>
          {branch ?? `detached ${lastCommit?.shortSha ?? ""}`}
        </Text>
        <RemoteButton
          action={remoteAction}
          busy={busy === remoteAction}
          theme={theme}
          onRun={onRemote}
          onOpenMenu={onOpenRemoteMenu}
        />
      </View>

      <View style={styles.editorWrap}>
        <TextInput
          multiline
          value={message}
          onChangeText={onMessageChange}
          onKeyPress={handleKeyPress}
          placeholder="Enter commit message"
          placeholderTextColor={muted}
          accessibilityLabel="Commit message"
          textAlignVertical="top"
          style={[styles.editor, editorStyle]}
        />
        <View style={styles.editorIcons}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Edit the commit message in a dialog"
            hitSlop={6}
            onPress={() => setFullscreen(true)}
          >
            <Icon name="Scan" size={ICON_SIZE} color={muted} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={expanded ? "Restore the Git panel sections" : "Fill the Git panel with the commit editor"}
            hitSlop={6}
            onPress={onToggleExpanded}
          >
            <Icon name={expanded ? "Minimize2" : "Maximize2"} size={ICON_SIZE} color={muted} />
          </Pressable>
        </View>
      </View>

      <View style={styles.actions}>
        <View style={{ flex: 1 }} />
        <SplitButton
          label={COMMIT_MODE_LABELS[activeMode]}
          disabled={!commitEnabled}
          busy={busy === "commit"}
          theme={theme}
          onPress={() => onCommit(activeMode)}
          onOpenMenu={() => setCommitMenuOpen((open) => !open)}
        />
      </View>

      {commitMenuOpen ? (
        <>
          <Pressable
            style={StyleSheet.absoluteFill}
            accessibilityLabel="Close menu"
            onPress={() => setCommitMenuOpen(false)}
          />
          <View style={[menuStyle(theme), styles.menuAboveActions]} accessibilityRole="menu">
            {(Object.keys(COMMIT_MODE_LABELS) as CommitMode[]).map((option) => (
              <MenuItem
                key={option}
                label={COMMIT_MODE_LABELS[option]}
                selected={option === activeMode}
                theme={theme}
                onPress={() => {
                  setCommitMenuOpen(false);
                  onModeChange(option);
                }}
              />
            ))}
          </View>
        </>
      ) : null}

      <Modal title="Commit message" open={fullscreen} onOpenChange={setFullscreen}>
        <Modal.Content scrollable={false} style={{ minHeight: 320 }}>
          <TextInput
            multiline
            autoFocus
            value={message}
            onChangeText={onMessageChange}
            onKeyPress={handleKeyPress}
            placeholder="Enter commit message"
            placeholderTextColor={muted}
            accessibilityLabel="Commit message"
            textAlignVertical="top"
            style={[styles.editor, editorStyle, { minHeight: 260 }]}
          />
          <Text style={{ color: muted, fontSize: SMALL_FONT_SIZE }}>
            {COMMIT_MODE_LABELS[activeMode]} with Ctrl+Enter
          </Text>
        </Modal.Content>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { flex: 1, minHeight: 0 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  editorWrap: { flex: 1, minHeight: 0 },
  editor: { flex: 1, paddingHorizontal: 10, paddingTop: 8, paddingRight: 34 },
  editorIcons: { position: "absolute", top: 8, right: 10, gap: 10 },
  actions: { flexDirection: "row", alignItems: "center", paddingHorizontal: 10, paddingVertical: 6 },
  menuAboveActions: { right: 10, bottom: 40 },
});
