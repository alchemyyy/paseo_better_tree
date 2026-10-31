import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/ui";
import { Pressable, View } from "react-native";

const BOX_SIZE = 14;
// The check mark's share of the box
const CHECK_RATIO = 11 / 14;

export function Checkbox({
  checked,
  mixed,
  size = BOX_SIZE,
  color,
  theme,
  disabled,
  accessibilityLabel,
  onChange,
}: {
  checked: boolean;
  /** Some but not all of what it controls is on; shows a dash */
  mixed?: boolean;
  /** Box edge in points */
  size?: number;
  /** Fill and border color; defaults to the theme accent */
  color?: string;
  theme: PluginTheme;
  disabled?: boolean;
  accessibilityLabel: string;
  onChange(checked: boolean): void;
}) {
  const tint = color ?? theme.colors.accent;
  const filled = checked || mixed;
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ checked: mixed && !checked ? "mixed" : checked, disabled }}
      disabled={disabled}
      hitSlop={6}
      onPress={() => onChange(!checked)}
      style={{ opacity: disabled ? 0.5 : 1 }}
    >
      <View
        style={{
          width: size,
          height: size,
          borderRadius: 3,
          borderWidth: 1,
          borderColor: filled ? tint : theme.colors.foregroundMuted,
          backgroundColor: filled ? tint : "transparent",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {filled ? <Icon name={checked ? "Check" : "Minus"} size={Math.round(size * CHECK_RATIO)} color={theme.colors.surface0} /> : null}
      </View>
    </Pressable>
  );
}
