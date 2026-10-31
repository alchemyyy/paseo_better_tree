/**
 * What the file tree's filter field matches: whitespace-separated terms that must all appear,
 * ignoring case, in an entry's name or in the names of the folders above it, at least one in its
 * own name ("comp tree" finds tree files inside components folders). A term with a slash matches
 * anywhere in the relative path instead ("src/comp" finds everything under src/components).
 */
export interface TreeFilter {
  /** Lowercased terms matched against names along the entry's path */
  nameTerms: string[];
  /** Lowercased terms with a "/", matched against the forward-slash relative path */
  pathTerms: string[];
}

/** The filter typed as `text`, or null when it holds no terms */
export function parseTreeFilter(text: string): TreeFilter | null {
  const terms = text
    .toLowerCase()
    .replace(/\\/g, "/")
    .split(/\s+/)
    .filter((term) => term !== "");
  if (terms.length === 0) return null;
  return {
    nameTerms: terms.filter((term) => !term.includes("/")),
    pathTerms: terms.filter((term) => term.includes("/")),
  };
}

/** Whether an entry matches; `lowerPath` is its lowercased forward-slash relative path */
export function matchesTreeFilter(filter: TreeFilter, lowerPath: string): boolean {
  // A name term holds no slash, so wherever it appears it lies within one name along the path;
  // the entry's own name is the last one
  const nameStart = lowerPath.lastIndexOf("/") + 1;
  let inOwnName = filter.nameTerms.length === 0;
  for (const term of filter.nameTerms) {
    if (lowerPath.indexOf(term, nameStart) !== -1) inOwnName = true;
    else if (!lowerPath.includes(term)) return false;
  }
  return inOwnName && filter.pathTerms.every((term) => lowerPath.includes(term));
}

/** Where the name terms appear in `name`, as sorted, merged [start, end) ranges to highlight */
export function filterMatchRanges(filter: TreeFilter, name: string): [number, number][] {
  const lower = name.toLowerCase();
  // A few characters change length when lowercased; their offsets would not line up
  if (lower.length !== name.length) return [];
  const ranges: [number, number][] = [];
  for (const term of filter.nameTerms) {
    for (let at = lower.indexOf(term); at !== -1; at = lower.indexOf(term, at + 1)) {
      ranges.push([at, at + term.length]);
    }
  }
  ranges.sort((left, right) => left[0] - right[0]);
  const merged: [number, number][] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}
