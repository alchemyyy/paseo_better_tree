// A read-only CodeMirror diff renderer the plugin owns. The app's own editor cannot take
// extensions from a second CodeMirror copy, so diff modes render here instead, styled to match.
// DOM-only: CodeMirror loads lazily (./codemirror) so native never evaluates it.
import { Platform } from "react-native";
import { codemirror } from "./codemirror";
import type {
  language as cmLanguage,
  merge as cmMerge,
  state as cmState,
  view as cmView,
} from "./vendor/codemirror";
import {
  applyChunks,
  canShowInline,
  type ChunkRange,
  type DiffChunk,
  type LineHighlight,
  lineHighlights,
  mapPosition,
  unchangedSpans,
} from "./diff-map";
import { diffLines } from "./line-diff";

type Extension = cmState.Extension;
type TextType = cmState.Text;
type EditorViewType = cmView.EditorView;
type LanguageSupport = cmLanguage.LanguageSupport;

/** unified: whole file with deletions inline; changes: only changed hunks; original/current: one side of a split */
export type DiffViewMode = "unified" | "changes" | "original" | "current";

/** Colors and type taken from the surrounding app, so the diff looks like its editor */
export interface EditorLook {
  dark: boolean;
  background: string;
  foreground: string;
  mutedForeground: string;
  gutterBackground: string;
  fontFamily: string;
  fontSize: string;
  lineHeight: string;
}

export interface DiffViewHandle {
  setSources(original: string, current: string): void;
  /** First line visible at the top */
  topLine(): number;
  scrollToLine(line: number): void;
  /** The changed regions, for mapping lines between split sides */
  chunks(): readonly ChunkRange[];
  /** Called with the top line whenever the user scrolls */
  onScroll(listener: (topLine: number) => void): void;
  destroy(): void;
}

const ADDED_BACKGROUND = "rgba(63, 185, 80, 0.16)";
const ADDED_TEXT_BACKGROUND = "rgba(63, 185, 80, 0.28)";
const DELETED_BACKGROUND = "rgba(248, 81, 73, 0.16)";
const DELETED_TEXT_BACKGROUND = "rgba(248, 81, 73, 0.22)";
const MODIFIED_BACKGROUND = "rgba(56, 139, 253, 0.10)";
const MODIFIED_GUTTER = "rgb(56, 139, 253)";
// Stands in for a deleted line break inside an inline deletion
const DELETED_NEWLINE = "↵";
const UNIFIED_COLLAPSE = { margin: 3, minSize: 6 };
const CHANGES_COLLAPSE = { margin: 1, minSize: 2 };

type LanguageFactory = () => LanguageSupport;

// The plugin typechecks without the DOM library; this is the slice of CodeMirror's scrollDOM used here
interface ScrollElement {
  scrollTop: number;
  addEventListener(type: "scroll", listener: () => void, options?: { passive: boolean }): void;
  removeEventListener(type: "scroll", listener: () => void): void;
}

const scrollElement = (view: EditorViewType): ScrollElement => view.scrollDOM as unknown as ScrollElement;

// The slice of the DOM the widgets here build
interface WidgetElement {
  className: string;
  textContent: string | null;
  addEventListener(type: "click", listener: () => void): void;
}
const createElement = (tag: string): WidgetElement =>
  (globalThis as unknown as { document: { createElement(tag: string): WidgetElement } }).document.createElement(tag);

/** Language support by file extension; a curated set keeps the bundle near the app's own */
function languageFor(filename: string): LanguageSupport | null {
  const extension = filename.split(".").pop()?.toLowerCase() ?? "";
  const { cpp } = codemirror().langCpp;
  const { javascript } = codemirror().langJavascript;
  const { python } = codemirror().langPython;
  const { rust } = codemirror().langRust;
  const { json } = codemirror().langJson;
  const { markdown } = codemirror().langMarkdown;
  const { css } = codemirror().langCss;
  const { html } = codemirror().langHtml;
  const { java } = codemirror().langJava;
  const { go } = codemirror().langGo;
  const { yaml } = codemirror().langYaml;
  const { xml } = codemirror().langXml;
  const factories: Record<string, LanguageFactory> = {};
  for (const name of ["c", "h", "cc", "cpp", "cxx", "hpp", "hh", "hxx", "inl", "ipp", "ixx", "cppm"]) factories[name] = cpp;
  for (const name of ["js", "mjs", "cjs"]) factories[name] = () => javascript();
  factories.jsx = () => javascript({ jsx: true });
  for (const name of ["ts", "mts", "cts"]) factories[name] = () => javascript({ typescript: true });
  factories.tsx = () => javascript({ jsx: true, typescript: true });
  for (const name of ["py", "pyi", "pyw"]) factories[name] = python;
  factories.rs = rust;
  for (const name of ["json", "jsonc", "json5"]) factories[name] = json;
  for (const name of ["md", "markdown", "mdx"]) factories[name] = () => markdown();
  for (const name of ["css", "scss", "less"]) factories[name] = css;
  for (const name of ["html", "htm", "xhtml"]) factories[name] = () => html();
  factories.java = java;
  factories.go = go;
  for (const name of ["yaml", "yml"]) factories[name] = yaml;
  for (const name of ["xml", "svg", "xaml", "csproj", "vcxproj", "props", "targets", "plist"]) factories[name] = () => xml();
  const factory = factories[extension];
  return factory ? factory() : null;
}

