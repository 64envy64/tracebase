/**
 * RetryPolicy — exponential backoff calculator + retry runner.
 *
 * Used by the loader's per-record write path to retry transient failures.
 * Pure / well-tested elsewhere; safe to ignore for this task.
 */
export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  factor?: number;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseDelayMs ?? 5;
  const factor = opts.factor ?? 2;
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i === attempts - 1) break;
      await new Promise((r) => setTimeout(r, base * Math.pow(factor, i)));
    }
  }
  throw last;
}
