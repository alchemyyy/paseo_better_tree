import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/ui";
import { type Ref, useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";

const ICON_SIZE = 13;
const FONT_SIZE = 12;
const STATUS_FONT_SIZE = 11;
const SPINNER_SIZE = 12;

/**
 * The file tree's filter field, docked at the bottom of its pane. Escape clears it, then gives
 * the keyboard back to the tree; Enter acts on the first match.
 */
export function FilterBar({
  inputRef,
  value,
  placeholder,
  searching,
  status,
  theme,
  onChange,
  onSubmit,
  onEscape,
}: {
  inputRef: Ref<TextInput>;
  value: string;
  placeholder: string;
  /** Results for the typed text are on their way */
  searching: boolean;
  /** Match count, once there are results */
  status: string | null;
  theme: PluginTheme;
  onChange(text: string): void;
  onSubmit(): void;
  onEscape(): void;
}) {
  const [focused, setFocused] = useState(false);
  const muted = theme.colors.foregroundMuted;
  return (
    <View
      style={{
        paddingHorizontal: 6,
        paddingVertical: 5,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          paddingHorizontal: 6,
          borderRadius: 4,
          borderWidth: 1,
          borderColor: focused ? theme.colors.accent : theme.colors.border,
          backgroundColor: theme.colors.surface1,
        }}
      >
        <Icon name="Search" size={ICON_SIZE} color={muted} />
        <TextInput
          ref={inputRef}
          value={value}
          onChangeText={onChange}
          onSubmitEditing={onSubmit}
          onKeyPress={(event) => {
            if (event.nativeEvent.key === "Escape") onEscape();
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          blurOnSubmit={false}
          placeholder={placeholder}
          placeholderTextColor={muted}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          accessibilityLabel="Filter files and folders"
          style={{
            flex: 1,
            minWidth: 0,
            paddingVertical: 4,
            color: theme.colors.foreground,
            fontSize: FONT_SIZE,
            // The field's border shows focus instead of the browser outline
            outlineWidth: 0,
          }}
        />
        {searching ? <ActivityIndicator size={SPINNER_SIZE} color={muted} /> : null}
        {status ? (
          <Text numberOfLines={1} style={{ color: muted, fontSize: STATUS_FONT_SIZE }}>
            {status}
          </Text>
        ) : null}
        {value ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Clear the filter"
            hitSlop={6}
            onPress={() => onChange("")}
          >
            <Icon name="X" size={ICON_SIZE} color={muted} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
