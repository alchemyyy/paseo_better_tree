import type { PluginTheme } from "@getpaseo/plugin";
import { Text } from "react-native";

const DEFAULT_FONT_SIZE = 11;

/** "+3 −1" in the status colors, on one line; nothing when both are zero */
export function LineTotals({
  additions,
  deletions,
  theme,
  fontSize = DEFAULT_FONT_SIZE,
}: {
  additions: number;
  deletions: number;
  theme: PluginTheme;
  fontSize?: number;
}) {
  if (additions === 0 && deletions === 0) return null;
  return (
    <Text style={{ flexShrink: 0, fontSize }}>
      <Text style={{ color: theme.colors.statusSuccess }}>+{additions}</Text>
      <Text style={{ color: theme.colors.foregroundMuted }}> </Text>
      <Text style={{ color: theme.colors.statusDanger }}>−{deletions}</Text>
    </Text>
  );
}
