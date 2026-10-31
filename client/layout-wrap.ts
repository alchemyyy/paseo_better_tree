// NOTE: Identical in paseo_better_tree and paseo_better_chat_management; keep the copies in step.
// Both plugins wrap actions of Paseo's workspace layout store. Each wrapper calls through its
// link's `next`, which installers may rewrite, so a plugin can replace or remove its own wrapper
// wherever it sits in the chain without dropping the other plugin's.

export const WRAP_LINK = "__paseoLayoutWrap";

type AnyFunction = (...args: never[]) => unknown;

export interface WrapLink {
  owner: string;
  next: AnyFunction;
}

export interface WrappableStore {
  getState(): object;
  setState(partial: object): void;
}

export interface WrapOptions {
  /** The wrapped original of a wrapper this owner installed before the link protocol, if `fn` is one */
  legacyOriginal?(fn: AnyFunction): AnyFunction | undefined;
  /** Extra properties on the wrapper, such as marks other plugins look for */
  props?: Record<string, unknown>;
}

function linkOf(fn: unknown): WrapLink | undefined {
  if (typeof fn !== "function" || !(WRAP_LINK in fn)) return undefined;
  const link = fn[WRAP_LINK];
  return typeof link === "object" && link !== null && "next" in link && typeof link.next === "function"
    ? (link as WrapLink)
    : undefined;
}

function actionOf(store: WrappableStore, key: string): AnyFunction {
  const action = (store.getState() as Record<string, unknown>)[key];
  if (typeof action !== "function") throw new Error(`The layout store has no ${key}`);
  return action as AnyFunction;
}

/** What `fn` stands for once a wrapper matching `remove` is skipped, or undefined if it does not match */
type Skip = (fn: AnyFunction) => AnyFunction | undefined;

/** Splices every wrapper `skip` matches out of the chain at `key` */
function spliceOut(store: WrappableStore, key: string, skip: Skip): void {
  let top = actionOf(store, key);
  for (let replacement = skip(top); replacement; replacement = skip(top)) top = replacement;
  if (top !== actionOf(store, key)) store.setState({ [key]: top });
  let link = linkOf(top);
  while (link) {
    const replacement = skip(link.next);
    if (replacement) link.next = replacement;
    else link = linkOf(link.next);
  }
}

/**
 * Puts `owner`'s wrapper of the store action `key` on top, after removing that owner's earlier
 * wrappers anywhere in the chain. `make` receives the next function to call. Returns a function
 * that removes this wrapper wherever it then sits.
 */
export function wrapStoreAction<F extends AnyFunction>(
  store: WrappableStore,
  key: string,
  owner: string,
  make: (next: F) => F,
  options: WrapOptions = {},
): () => void {
  spliceOut(store, key, (fn) => {
    const link = linkOf(fn);
    if (link) return link.owner === owner ? link.next : undefined;
    return options.legacyOriginal?.(fn);
  });
  const link: WrapLink = { owner, next: actionOf(store, key) };
  const callNext = ((...args: never[]) => link.next(...args)) as F;
  const wrapped = Object.assign(make(callNext), options.props, { [WRAP_LINK]: link });
  store.setState({ [key]: wrapped });
  return () => spliceOut(store, key, (fn) => (fn === wrapped ? link.next : undefined));
}

/** Whether any function in the chain at `fn` (following links, then legacy originals) matches */
export function chainSome(
  fn: unknown,
  predicate: (fn: AnyFunction) => boolean,
  legacyNext?: (fn: AnyFunction) => AnyFunction | undefined,
): boolean {
  const seen = new Set<unknown>();
  let current: unknown = fn;
  while (typeof current === "function" && !seen.has(current)) {
    seen.add(current);
    const candidate = current as AnyFunction;
    if (predicate(candidate)) return true;
    current = linkOf(candidate)?.next ?? legacyNext?.(candidate);
  }
  return false;
}
