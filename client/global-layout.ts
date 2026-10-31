import type { SettingsState } from "@getpaseo/plugin/client";
import { type RefObject, useEffect } from "react";
import type { preferences } from "../shared/contracts";
import { findLayoutStore } from "./layout-guard";
import { createLayoutSync, type SyncStore } from "./layout-sync";
import { readPreferences, savePreferences, trackPreferences } from "./preference-saver";

let active: { store: unknown; sync(): void; stop(): void } | null = null;

/** Stops the layout watcher; the client entry calls this on plugin unload */
export function stopGlobalLayout(): void {
  active?.stop();
  active = null;
}

/**
 * Starts the app-wide layout watcher from a mounted panel, which is the only place the layout
 * store can be reached, and re-syncs whenever the saved preferences change
 */
export function useGlobalLayout(
  rootRef: RefObject<unknown>,
  settings: SettingsState<typeof preferences.schema>,
): void {
  trackPreferences(settings);
  useEffect(() => {
    const store = findLayoutStore(rootRef.current);
    if (!store || active?.store === store) return;
    active?.stop();
    const sync = createLayoutSync(store as unknown as SyncStore, {
      read: () => {
        const values = readPreferences();
        if (!values) return null;
        const { arrangement, explorerWidth } = values;
        return { arrangement, explorerWidth };
      },
      save: savePreferences,
    });
    active = { store, ...sync };
    sync.sync();
  }, [rootRef]);
  const values = settings.status === "ready" ? settings.values : null;
  useEffect(() => {
    active?.sync();
  }, [values]);
}
