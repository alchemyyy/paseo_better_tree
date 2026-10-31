import {
  type PluginButtonIconProps,
  type PluginButtonRegistration,
  type PluginClientContext,
  useSettings,
} from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { type ComponentType, useEffect, useRef } from "react";
import { View } from "react-native";
import { preferences } from "../shared/contracts";
import { findLayoutStore, findPanelHost } from "./layout-guard";
import { openGitPanel } from "./panel-openers";
import { TREE_PANEL_ID } from "./panel-ids";
import { markOncePerSession } from "./session-memory";

const HEADER_BUTTON_ID = "file-tree";
const GIT_HEADER_BUTTON_ID = "git";
// shortcut: only the first 200 workspaces get a trigger at startup; later ones arrive as updates
const WORKSPACE_PAGE_LIMIT = 200;

function openTree(client: PluginClientContext, workspaceId: string): void {
  try {
    // Explorer placement also shows the Explorer dock (packages/app/src/plugins/navigation.ts)
    client.openPanel(TREE_PANEL_ID, { workspaceId, location: "explorer" });
  } catch (error) {
    console.warn("[better-tree] Could not open the file tree", error);
  }
}

/**
 * The header button's icon mounts when its workspace screen first renders, including a new
 * workspace that only has an unsent draft. That mount is the "workspace became visible" signal.
 */
function createTriggerIcon(client: PluginClientContext): ComponentType<PluginButtonIconProps> {
  return function TreeTriggerIcon({ size, color, workspaceId, layout, host }: PluginButtonIconProps) {
    const settings = useSettings(preferences);
    const autoOpen = settings.status === "ready" && settings.values.autoOpen;
    const nodeRef = useRef<View>(null);
    useEffect(() => {
      if (!autoOpen || layout.compact) return;
      if (!markOncePerSession("tree-opened", workspaceId)) return;
      // A tree already in a workspace pane keeps its pane and size; reopening would move it
      const store = findLayoutStore(nodeRef.current);
      const placement = store ? findPanelHost(store, `${host.id}:${workspaceId}`, TREE_PANEL_ID) : null;
      if (placement === "main") return;
      openTree(client, workspaceId);
    }, [autoOpen, layout.compact, workspaceId, host.id]);
    return (
      <View ref={nodeRef}>
        <Icon name="FolderTree" size={size} color={color} />
      </View>
    );
  };
}

interface WorkspaceButtons {
  tree: PluginButtonRegistration;
  git: PluginButtonRegistration;
}

/** Adds File tree and Git header buttons to every workspace and returns their cleanup */
export function startAutoOpen(client: PluginClientContext): () => void {
  const buttons = new Map<string, WorkspaceButtons>();
  const TriggerIcon = createTriggerIcon(client);
  let stopped = false;
  let releaseSubscription: (() => Promise<void>) | null = null;

  const register = (workspaceId: string) => {
    if (stopped || buttons.has(workspaceId)) return;
    buttons.set(workspaceId, {
      tree: client.addHeaderButton({
        id: HEADER_BUTTON_ID,
        workspaceId,
        button: {
          title: "File tree",
          icon: TriggerIcon,
          behavior: { kind: "action", onPress: () => openTree(client, workspaceId) },
        },
      }),
      // Outside Git the panel lists the repositories inside the tree's folder
      git: client.addHeaderButton({
        id: GIT_HEADER_BUTTON_ID,
        workspaceId,
        button: {
          title: "Git",
          icon: "GitBranch",
          behavior: { kind: "action", onPress: () => openGitPanel(workspaceId) },
        },
      }),
    });
  };
  const unregister = (workspaceId: string) => {
    const entry = buttons.get(workspaceId);
    if (!entry) return;
    entry.tree.remove();
    entry.git.remove();
    buttons.delete(workspaceId);
  };

  void client.paseo.workspaces
    .list({ subscribe: {}, page: { limit: WORKSPACE_PAGE_LIMIT } })
    .then(({ subscription }) => {
      releaseSubscription = () => subscription.release();
      if (stopped) {
        void subscription.release();
        return;
      }
      subscription.subscribe({
        // Snapshots also arrive after reconnect; keep existing buttons so icons do not remount
        snapshot: ({ entries }) => {
          const current = new Set(entries.map((workspace) => workspace.id));
          for (const workspaceId of [...buttons.keys()]) {
            if (!current.has(workspaceId)) unregister(workspaceId);
          }
          for (const workspace of entries) register(workspace.id);
        },
        update: (message) => {
          if (message.type !== "workspace_update") return;
          const update = message.payload;
          if (update.kind === "remove") unregister(update.id);
          else register(update.workspace.id);
        },
      });
    })
    .catch((error: unknown) => {
      if (!stopped) console.error("[better-tree] Workspace observation failed", error);
    });

  return () => {
    stopped = true;
    void releaseSubscription?.();
    for (const entry of buttons.values()) {
      entry.tree.remove();
      entry.git.remove();
    }
    buttons.clear();
  };
}
