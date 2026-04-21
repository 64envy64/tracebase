type BucketEntry = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, BucketEntry>();

export function checkRateLimit(input: {
  bucket: string;
  key: string;
  limit: number;
  windowMs: number;
}): { ok: true } | { ok: false; retryAfterSec: number } {
  const now = Date.now();
  const cacheKey = `${input.bucket}:${input.key}`;
  const existing = buckets.get(cacheKey);

  if (!existing || existing.resetAt <= now) {
    buckets.set(cacheKey, {
      count: 1,
      resetAt: now + input.windowMs,
    });
    return { ok: true };
  }

  if (existing.count >= input.limit) {
    return {
      ok: false,
      retryAfterSec: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }

  existing.count += 1;
  buckets.set(cacheKey, existing);
  return { ok: true };
}
