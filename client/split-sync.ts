import { type DiffViewHandle, mapLine } from "./diff-editor";

interface SplitSide {
  handle: DiffViewHandle;
  sources(): { original: string; current: string };
}

interface SplitPair {
  original?: SplitSide;
  current?: SplitSide;
  /** Scroll events before this time are echoes of a programmatic scroll */
  quietUntil: number;
}

// Programmatic scrolls fire scroll events too; ignoring them briefly prevents ping-pong
const ECHO_QUIET_MS = 120;
const pairs = new Map<string, SplitPair>();

/**
 * Joins one side of a split diff (each side lives in its own pane) so scrolling either keeps the
 * other on the matching line. Returns the leave function.
 */
export function joinSplit(
  pairKey: string,
  side: "original" | "current",
  handle: DiffViewHandle,
  sources: () => { original: string; current: string },
): () => void {
  const pair = pairs.get(pairKey) ?? { quietUntil: 0 };
  pairs.set(pairKey, pair);
  const member: SplitSide = { handle, sources };
  pair[side] = member;
  const otherSide = side === "original" ? "current" : "original";
  handle.onScroll((line) => {
    const partner = pair[otherSide];
    if (!partner || pair[side] !== member || Date.now() < pair.quietUntil) return;
    const { original, current } = sources();
    pair.quietUntil = Date.now() + ECHO_QUIET_MS;
    partner.handle.scrollToLine(mapLine(original, current, handle.chunks(), line, side));
  });
  // A side joining late starts aligned with its partner
  const partner = pair[otherSide];
  if (partner) {
    const { original, current } = sources();
    pair.quietUntil = Date.now() + ECHO_QUIET_MS;
    handle.scrollToLine(mapLine(original, current, partner.handle.chunks(), partner.handle.topLine(), otherSide));
  }
  return () => {
    if (pair[side] === member) delete pair[side];
    if (!pair.original && !pair.current) pairs.delete(pairKey);
  };
}

/** Whether a split pair still has its other side open */
export function hasSplitSide(pairKey: string, side: "original" | "current"): boolean {
  return Boolean(pairs.get(pairKey)?.[side]);
}
