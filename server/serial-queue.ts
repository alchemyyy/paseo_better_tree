export type SerialQueue = <T>(key: string, task: () => Promise<T>) => Promise<T>;

/**
 * Runs tasks that share a key one at a time, in the order they arrive. A failed task does not stop
 * the ones queued behind it, and tasks under different keys do not wait for each other.
 */
export function createSerialQueue(): SerialQueue {
  const tails = new Map<string, Promise<void>>();
  return <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const result = (tails.get(key) ?? Promise.resolve()).then(task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return result;
  };
}
