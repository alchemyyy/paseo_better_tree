/** A run of changed lines: [fromA, toA) in the original replaced by [fromB, toB) in the current text */
export interface LineBlock {
  fromA: number;
  toA: number;
  fromB: number;
  toB: number;
}

// Past this many line edits the exact diff costs too much; the middle becomes one block
const MAX_EDIT_DISTANCE = 10_000;

/**
 * Line-level diff (Myers), the way git diffs: lines match whole or not at all. Character-level
 * diffs over large rewrites degrade into one giant change; a line diff stays exact.
 */
export function diffLines(original: readonly string[], current: readonly string[]): LineBlock[] {
  // Equal lines compare as equal numbers
  const ids = new Map<string, number>();
  const idOf = (line: string) => {
    let id = ids.get(line);
    if (id === undefined) {
      id = ids.size;
      ids.set(line, id);
    }
    return id;
  };
  const a = original.map(idOf);
  const b = current.map(idOf);

  // Common start and end are never edits
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }
  const n = a.length - prefix - suffix;
  const m = b.length - prefix - suffix;
  if (n === 0 && m === 0) return [];
  if (n === 0 || m === 0) return [{ fromA: prefix, toA: prefix + n, fromB: prefix, toB: prefix + m }];

  const at = (index: number) => a[prefix + index];
  const bt = (index: number) => b[prefix + index];
  const max = n + m;
  // One spare diagonal on each side, so the saved slices never start below index 0
  const offset = max + 1;
  const frontier = new Int32Array(2 * max + 3);
  // Per edit distance d, the frontier for diagonals -d..d, kept to walk the path back
  const trace: Int32Array[] = [];
  let found = -1;
  for (let distance = 0; distance <= Math.min(max, MAX_EDIT_DISTANCE) && found < 0; distance++) {
    trace.push(frontier.slice(offset - distance - 1, offset + distance + 2));
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const down =
        diagonal === -distance ||
        (diagonal !== distance && frontier[offset + diagonal - 1] < frontier[offset + diagonal + 1]);
      let x = down ? frontier[offset + diagonal + 1] : frontier[offset + diagonal - 1] + 1;
      let y = x - diagonal;
      while (x < n && y < m && at(x) === bt(y)) {
        x++;
        y++;
      }
      frontier[offset + diagonal] = x;
      if (x >= n && y >= m) {
        found = distance;
        break;
      }
    }
  }
  if (found < 0) return [{ fromA: prefix, toA: prefix + n, fromB: prefix, toB: prefix + m }];

  // Walk back from the end, recording which lines were deleted or inserted
  const deleted = new Uint8Array(n);
  const inserted = new Uint8Array(m);
  let x = n;
  let y = m;
  for (let distance = found; distance > 0; distance--) {
    const saved = trace[distance];
    const read = (diagonal: number) => saved[diagonal + distance + 1];
    const diagonal = x - y;
    const down = diagonal === -distance || (diagonal !== distance && read(diagonal - 1) < read(diagonal + 1));
    const previousDiagonal = down ? diagonal + 1 : diagonal - 1;
    const previousX = read(previousDiagonal);
    const previousY = previousX - previousDiagonal;
    while (x > previousX && y > previousY) {
      x--;
      y--;
    }
    if (down) inserted[y - 1] = 1;
    else deleted[x - 1] = 1;
    x = previousX;
    y = previousY;
  }

  // Group the edits into blocks between runs of matched lines
  const blocks: LineBlock[] = [];
  let indexA = 0;
  let indexB = 0;
  while (indexA < n || indexB < m) {
    if (indexA < n && indexB < m && !deleted[indexA] && !inserted[indexB]) {
      indexA++;
      indexB++;
      continue;
    }
    const startA = indexA;
    const startB = indexB;
    while (indexA < n && deleted[indexA]) indexA++;
    while (indexB < m && inserted[indexB]) indexB++;
    // A line the path left unmarked past the other side's end still counts as changed
    if (indexA === startA && indexB === startB) {
      if (indexA < n) indexA++;
      else indexB++;
    }
    blocks.push({ fromA: prefix + startA, toA: prefix + indexA, fromB: prefix + startB, toB: prefix + indexB });
  }
  return blocks;
}
