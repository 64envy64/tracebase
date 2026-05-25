import { Pool, type PoolConfig } from "pg";

type BucketEntry = {
  count: number;
  resetAt: number;
};

type RateLimitResult =
  | { ok: true }
  | { ok: false; retryAfterSec: number };

const memoryBuckets = new Map<string, BucketEntry>();

let cachedPoolPromise: Promise<Pool | null> | null = null;

export async function checkRateLimit(input: {
  bucket: string;
  key: string;
  limit: number;
  windowMs: number;
}): Promise<RateLimitResult> {
  const pool = await getRateLimitPool();
  if (pool) {
    return checkPostgresRateLimit(pool, input);
  }
  if (process.env.NODE_ENV === "production") {
    return { ok: false, retryAfterSec: 60 };
  }
  return checkMemoryRateLimit(input);
}

async function getRateLimitPool(): Promise<Pool | null> {
  if (!cachedPoolPromise) {
    cachedPoolPromise = createRateLimitPool().catch((err) => {
      cachedPoolPromise = null;
      throw err;
    });
  }
  return cachedPoolPromise;
}

async function createRateLimitPool(): Promise<Pool | null> {
  const config = resolvePostgresPoolConfig();
  if (!config) return null;

  const pool = new Pool({
    ...config,
    application_name: "tracebase-rate-limit",
  });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tracebase_rate_limit_buckets (
      bucket_key TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      reset_at_ms BIGINT NOT NULL
    );
  `);
  return pool;
}

async function checkPostgresRateLimit(
  pool: Pool,
  input: {
    bucket: string;
    key: string;
    limit: number;
    windowMs: number;
  },
): Promise<RateLimitResult> {
  const now = Date.now();
  const resetAt = now + input.windowMs;
  const cacheKey = `${input.bucket}:${input.key}`;
  const res = await pool.query<{ count: number; reset_at_ms: string }>(
    `
    INSERT INTO tracebase_rate_limit_buckets (bucket_key, count, reset_at_ms)
    VALUES ($1, 1, $2)
    ON CONFLICT (bucket_key) DO UPDATE
    SET count = CASE
          WHEN tracebase_rate_limit_buckets.reset_at_ms <= $3 THEN 1
          ELSE tracebase_rate_limit_buckets.count + 1
        END,
        reset_at_ms = CASE
          WHEN tracebase_rate_limit_buckets.reset_at_ms <= $3 THEN $2
          ELSE tracebase_rate_limit_buckets.reset_at_ms
        END
    RETURNING count, reset_at_ms
    `,
    [cacheKey, resetAt, now],
  );
  const row = res.rows[0];
  if (!row || row.count <= input.limit) return { ok: true };
  const retryAfterSec = Math.max(1, Math.ceil((Number(row.reset_at_ms) - now) / 1000));
  return { ok: false, retryAfterSec };
}

function checkMemoryRateLimit(input: {
  bucket: string;
  key: string;
  limit: number;
  windowMs: number;
}): RateLimitResult {
  const now = Date.now();
  const cacheKey = `${input.bucket}:${input.key}`;
  const existing = memoryBuckets.get(cacheKey);

  if (!existing || existing.resetAt <= now) {
    memoryBuckets.set(cacheKey, {
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
  memoryBuckets.set(cacheKey, existing);
  return { ok: true };
}

function resolvePostgresPoolConfig(): PoolConfig | null {
  const max = Number(process.env.TRACEBASE_DATABASE_POOL_MAX ?? 5);
  const connectionString = process.env.TRACEBASE_DATABASE_URL ?? process.env.DATABASE_URL;

  if (connectionString) {
    return {
      connectionString,
      max,
    };
  }

  const user = process.env.TRACEBASE_DB_USER ?? process.env.DB_USER;
  const password = process.env.TRACEBASE_DB_PASSWORD ?? process.env.DB_PASS;
  const database = process.env.TRACEBASE_DB_NAME ?? process.env.DB_NAME;
  const socketHost =
    process.env.TRACEBASE_INSTANCE_UNIX_SOCKET ??
    process.env.INSTANCE_UNIX_SOCKET ??
    (process.env.TRACEBASE_CLOUDSQL_INSTANCE
      ? `/cloudsql/${process.env.TRACEBASE_CLOUDSQL_INSTANCE}`
      : undefined);

  if (!user || !password || !database || !socketHost) {
    return null;
  }

  return {
    user,
    password,
    database,
    host: socketHost,
    max,
  };
}