function buildTheme(look: EditorLook): Extension {
  const { EditorView } = codemirror().view;
  return EditorView.theme(
    {
      "&": { height: "100%", backgroundColor: look.background, color: look.foreground, fontSize: look.fontSize },
      "&.cm-focused": { outline: "none" },
      ".cm-scroller": { fontFamily: look.fontFamily, lineHeight: look.lineHeight, overflow: "auto" },
      ".cm-gutters": { backgroundColor: look.gutterBackground, color: look.mutedForeground, border: "none" },
      // Split sides and the unified view share one palette
      ".bt-line-added, .cm-changedLine, .cm-insertedLine": { backgroundColor: `${ADDED_BACKGROUND} !important` },
      ".bt-line-deleted, .cm-deletedChunk, .cm-deletedLine": { backgroundColor: `${DELETED_BACKGROUND} !important` },
      // Changed characters get a stronger background, only on partially edited lines. `background`
      // with !important replaces @codemirror/merge's dark-theme underline gradient, which outranks us
      "ins, del": { textDecoration: "none" },
      ".cm-changedText, .bt-text-added": { background: `${ADDED_TEXT_BACKGROUND} !important` },
      ".cm-deletedText, .bt-text-deleted": { background: `${DELETED_TEXT_BACKGROUND} !important` },
      // Whole added lines (marked by us) and whole deleted lines (every span deleted) keep only the line color
      ".bt-whole-added .cm-changedText": { background: "none !important" },
      ".cm-deletedLine:not(:has(span:not(.cm-deletedText))) .cm-deletedText": { background: "none !important" },
      ".cm-deletedChunk": { paddingLeft: "6px" },
      ".cm-changeGutter": { width: "3px", paddingLeft: "1px" },
      ".cm-changedLineGutter, .bt-gutter-added": { backgroundColor: "rgb(63, 185, 80)" },
      // Inline chunks: the new text with deleted fragments in place, tinted as modified
      ".bt-line-modified": { backgroundColor: MODIFIED_BACKGROUND },
      ".cm-changeGutter .bt-gutter-modified": { backgroundColor: MODIFIED_GUTTER },
      ".cm-deletedLineGutter, .bt-gutter-deleted": { backgroundColor: "rgb(248, 81, 73)" },
      ".cm-collapsedLines": {
        padding: "4px 12px",
        cursor: "pointer",
        color: look.mutedForeground,
        backgroundColor: look.gutterBackground,
        borderTop: `1px solid ${look.gutterBackground}`,
        borderBottom: `1px solid ${look.gutterBackground}`,
        fontFamily: "inherit",
        fontSize: "0.9em",
      },
      ".cm-collapsedLines:hover": { color: look.foreground },
    },
    { dark: look.dark },
  );
}

/** Each changed line on one side, classified as whole or partial */
function changedLines(doc: TextType, chunks: readonly DiffChunk[], side: "original" | "current"): LineHighlight[] {
  const highlights: LineHighlight[] = [];
  for (const chunk of chunks) {
    const from = side === "original" ? chunk.fromA : chunk.fromB;
    const to = side === "original" ? chunk.toA : chunk.toB;
    if (to <= from) continue;
    const lines: { from: number; to: number; text: string }[] = [];
    // `to` sits past the last changed line's newline
    let line = doc.lineAt(from);
    while (true) {
      lines.push({ from: line.from, to: line.to, text: line.text });
      if (line.to + 1 >= to || line.number >= doc.lines) break;
      line = doc.line(line.number + 1);
    }
    const changes = chunk.changes.map((change) =>
      side === "original" ? { from: change.fromA, to: change.toA } : { from: change.fromB, to: change.toB },
    );
    highlights.push(...lineHighlights(lines, changes));
  }
  return highlights;
}

