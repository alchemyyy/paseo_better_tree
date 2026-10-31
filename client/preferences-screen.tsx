import { type PluginSurfaceProps, useSettings } from "@getpaseo/plugin/client";
import {
  Loading,
  SettingsAction,
  SettingsCard,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { Text } from "react-native";
import { DEFAULT_FONT_SIZE, DEFAULT_FONT_WEIGHT, DEFAULT_ROW_PADDING, preferences } from "../shared/contracts";

export function PreferencesScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(preferences);
  if (settings.status === "loading") return <Loading />;
  if (settings.status !== "ready") {
    return (
      <SettingsSection title="Better tree">
        <SettingsCard>
          <Text style={{ color: theme.colors.statusDanger }}>{settings.error}</Text>
          <SettingsAction
            label="Stored preferences are unreadable"
            actionLabel="Reset"
            onPress={() => void settings.reset()}
          />
        </SettingsCard>
      </SettingsSection>
    );
  }
  const { values, revision } = settings;
  const save = (patch: Partial<typeof values>) => void settings.save({ ...values, ...patch }, revision);
  return (
    <SettingsSection title="Explorer">
      <SettingsCard>
        <SettingsSwitch
          label="Pin the file tree"
          hint="Opens the tree in Explorer when a workspace opens, including new chats with no messages"
          value={values.autoOpen}
          disabled={settings.saving}
          onValueChange={(autoOpen) => save({ autoOpen })}
        />
        <SettingsSwitch
          label="Move the file tree beside the chat"
          hint="Moves the tree out of Explorer into a workspace pane, then hides Explorer if only Paseo's Files remain, once per workspace each session"
          value={values.arrangeBesideChanges}
          disabled={settings.saving}
          onValueChange={(arrangeBesideChanges) => save({ arrangeBesideChanges })}
        />
        <SettingsSwitch
          label="Open the Git panel"
          hint="Opens branches, changes, and history in a pane below the file tree, once per workspace each session"
          value={values.autoOpenGit}
          disabled={settings.saving}
          onValueChange={(autoOpenGit) => save({ autoOpenGit })}
        />
        <SettingsAction
          label={`Row spacing: ${values.rowPadding}px`}
          hint="Ctrl+scroll over the tree to change it, Ctrl+middle-click to reset"
          actionLabel="Reset"
          disabled={settings.saving || values.rowPadding === DEFAULT_ROW_PADDING}
          error={settings.saveError}
          onPress={() => save({ rowPadding: DEFAULT_ROW_PADDING })}
        />
        <SettingsAction
          label={`Text weight: ${values.fontWeight}`}
          hint="Shift+scroll over the tree to change it, Shift+middle-click to reset"
          actionLabel="Reset"
          disabled={settings.saving || values.fontWeight === DEFAULT_FONT_WEIGHT}
          onPress={() => save({ fontWeight: DEFAULT_FONT_WEIGHT })}
        />
        <SettingsAction
          label={`Text size: ${values.fontSize}px`}
          hint="Alt+scroll over the tree to change it, Alt+middle-click to reset"
          actionLabel="Reset"
          disabled={settings.saving || values.fontSize === DEFAULT_FONT_SIZE}
          onPress={() => save({ fontSize: DEFAULT_FONT_SIZE })}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
