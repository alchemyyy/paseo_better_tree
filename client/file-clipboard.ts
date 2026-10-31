import { useSyncExternalStore } from "react";

/** A cut or copied file or folder, by absolute path so every tree view can paste it */
export interface FileClipboard {
  mode: "cut" | "copy";
  path: string;
}

let current: FileClipboard | null = null;
const listeners = new Set<() => void>();

export function setFileClipboard(next: FileClipboard | null): void {
  current = next;
  for (const listener of listeners) listener();
}

/** The clipboard shared by every tree view in this window */
export function useFileClipboard(): FileClipboard | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}
