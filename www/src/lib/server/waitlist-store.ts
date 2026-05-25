import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Pool, type PoolConfig } from "pg";

export type WaitlistResult =
  | { ok: true; alreadyOnList: boolean }
  | { ok: false; error: string };

type Store = {
  add(email: string, source?: string): Promise<WaitlistResult>;
};

let cachedStore: Promise<Store> | null = null;

export function getWaitlistStore(): Promise<Store> {
  if (!cachedStore) {
    cachedStore = createStore().catch((err) => {
      cachedStore = null;
      throw err;
    });
  }
  return cachedStore;
}

async function createStore(): Promise<Store> {
  const postgresConfig = resolvePostgresPoolConfig();
  if (postgresConfig) {
    return createPostgresStore(postgresConfig);
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("Waitlist storage requires Postgres in production.");
  }
  return createFileStore();
}

function resolvePostgresPoolConfig(): PoolConfig | null {
  const max = Number(process.env.TRACEBASE_DATABASE_POOL_MAX ?? 5);
  const connectionString = process.env.TRACEBASE_DATABASE_URL ?? process.env.DATABASE_URL;

  if (connectionString) {
    return {
      connectionString,
      max,
      application_name: "tracebase-waitlist",
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
    application_name: "tracebase-waitlist",
  };
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS tracebase_waitlist (
    id BIGSERIAL PRIMARY KEY,
    email TEXT NOT NULL,
    email_normalized TEXT NOT NULL UNIQUE,
    source TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

async function createPostgresStore(config: PoolConfig): Promise<Store> {
  const pool = new Pool(config);
  await pool.query(SCHEMA_SQL);

  return {
    async add(email: string, source?: string): Promise<WaitlistResult> {
      const normalized = email.trim().toLowerCase();
      try {
        const res = await pool.query<{ id: number }>(
          `
          INSERT INTO tracebase_waitlist (email, email_normalized, source)
          VALUES ($1, $2, $3)
          ON CONFLICT (email_normalized) DO NOTHING
          RETURNING id
          `,
          [email.trim(), normalized, source ?? null],
        );
        return { ok: true, alreadyOnList: res.rowCount === 0 };
      } catch (err) {
        console.error("[waitlist] postgres insert failed", err);
        return { ok: false, error: "Storage unavailable." };
      }
    },
  };
}

function createFileStore(): Store {
  const filePath =
    process.env.TRACEBASE_WAITLIST_FILE ??
    join(/*turbopackIgnore: true*/ process.cwd(), ".tracebase", "waitlist.dev.json");

  type FileEntry = { email: string; emailNormalized: string; source: string | null; createdAt: string };
  type FileShape = { version: 1; entries: FileEntry[] };

  async function read(): Promise<FileShape> {
    try {
      const text = await readFile(filePath, "utf-8");
      const parsed = JSON.parse(text) as FileShape;
      if (parsed.version === 1 && Array.isArray(parsed.entries)) return parsed;
    } catch {
      /* fall through */
    }
    return { version: 1, entries: [] };
  }

  async function write(db: FileShape): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(db, null, 2), "utf-8");
  }

  return {
    async add(email: string, source?: string): Promise<WaitlistResult> {
      const normalized = email.trim().toLowerCase();
      try {
        const db = await read();
        if (db.entries.some((e) => e.emailNormalized === normalized)) {
          return { ok: true, alreadyOnList: true };
        }
        db.entries.unshift({
          email: email.trim(),
          emailNormalized: normalized,
          source: source ?? null,
          createdAt: new Date().toISOString(),
        });
        await write(db);
        return { ok: true, alreadyOnList: false };
      } catch (err) {
        console.error("[waitlist] file write failed", err);
        return { ok: false, error: "Storage unavailable." };
      }
    },
  };
}
