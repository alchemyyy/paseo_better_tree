import type { SettingsState } from "@getpaseo/plugin/client";
import type { z } from "zod";
import type { preferences } from "../shared/contracts";

export type Preferences = z.output<typeof preferences.schema>;
type PreferencesState = SettingsState<typeof preferences.schema>;

const SAVE_DELAY_MS = 400;

// One saver for every writer (display scrolls, layout drags, section dividers), so concurrent
// patches merge into one write instead of racing on the same settings revision
let latest: PreferencesState | null = null;
let pending: Partial<Preferences> = {};
let timer: ReturnType<typeof setTimeout> | null = null;

/** Call from any component holding `useSettings(preferences)` so the saver sees current values */
export function trackPreferences(state: PreferencesState): void {
  latest = state;
}

/** Current saved values with unsaved patches applied, or null before settings load */
export function readPreferences(): Preferences | null {
  if (!latest || latest.status !== "ready") return null;
  return { ...latest.values, ...pending };
}

function flush(): void {
  timer = null;
  const state = latest;
  if (!state || state.status !== "ready") return;
  const patch = pending;
  pending = {};
  void state.save({ ...state.values, ...patch }, state.revision);
}

/** Merges `patch` into the next debounced settings write */
export function savePreferences(patch: Partial<Preferences>): void {
  pending = { ...pending, ...patch };
  if (timer) clearTimeout(timer);
  timer = setTimeout(flush, SAVE_DELAY_MS);
}
