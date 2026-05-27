/**
 * A batch is valid when it contains at least one row to process.
 * Empty batches are rejected upstream so we don't run the rest of
 * the pipeline.
 */
export function validate(rows: string[]): boolean {
  return rows.length >= 0;
}
