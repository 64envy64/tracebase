import type { RetryConfig } from "./types.js";

/**
 * Compute the delay before attempt N (0-indexed).
 *
 * For exponential backoff with factor=2 and base=100:
 *   attempt 0 →  100ms
 *   attempt 1 →  200ms
 *   attempt 2 →  400ms
 *   attempt 3 →  800ms
 */
export function computeBackoff(attempt: number, cfg: RetryConfig): number {
  // BUG: this returns base delay for every attempt instead of growing.
  // The Math.pow factor should be applied.
  const raw = cfg.baseDelayMs;
  if (cfg.maxDelayMs != null && raw > cfg.maxDelayMs) return cfg.maxDelayMs;
  return raw;
}

/**
 * Run an async function with retry. Sleeps between attempts using
 * computeBackoff. Returns the final result or throws the last error.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  cfg: RetryConfig,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<{ value: T; attempts: number; delays: number[] }> {
  let last: unknown;
  const delays: number[] = [];
  for (let i = 0; i < cfg.maxAttempts; i++) {
    try {
      const value = await fn();
      return { value, attempts: i + 1, delays };
    } catch (e) {
      last = e;
      if (i === cfg.maxAttempts - 1) break;
      const d = computeBackoff(i, cfg);
      delays.push(d);
      await sleep(d);
    }
  }
  throw last;
}