/** Line colors, change gutter, and changed-character marks for one side of a split */
function sideMarkers(doc: TextType, chunks: readonly DiffChunk[], side: "original" | "current"): Extension {
  const { RangeSetBuilder } = codemirror().state;
  const { Decoration, EditorView, GutterMarker, gutter } = codemirror().view;
  const lineClass = side === "original" ? "bt-line-deleted" : "bt-line-added";
  const textClass = side === "original" ? "bt-text-deleted" : "bt-text-added";
  const gutterClass = side === "original" ? "bt-gutter-deleted" : "bt-gutter-added";
  class ChangeMarker extends GutterMarker {
    elementClass = gutterClass;
  }
  const marker = new ChangeMarker();
  const lineDecoration = Decoration.line({ class: lineClass });
  const textDecoration = Decoration.mark({ class: textClass });
  const decorations: cmState.Range<cmView.Decoration>[] = [];
  const gutterMarks = new RangeSetBuilder<cmView.GutterMarker>();
  for (const highlight of changedLines(doc, chunks, side)) {
    decorations.push(lineDecoration.range(highlight.lineFrom));
    for (const range of highlight.ranges) decorations.push(textDecoration.range(range.from, range.to));
    gutterMarks.add(highlight.lineFrom, highlight.lineFrom, marker);
  }
  const markerSet = gutterMarks.finish();
  return [
    EditorView.decorations.of(Decoration.set(decorations, true)),
    gutter({ class: "cm-changeGutter", markers: () => markerSet }),
  ];
}

/** Marks whole added lines in the unified view, so only partial edits show character highlights */
function wholeAddedLines(doc: TextType, chunks: readonly DiffChunk[]): Extension {
  const { Decoration, EditorView } = codemirror().view;
  const whole = Decoration.line({ class: "bt-whole-added" });
  const ranges = changedLines(doc, chunks, "current")
    .filter((highlight) => highlight.whole)
    .map((highlight) => whole.range(highlight.lineFrom));
  return EditorView.decorations.of(Decoration.set(ranges, true));
}

/** Inline chunks: modified-line tint and gutter, added characters marked, deletions as fragments */
function inlineMarkers(doc: TextType, original: string, chunks: readonly DiffChunk[]): Extension {
  const { RangeSetBuilder } = codemirror().state;
  const { Decoration, EditorView, GutterMarker, WidgetType, gutterLineClass } = codemirror().view;
  class DeletedFragment extends WidgetType {
    constructor(readonly text: string) {
      super();
    }
    eq(other: DeletedFragment) {
      return other.text === this.text;
    }
    toDOM() {
      const element = createElement("del");
      element.className = "bt-text-deleted";
      element.textContent = this.text.replace(/\n/g, DELETED_NEWLINE);
      return element as unknown as ReturnType<cmView.WidgetType["toDOM"]>;
    }
  }
  class ModifiedMarker extends GutterMarker {
    elementClass = "bt-gutter-modified";
  }
  const marker = new ModifiedMarker();
  const lineDecoration = Decoration.line({ class: "bt-line-modified" });
  const addedDecoration = Decoration.mark({ class: "bt-text-added" });
  const decorations: cmState.Range<cmView.Decoration>[] = [];
  const gutterMarks = new RangeSetBuilder<cmView.GutterMarker>();
  for (const chunk of chunks) {
    let line = doc.lineAt(chunk.fromB);
    while (true) {
      decorations.push(lineDecoration.range(line.from));
      gutterMarks.add(line.from, line.from, marker);
      if (line.to + 1 >= chunk.toB || line.number >= doc.lines) break;
      line = doc.line(line.number + 1);
    }
    for (const change of chunk.changes) {
      if (change.toA > change.fromA) {
        const fragment = new DeletedFragment(original.slice(change.fromA, change.toA));
        decorations.push(Decoration.widget({ widget: fragment, side: -1 }).range(Math.min(change.fromB, doc.length)));
      }
      const addedTo = Math.min(change.toB, doc.length);
      if (addedTo > change.fromB) decorations.push(addedDecoration.range(change.fromB, addedTo));
    }
  }
  return [EditorView.decorations.of(Decoration.set(decorations, true)), gutterLineClass.of(gutterMarks.finish())];
}

