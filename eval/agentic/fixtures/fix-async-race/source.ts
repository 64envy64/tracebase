/**
 * Processes a list of items by sending each to an async handler.
 * Returns an array of processed results in order.
 */
export async function processItems<T, R>(
  items: T[],
  handler: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];

  items.forEach(async (item) => {
    const result = await handler(item);
    results.push(result);
  });

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

  records.forEach(async (record) => {
    const ok = await saveFn(record);
    if (ok) savedCount++;
  });

  return savedCount;
}
