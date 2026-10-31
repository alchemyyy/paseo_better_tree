import type { PluginTheme } from "@getpaseo/plugin";
import { Pressable, StyleSheet, View } from "react-native";
import type { RemoteAction } from "../shared/git-contracts";
import { MenuItem, menuStyle, SplitButton } from "./split-button";

const REMOTE_ACTIONS: readonly { action: RemoteAction; label: string; icon: string }[] = [
  { action: "fetch", label: "Fetch", icon: "RefreshCw" },
  { action: "pull", label: "Pull", icon: "ArrowDownToLine" },
  { action: "push", label: "Push", icon: "ArrowUpFromLine" },
];
const MENU_GAP = 4;

/** Runs the last chosen remote action; its chevron offers the others */
export function RemoteButton({
  action,
  busy,
  theme,
  onRun,
  onOpenMenu,
}: {
  action: RemoteAction;
  /** That action is running */
  busy: boolean;
  theme: PluginTheme;
  onRun(action: RemoteAction): void;
  onOpenMenu(anchor: View | null): void;
}) {
  const option = REMOTE_ACTIONS.find((candidate) => candidate.action === action) ?? REMOTE_ACTIONS[0];
  return (
    <SplitButton
      label={option.label}
      icon={option.icon}
      disabled={false}
      busy={busy}
      compact
      theme={theme}
      onPress={() => onRun(option.action)}
      onOpenMenu={onOpenMenu}
    />
  );
}

/** Panel-relative position of the menu's right edge and its top or bottom edge */
export interface RemoteMenuPlacement {
  right: number;
  top?: number;
  bottom?: number;
}

/**
 * Places the menu under the button, or above it when the button sits in the lower half of `root`,
 * right edges aligned
 */
export function placeRemoteMenu(root: View, anchor: View, onPlaced: (placement: RemoteMenuPlacement) => void): void {
  root.measureInWindow((rootX, rootY, rootWidth, rootHeight) => {
    anchor.measureInWindow((x, y, width, height) => {
      const right = rootX + rootWidth - (x + width);
      const top = y - rootY;
      if (top + height / 2 > rootHeight / 2) onPlaced({ right, bottom: rootHeight - top + MENU_GAP });
      else onPlaced({ right, top: top + height + MENU_GAP });
    });
  });
}

/** Fetch, pull, and push over the whole panel, so a short section cannot clip them */
export function RemoteMenu({
  placement,
  theme,
  onSelect,
  onClose,
}: {
  placement: RemoteMenuPlacement;
  theme: PluginTheme;
  onSelect(action: RemoteAction): void;
  onClose(): void;
}) {
  return (
    <>
      <Pressable style={StyleSheet.absoluteFill} accessibilityLabel="Close menu" onPress={onClose} />
      <View style={[menuStyle(theme), placement]} accessibilityRole="menu">
        {REMOTE_ACTIONS.map((option) => (
          <MenuItem
            key={option.action}
            label={option.label}
            icon={option.icon}
            theme={theme}
            onPress={() => {
              onClose();
              onSelect(option.action);
            }}
          />
        ))}
      </View>
    </>
  );
}