/** Folds unchanged lines away from the changes; clicking a fold opens it */
function foldUnchanged(doc: TextType, chunks: readonly ChunkRange[], fold: { margin: number; minSize: number }): Extension {
  const { StateEffect, StateField } = codemirror().state;
  const { Decoration, EditorView, WidgetType } = codemirror().view;
  const unfold = StateEffect.define<number>();
  class FoldWidget extends WidgetType {
    constructor(readonly lines: number) {
      super();
    }
    eq(other: FoldWidget) {
      return other.lines === this.lines;
    }
    get estimatedHeight() {
      return 27;
    }
    toDOM(view: EditorViewType) {
      const element = createElement("div");
      element.className = "cm-collapsedLines";
      element.textContent = `⦚ ${this.lines} unchanged lines ⦚`;
      element.addEventListener("click", () => {
        const position = view.posAtDOM(element as unknown as Parameters<EditorViewType["posAtDOM"]>[0]);
        view.dispatch({ effects: unfold.of(position) });
      });
      return element as unknown as ReturnType<cmView.WidgetType["toDOM"]>;
    }
  }
  const spans = unchangedSpans(chunks, (position) => doc.lineAt(position).number, doc.lines, doc.length, fold);
  const ranges = spans.map(({ first, last }) =>
    Decoration.replace({ widget: new FoldWidget(last - first + 1), block: true }).range(
      doc.line(first).from,
      doc.line(last).to,
    ),
  );
  return StateField.define({
    create: () => Decoration.set(ranges),
    update(folds, transaction) {
      folds = folds.map(transaction.changes);
      for (const effect of transaction.effects) {
        if (effect.is(unfold)) folds = folds.update({ filter: (from) => from !== effect.value });
      }
      return folds;
    },
    provide: (self) => EditorView.decorations.from(self),
  });
}

// Character diffs only run inside changed line blocks, which are small
const BLOCK_DIFF_CONFIG = { scanLimit: 1000, timeout: 100 };

/** Offset of each line's start, plus the text length as the end of the last line */
function lineStarts(lines: readonly string[]): number[] {
  const starts: number[] = [];
  let position = 0;
  for (const line of lines) {
    starts.push(position);
    position += line.length + 1;
  }
  starts.push(position);
  return starts;
}

/**
 * @codemirror/merge's diff override: lines first, the way git diffs, then characters inside each
 * changed block. A character diff over a whole large file gives up and reports one huge change.
 */
function lineAwareDiff(original: string, current: string): readonly cmMerge.Change[] {
  const { Change, presentableDiff } = codemirror().merge;
  const linesA = original.split("\n");
  const linesB = current.split("\n");
  const startsA = lineStarts(linesA);
  const startsB = lineStarts(linesB);
  const at = (starts: number[], line: number, length: number) => Math.min(starts[line], length);
  const changes: cmMerge.Change[] = [];
  for (const block of diffLines(linesA, linesB)) {
    const fromA = at(startsA, block.fromA, original.length);
    const toA = at(startsA, block.toA, original.length);
    const fromB = at(startsB, block.fromB, current.length);
    const toB = at(startsB, block.toB, current.length);
    if (fromA === toA || fromB === toB) {
      changes.push(new Change(fromA, toA, fromB, toB));
      continue;
    }
    // Presentable: whole words rather than scattered matching letters
    for (const inner of presentableDiff(original.slice(fromA, toA), current.slice(fromB, toB), BLOCK_DIFF_CONFIG)) {
      changes.push(new Change(fromA + inner.fromA, fromA + inner.toA, fromB + inner.fromB, fromB + inner.toB));
    }
  }
  return changes;
}

/** Shared by the views and the change counts, so every place agrees with git */
export const DIFF_CONFIG = { override: lineAwareDiff };

function computeChunks(original: string, current: string): DiffChunk[] {
  const { Text } = codemirror().state;
  const { Chunk } = codemirror().merge;
  return Chunk.build(Text.of(original.split("\n")), Text.of(current.split("\n")), DIFF_CONFIG).map((chunk) => ({
    fromA: chunk.fromA,
    toA: chunk.toA,
    fromB: chunk.fromB,
    toB: chunk.toB,
    // Character changes are relative to the chunk's start
    changes: chunk.changes.map((change) => ({
      fromA: chunk.fromA + change.fromA,
      toA: chunk.fromA + change.toA,
      fromB: chunk.fromB + change.fromB,
      toB: chunk.fromB + change.toB,
    })),
  }));
}

