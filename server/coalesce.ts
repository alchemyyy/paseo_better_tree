export type Coalescer = <Result>(key: string, run: () => Promise<Result>) => Promise<Result>;

interface KeyState {
  /** The run that starts once the current one settles, shared by every caller since it began */
  queued: Promise<unknown> | null;
  startQueued: (() => void) | null;
}

/**
 * Shares runs between callers of one key. With no run in progress a call starts its own; while one
 * runs, every new caller shares one queued run that starts after it settles, so each caller gets a
 * result that began after it asked. A failed run fails only its callers.
 */
export function createCoalescer(): Coalescer {
  const states = new Map<string, KeyState>();
  const begin = <Result>(key: string, run: () => Promise<Result>): Promise<Result> => {
    // A run that throws rejects like one that fails later
    const result = new Promise<Result>((resolve) => resolve(run()));
    const state: KeyState = { queued: null, startQueued: null };
    states.set(key, state);
    const settled = () => {
      if (state.startQueued) state.startQueued();
      else states.delete(key);
    };
    void result.then(settled, settled);
    return result;
  };
  return <Result>(key: string, run: () => Promise<Result>): Promise<Result> => {
    const state = states.get(key);
    if (!state) return begin(key, run);
    state.queued ??= new Promise<Result>((resolve) => {
      state.startQueued = () => resolve(begin(key, run));
    });
    // NOTE: the callers of one key share one result type
    return state.queued as Promise<Result>;
  };
}
