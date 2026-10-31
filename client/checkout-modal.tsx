import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Modal } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { CheckoutAction, Commit, Worktree } from "../shared/git-contracts";

export interface CheckoutChoice {
  id: string;
  action: CheckoutAction;
  branch?: string;
  label: string;
  detail: string;
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function buildChoices(commit: Commit, worktree: Worktree): CheckoutChoice[] {
  const choices: CheckoutChoice[] = commit.branches.map((branch) => ({
    id: `branch:${branch}`,
    action: "switch-branch",
    branch,
    label: `Switch to branch ${branch}`,
    detail: `Moves ${basename(worktree.path)} onto ${branch}`,
  }));
  choices.push(
    {
      id: "detached",
      action: "checkout-detached",
      label: "Check out this commit",
      detail: `Detached HEAD at ${commit.shortSha} in ${basename(worktree.path)}`,
    },
    {
      id: "worktree",
      action: "new-worktree",
      label: "Check out to a new worktree",
      detail: `Creates ${basename(worktree.path)}-${commit.sha.slice(0, 8)} beside this worktree`,
    },
  );
  return choices;
}

/** Choosing what to do with a commit and running it both require this confirmation */
export function CheckoutModal({
  commit,
  worktree,
  dirty,
  theme,
  onClose,
  onConfirm,
}: {
  commit: Commit | null;
  worktree: Worktree | null;
  /** The worktree has uncommitted changes */
  dirty: boolean;
  theme: PluginTheme;
  onClose(): void;
  onConfirm(choice: CheckoutChoice): Promise<void>;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choices = useMemo(
    () => (commit && worktree ? buildChoices(commit, worktree) : []),
    [commit, worktree],
  );
  useEffect(() => {
    setSelectedId(null);
    setError(null);
    setBusy(false);
  }, [commit]);
  const selected = choices.find((choice) => choice.id === selectedId) ?? null;
  const muted = theme.colors.foregroundMuted;
  const confirm = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(selected);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const buttonStyle = {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  };
  return (
    <Modal
      title="Check out commit"
      icon={<Icon name="GitCommitHorizontal" size={16} color={theme.colors.foreground} />}
      open={commit !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Modal.Content>
        {commit ? (
          <View style={{ gap: 4 }}>
            <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>{commit.subject}</Text>
            <Text style={{ color: muted, fontSize: 12 }}>
              {commit.shortSha} · {commit.author} · {new Date(commit.time).toLocaleString()}
            </Text>
          </View>
        ) : null}
        <View style={{ gap: 6 }}>
          {choices.map((choice) => {
            const isSelected = choice.id === selectedId;
            return (
              <Pressable
                key={choice.id}
                accessibilityRole="radio"
                accessibilityState={{ selected: isSelected, disabled: busy }}
                disabled={busy}
                onPress={() => setSelectedId(choice.id)}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 10,
                  padding: 10,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: isSelected ? theme.colors.accent : theme.colors.border,
                  backgroundColor: isSelected ? theme.colors.surface2 : theme.colors.surface1,
                }}
              >
                <Icon
                  name={isSelected ? "CircleDot" : "Circle"}
                  size={16}
                  color={isSelected ? theme.colors.accent : muted}
                />
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={{ color: theme.colors.foreground }}>{choice.label}</Text>
                  <Text style={{ color: muted, fontSize: 12 }}>{choice.detail}</Text>
                </View>
              </Pressable>
            );
          })}
        </View>
        {dirty && selected && selected.action !== "new-worktree" ? (
          <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>
            This worktree has uncommitted changes. Git carries them over, or refuses if they conflict.
          </Text>
        ) : null}
        {error ? <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{error}</Text> : null}
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={onClose}
            style={[buttonStyle, { backgroundColor: theme.colors.surface2 }]}
          >
            <Text style={{ color: theme.colors.foreground }}>Cancel</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: !selected || busy }}
            disabled={!selected || busy}
            onPress={() => void confirm()}
            style={[
              buttonStyle,
              { backgroundColor: theme.colors.accent, opacity: !selected || busy ? 0.5 : 1 },
            ]}
          >
            <Text style={{ color: theme.colors.accentForeground }}>{busy ? "Working…" : "Confirm"}</Text>
          </Pressable>
        </View>
      </Modal.Content>
    </Modal>
  );
}