/** Mounts a read-only diff into `parent` (a DOM element); null off web */
export function mountDiffView(
  parent: unknown,
  options: { original: string; current: string; filename: string; mode: DiffViewMode; look: EditorLook },
): DiffViewHandle | null {
  if (Platform.OS !== "web" || !parent) return null;
  const { EditorState } = codemirror().state;
  const { EditorView, lineNumbers, highlightSpecialChars } = codemirror().view;
  const { syntaxHighlighting, defaultHighlightStyle } = codemirror().language;
  const { oneDarkHighlightStyle } = codemirror().themeOneDark;
  const { unifiedMergeView } = codemirror().merge;

  let original = options.original;
  let current = options.current;
  let chunks = computeChunks(original, current);
  let view: EditorViewType | null = null;
  const scrollListeners = new Set<(topLine: number) => void>();
  const language = languageFor(options.filename);
  const highlight = syntaxHighlighting(options.look.dark ? oneDarkHighlightStyle : defaultHighlightStyle);

  const build = () => {
    const doc = options.mode === "original" ? original : current;
    const extensions: Extension[] = [
      lineNumbers(),
      highlightSpecialChars(),
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      highlight,
      buildTheme(options.look),
    ];
    if (language) extensions.push(language);
    // The decorations need the document as CodeMirror's Text, so build it once first
    const docText = EditorState.create({ doc }).doc;
    let blockChunks = chunks;
    if (options.mode === "unified" || options.mode === "changes") {
      // Inline chunks are applied to the original merge diffs against, so merge draws blocks only
      // for the rest; inline ones get their own marks, and folding covers every chunk
      const inline = chunks.filter((chunk) => canShowInline(chunk, original, current));
      blockChunks = chunks.filter((chunk) => !inline.includes(chunk));
      extensions.push(
        inlineMarkers(docText, original, inline),
        foldUnchanged(docText, chunks, options.mode === "changes" ? CHANGES_COLLAPSE : UNIFIED_COLLAPSE),
        unifiedMergeView({
          original: inline.length > 0 ? applyChunks(original, current, inline) : original,
          mergeControls: false,
          highlightChanges: true,
          gutter: true,
          syntaxHighlightDeletions: true,
          diffConfig: DIFF_CONFIG,
        }),
      );
    }
    const markers =
      options.mode === "original" || options.mode === "current"
        ? sideMarkers(docText, chunks, options.mode)
        : wholeAddedLines(docText, blockChunks);
    return EditorState.create({ doc, extensions: [...extensions, markers] });
  };

  const handleScroll = () => {
    const line = handle.topLine();
    for (const listener of scrollListeners) listener(line);
  };

  view = new EditorView({ parent: parent as Element, state: build() });
  scrollElement(view).addEventListener("scroll", handleScroll, { passive: true });

  const handle: DiffViewHandle = {
    setSources(nextOriginal, nextCurrent) {
      if (!view || (nextOriginal === original && nextCurrent === current)) return;
      const top = handle.topLine();
      original = nextOriginal;
      current = nextCurrent;
      chunks = computeChunks(original, current);
      view.setState(build());
      handle.scrollToLine(top);
    },
    topLine() {
      if (!view) return 1;
      const block = view.lineBlockAtHeight(scrollElement(view).scrollTop);
      return view.state.doc.lineAt(block.from).number;
    },
    scrollToLine(line) {
      if (!view) return;
      const target = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)));
      view.dispatch({ effects: EditorView.scrollIntoView(target.from, { y: "start" }) });
    },
    chunks: () => chunks,
    onScroll(listener) {
      scrollListeners.add(listener);
    },
    destroy() {
      if (view) scrollElement(view).removeEventListener("scroll", handleScroll);
      view?.destroy();
      view = null;
      scrollListeners.clear();
    },
  };
  return handle;
}

/** Line on the other side of a split matching `line` on `from`'s side */
export function mapLine(
  original: string,
  current: string,
  chunks: readonly ChunkRange[],
  line: number,
  from: "original" | "current",
): number {
  const { Text } = codemirror().state;
  const source = Text.of((from === "original" ? original : current).split("\n"));
  const target = Text.of((from === "original" ? current : original).split("\n"));
  const position = source.line(Math.max(1, Math.min(line, source.lines))).from;
  const mapped = mapPosition(chunks, position, from === "original" ? "a" : "b");
  return target.lineAt(Math.max(0, Math.min(mapped, target.length))).number;
}
