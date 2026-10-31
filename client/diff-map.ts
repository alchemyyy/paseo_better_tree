/** A changed region: positions in the original (A) and current (B) texts, as @codemirror/merge's Chunk */
export interface ChunkRange {
  fromA: number;
  toA: number;
  fromB: number;
  toB: number;
}

/** A changed region with its character-level changes, all as absolute positions */
export interface DiffChunk extends ChunkRange {
  changes: ChunkRange[];
}

export interface TextRange {
  from: number;
  to: number;
}

export interface LineHighlight {
  lineFrom: number;
  /** Added or removed outright: the line background says it all */
  whole: boolean;
  /** For a partially edited line, the changed characters */
  ranges: TextRange[];
}

/**
 * Classifies each changed line of one side: whole when no visible character on it survived,
 * else partial with the changed character ranges clipped to the line
 */
export function lineHighlights(
  lines: readonly { from: number; to: number; text: string }[],
  changes: readonly TextRange[],
): LineHighlight[] {
  return lines.map((line) => {
    const ranges: TextRange[] = [];
    for (const change of changes) {
      const from = Math.max(change.from, line.from);
      const to = Math.min(change.to, line.to);
      if (to > from) ranges.push({ from, to });
    }
    let survivor = false;
    for (let offset = 0; offset < line.text.length && !survivor; offset++) {
      if (/\s/.test(line.text[offset])) continue;
      const position = line.from + offset;
      survivor = !ranges.some((range) => position >= range.from && position < range.to);
    }
    return { lineFrom: line.from, whole: !survivor, ranges: survivor ? ranges : [] };
  });
}

/**
 * Maps a position in one side of a diff to the other. Outside changed regions the texts match,
 * so the offset carries over; inside one, the position maps to the region's start.
 */
export function mapPosition(chunks: readonly ChunkRange[], position: number, from: "a" | "b"): number {
  let delta = 0;
  for (const chunk of chunks) {
    const start = from === "a" ? chunk.fromA : chunk.fromB;
    const end = from === "a" ? chunk.toA : chunk.toB;
    const otherStart = from === "a" ? chunk.fromB : chunk.fromA;
    const otherEnd = from === "a" ? chunk.toB : chunk.toA;
    if (position < start) break;
    if (position < end) return otherStart;
    delta = otherEnd - end;
  }
  return position + delta;
}

// A chunk shows inline (deletions as fragments within the new text) when it is short and most of
// its visible text survives; heavier rewrites interleave into noise and keep old/new blocks
const INLINE_MAX_LINES = 10;
const INLINE_MIN_KEPT = 0.5;

function visibleLength(text: string): number {
  return text.replace(/\s/g, "").length;
}

function countLines(text: string): number {
  let lines = 1;
  for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) === 10) lines++;
  return lines;
}

/** Whether a chunk reads better inline than as a deleted block above an added one */
export function canShowInline(chunk: DiffChunk, original: string, current: string): boolean {
  if (chunk.toA <= chunk.fromA || chunk.toB <= chunk.fromB) return false;
  const textA = original.slice(chunk.fromA, chunk.toA);
  const textB = current.slice(chunk.fromB, chunk.toB);
  if (countLines(textA.trimEnd()) > INLINE_MAX_LINES || countLines(textB.trimEnd()) > INLINE_MAX_LINES) return false;
  let deleted = 0;
  for (const change of chunk.changes) deleted += visibleLength(original.slice(change.fromA, change.toA));
  const kept = visibleLength(textA) - deleted;
  return kept > 0 && kept >= INLINE_MIN_KEPT * Math.max(visibleLength(textA), visibleLength(textB));
}

/** `original` with the given chunks (in order) replaced by their current text */
export function applyChunks(original: string, current: string, chunks: readonly ChunkRange[]): string {
  let result = "";
  let position = 0;
  for (const chunk of chunks) {
    result += original.slice(position, chunk.fromA) + current.slice(chunk.fromB, chunk.toB);
    position = chunk.toA;
  }
  return result + original.slice(position);
}

export interface LineSpan {
  /** First and last line numbers, 1-based and inclusive */
  first: number;
  last: number;
}

/**
 * Runs of unchanged current-side lines to fold: everything farther than `margin` lines from a
 * change, when at least `minSize` lines long. `lineAt` gives a position's line number
 */
export function unchangedSpans(
  chunks: readonly ChunkRange[],
  lineAt: (position: number) => number,
  totalLines: number,
  textLength: number,
  { margin, minSize }: { margin: number; minSize: number },
): LineSpan[] {
  const spans: LineSpan[] = [];
  const add = (first: number, last: number) => {
    if (last - first + 1 >= minSize) spans.push({ first, last });
  };
  let nextLine = 1;
  for (const chunk of chunks) {
    const startLine = lineAt(Math.min(chunk.fromB, textLength));
    // A chunk's end sits past its last line's newline; a pure deletion touches no current line
    const endLine = chunk.toB > chunk.fromB ? lineAt(Math.min(chunk.toB - 1, textLength)) : startLine - 1;
    add(nextLine === 1 ? 1 : nextLine + margin, startLine - 1 - margin);
    nextLine = Math.max(nextLine, endLine + 1);
  }
  add(nextLine === 1 ? 1 : nextLine + margin, totalLines);
  return spans;
}
