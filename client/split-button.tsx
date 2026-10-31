import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useRef } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

const ICON_SIZE = 14;
const COMPACT_ICON_SIZE = 12;
const FONT_SIZE = 13;
const SMALL_FONT_SIZE = 11;

/** A button with a chevron beside it for the alternatives */
export function SplitButton({
  label,
  icon,
  disabled,
  busy,
  compact,
  theme,
  onPress,
  onOpenMenu,
}: {
  label: string;
  icon?: string;
  disabled: boolean;
  busy: boolean;
  /** Slimmer variant for header bars */
  compact?: boolean;
  theme: PluginTheme;
  onPress(): void;
  /** `anchor`: the whole button, for placing the menu */
  onOpenMenu(anchor: View | null): void;
}) {
  const anchorRef = useRef<View>(null);
  const border = { borderColor: theme.colors.border, backgroundColor: theme.colors.surface2 };
  const iconSize = compact ? COMPACT_ICON_SIZE : ICON_SIZE;
  return (
    <View ref={anchorRef} style={[styles.splitButton, border, { opacity: disabled || busy ? 0.5 : 1 }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: disabled || busy }}
        disabled={disabled || busy}
        onPress={onPress}
        style={[styles.splitMain, compact ? styles.splitMainCompact : null]}
      >
        {icon ? <Icon name={icon} size={iconSize} color={theme.colors.foreground} /> : null}
        <Text style={{ color: theme.colors.foreground, fontSize: compact ? SMALL_FONT_SIZE : FONT_SIZE }}>
          {busy ? `${label}…` : label}
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`More ${label.toLowerCase()} options`}
        disabled={busy}
        onPress={() => onOpenMenu(anchorRef.current)}
        style={[styles.splitChevron, { borderLeftColor: theme.colors.border }]}
      >
        <Icon name="ChevronDown" size={12} color={theme.colors.foregroundMuted} />
      </Pressable>
    </View>
  );
}

export function MenuItem({
  label,
  icon,
  selected,
  theme,
  onPress,
}: {
  label: string;
  icon?: string;
  selected?: boolean;
  theme: PluginTheme;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityRole="menuitem"
      onPress={onPress}
      style={({ pressed }) => [styles.menuItem, pressed ? { backgroundColor: theme.colors.surface2 } : null]}
    >
      <View style={{ width: ICON_SIZE }}>
        {icon ? <Icon name={icon} size={ICON_SIZE} color={theme.colors.foregroundMuted} /> : null}
      </View>
      <Text style={{ flex: 1, color: theme.colors.foreground, fontSize: FONT_SIZE }}>{label}</Text>
      {selected ? <Icon name="Check" size={ICON_SIZE} color={theme.colors.accent} /> : null}
    </Pressable>
  );
}

/** A split button's dropdown; callers position it */
export function menuStyle(theme: PluginTheme) {
  return [styles.menu, { borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 }];
}

const styles = StyleSheet.create({
  splitButton: { flexDirection: "row", alignItems: "stretch", borderWidth: 1, borderRadius: 6, overflow: "hidden" },
  splitMain: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 4 },
  splitMainCompact: { gap: 4, paddingHorizontal: 6, paddingVertical: 3.5 },
  splitChevron: { justifyContent: "center", paddingHorizontal: 6, borderLeftWidth: 1 },
  menu: {
    position: "absolute",
    minWidth: 170,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  menuItem: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 6 },
});
