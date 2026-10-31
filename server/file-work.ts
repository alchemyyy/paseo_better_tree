/**
 * Node runs file work on a small shared thread pool. A long list goes through it this many items
 * at a time, so one listing or status read does not hold up the plugin's other reads, such as the
 * Git panel's repository search
 */
export const FILE_WORK_CONCURRENCY = 16;

/** `work` applied to every item, FILE_WORK_CONCURRENCY at a time; results in item order */
export async function mapLimited<Item, Result>(
  items: readonly Item[],
  work: (item: Item) => Promise<Result>,
): Promise<Result[]> {
  const results = new Array<Result>(items.length);
  let next = 0;
  const runNext = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(FILE_WORK_CONCURRENCY, items.length) }, runNext));
  return results;
}
