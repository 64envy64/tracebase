/**
 * Processes a list of items by sending each to an async handler.
 * Returns an array of processed results in order.
 */
export async function processItems<T, R>(
  items: T[],
  handler: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = await Promise.all(items.map((item) => handler(item)));

  return results;
}

/**
 * Simulates saving records to a database.
 * Returns the total number of records saved.
 */
export async function saveRecords(
  records: string[],
  saveFn: (record: string) => Promise<boolean>
): Promise<number> {
  let savedCount = 0;

  const outcomes = await Promise.all(records.map((record) => saveFn(record)));
  for (const ok of outcomes) {
    if (ok) savedCount++;
  }

  return savedCount;
}
