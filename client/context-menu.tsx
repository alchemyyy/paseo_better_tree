import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { onEscapeKey, onPressOutside } from "./web";

export interface ContextMenuItem {
  id: string;
  label: string;
  icon: string;
  /** Keyboard shortcut shown on the right, such as "Ctrl+X" */
  shortcut?: string;
  /** Shown greyed out and ignores presses */
  disabled?: boolean;
  onSelect(): void;
}

/** Menu items in groups; a line separates neighbouring groups, and empty groups are dropped */
export type ContextMenuGroups = readonly (readonly ContextMenuItem[])[];

const MENU_WIDTH = 300;
const ITEM_HEIGHT = 28;
const SEPARATOR_HEIGHT = 9;
const MENU_PADDING = 4;
const ICON_SIZE = 14;

/**
 * Anchored menu inside the panel. On web, a press anywhere outside it closes it and still reaches
 * its target, so the tree stays usable, and Escape closes it; elsewhere a backdrop closes it.
 */
export function ContextMenu({
  groups,
  x,
  y,
  bounds,
  theme,
  onClose,
}: {
  groups: ContextMenuGroups;
  x: number;
  y: number;
  bounds: { width: number; height: number };
  theme: PluginTheme;
  /** `outside`: a press elsewhere, whose target keeps the focus */
  onClose(reason: "outside" | "escape" | "select"): void;
}) {
  const styles = useMemo(
    () => ({
      menu: {
        position: "absolute" as const,
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
      content: { paddingVertical: MENU_PADDING },
      item: {
        height: ITEM_HEIGHT,
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingHorizontal: 10,
      },
      itemHighlighted: { backgroundColor: theme.colors.surface2 },
      label: { flex: 1, color: theme.colors.foreground, fontSize: 13 },
      disabledLabel: { color: theme.colors.foregroundMuted, opacity: 0.6 },
      shortcut: { color: theme.colors.foregroundMuted, fontSize: 12 },
      separator: {
        height: StyleSheet.hairlineWidth,
        marginVertical: (SEPARATOR_HEIGHT - StyleSheet.hairlineWidth) / 2,
        marginHorizontal: 8,
        backgroundColor: theme.colors.border,
      },
    }),
    [theme],
  );
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const menuRef = useRef<View>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const stopOutside = onPressOutside(menuRef.current, () => onCloseRef.current("outside"));
    const stopEscape = onEscapeKey(() => onCloseRef.current("escape"));
    return () => {
      stopOutside();
      stopEscape();
    };
  }, []);
  const visibleGroups = groups.filter((group) => group.length > 0);
  const itemCount = visibleGroups.reduce((count, group) => count + group.length, 0);
  const contentHeight =
    itemCount * ITEM_HEIGHT + Math.max(0, visibleGroups.length - 1) * SEPARATOR_HEIGHT + MENU_PADDING * 2;
  // Taller than the panel: pin to the top and scroll
  const menuHeight = Math.min(contentHeight, bounds.height);
  // Wider than the panel: as wide as the panel, since its pane cuts off anything past the edge
  const menuWidth = Math.min(MENU_WIDTH, bounds.width);
  const left = Math.max(0, Math.min(x, bounds.width - menuWidth));
  const top = Math.max(0, Math.min(y, bounds.height - menuHeight));
  return (
    <>
      {Platform.OS === "web" ? null : (
        <Pressable
          style={StyleSheet.absoluteFill}
          accessibilityLabel="Close menu"
          onPress={() => onClose("outside")}
        />
      )}
      <View
        ref={menuRef}
        style={[styles.menu, { left, top, width: menuWidth, height: menuHeight }]}
        accessibilityRole="menu"
      >
        <ScrollView contentContainerStyle={styles.content} scrollEnabled={contentHeight > menuHeight}>
          {visibleGroups.map((group, index) => (
            <View key={group[0]!.id}>
              {index > 0 ? <View style={styles.separator} /> : null}
              {group.map((item) => (
                <Pressable
                  key={item.id}
                  accessibilityRole="menuitem"
                  accessibilityState={{ disabled: item.disabled === true }}
                  disabled={item.disabled}
                  style={({ pressed }) => [
                    styles.item,
                    !item.disabled && (pressed || item.id === hoveredId) ? styles.itemHighlighted : null,
                  ]}
                  onHoverIn={() => setHoveredId(item.id)}
                  onHoverOut={() => setHoveredId((current) => (current === item.id ? null : current))}
                  onPress={() => {
                    onClose("select");
                    item.onSelect();
                  }}
                >
                  <Icon
                    name={item.icon}
                    size={ICON_SIZE}
                    color={theme.colors.foregroundMuted}
                  />
                  <Text style={[styles.label, item.disabled ? styles.disabledLabel : null]} numberOfLines={1}>
                    {item.label}
                  </Text>
                  {item.shortcut ? <Text style={styles.shortcut}>{item.shortcut}</Text> : null}
                </Pressable>
              ))}
            </View>
          ))}
        </ScrollView>
      </View>
    </>
  );
}
