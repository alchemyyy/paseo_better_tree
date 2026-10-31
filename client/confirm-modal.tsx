import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Modal } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { isWindowsPath } from "./tree-model";

/** What the daemon host calls its trash, judged by the path style of a folder on it */
export function trashName(hostPath: string): string {
  return isWindowsPath(hostPath) ? "Recycle Bin" : "Trash";
}

export interface Confirmation {
  title: string;
  icon: string;
  message: string;
  /** Muted lines under the message */
  details?: readonly string[];
  confirmLabel: string;
  busyLabel: string;
  /** Destructive: the confirm button is red */
  danger?: boolean;
  /** Errors stay in the dialog so the user can retry or cancel */
  run(): Promise<void>;
}

/** Asks before an action; open while `confirmation` is set */
export function ConfirmModal({
  confirmation,
  theme,
  onClose,
}: {
  confirmation: Confirmation | null;
  theme: PluginTheme;
  onClose(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    if (busy) return;
    setError(null);
    onClose();
  };
  const confirm = async () => {
    if (!confirmation) return;
    setBusy(true);
    setError(null);
    try {
      await confirmation.run();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const buttonStyle = { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 };
  const confirmColor = confirmation?.danger ? theme.colors.statusDanger : theme.colors.accent;
  return (
    <Modal
      title={confirmation?.title ?? ""}
      icon={confirmation ? <Icon name={confirmation.icon} size={16} color={theme.colors.foreground} /> : undefined}
      open={confirmation !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <Modal.Content>
        {confirmation ? (
          <View style={{ gap: 4 }}>
            <Text style={{ color: theme.colors.foreground }}>{confirmation.message}</Text>
            {confirmation.details?.map((detail) => (
              <Text key={detail} style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                {detail}
              </Text>
            ))}
          </View>
        ) : null}
        {error ? <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{error}</Text> : null}
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={close}
            style={[buttonStyle, { backgroundColor: theme.colors.surface2 }]}
          >
            <Text style={{ color: theme.colors.foreground }}>Cancel</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: busy }}
            disabled={busy}
            onPress={() => void confirm()}
            style={[buttonStyle, { backgroundColor: confirmColor, opacity: busy ? 0.5 : 1 }]}
          >
            <Text style={{ color: theme.colors.accentForeground }}>
              {busy ? confirmation?.busyLabel : confirmation?.confirmLabel}
            </Text>
          </Pressable>
        </View>
      </Modal.Content>
    </Modal>
  );
}
