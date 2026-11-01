import { type RefObject, useEffect, useState } from "react";
import { Platform } from "react-native";
import { observeOnScreen } from "./web";

/**
 * Whether the view behind `ref` is on screen, so a panel of another workspace or a background tab
 * stops polling the server. On web it starts false and turns true once the view first has a size;
 * off web, or when the view never mounted a DOM node, it stays true.
 */
export function useOnScreen(ref: RefObject<unknown>): boolean {
  const [onScreen, setOnScreen] = useState(Platform.OS !== "web");
  useEffect(() => {
    const stop = observeOnScreen(ref.current, setOnScreen);
    if (!stop) setOnScreen(true);
    return stop ?? undefined;
  }, [ref]);
  return onScreen;
}
