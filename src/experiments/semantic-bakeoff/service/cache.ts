/**
 * Content-free SWR cache for semantic verdicts (R&D), with in-memory + SQLite
 * implementations behind one interface.
 *
 * CONTENT-FREE: stores only the cache KEY (which embeds tenant + model revision +
 * featureVersion + queryHash + candidate-content digest + blockId — all hashes/ids)
 * and a verdict + bounded confidence + fetch time. No query/candidate/snippet text
 * is ever stored. A model-version OR candidate-content change yields a different
 * key ⇒ automatic invalidation; entries age out by TTL/SWR + an LRU cap.
 *
 *   fresh : age <= ttlMs              → use, no revalidation
 *   stale : ttlMs < age <= ttlMs+swr  → use NOW, schedule async revalidation
 *   miss  : absent or age > ttlMs+swr → baseline now + schedule warm
 */
import Database from "better-sqlite3";

export type CacheState = "fresh" | "stale" | "miss";
export type Verdict = "applicable" | "uncertain" | "inapplicable";

export interface SemanticCacheEntry {
  verdict: Verdict;
  confidence: number;
  fetchedAtMs: number;
}

export interface SemanticCacheOptions {
  ttlMs: number;
  swrMs: number;
  maxEntries: number;
  now?: () => number;
}

export interface SemanticCache {
  /** Synchronous, local, network-free. */
  get(key: string): { state: CacheState; value: SemanticCacheEntry | null };
  set(key: string, value: { verdict: Verdict; confidence: number }): void;
  size(): number;
  close(): void;
}

function classify(fetchedAtMs: number, now: number, ttlMs: number, swrMs: number): CacheState {
  const age = now - fetchedAtMs;
  if (age <= ttlMs) return "fresh";
  if (age <= ttlMs + swrMs) return "stale";
  return "miss";
}

/** In-memory LRU SWR cache (Map insertion order = LRU). For tests + ephemeral use. */
export class InMemorySemanticCache implements SemanticCache {
  private readonly map = new Map<string, SemanticCacheEntry>();
  private readonly now: () => number;
  constructor(private readonly opts: SemanticCacheOptions) {
    this.now = opts.now ?? Date.now;
  }
  get(key: string): { state: CacheState; value: SemanticCacheEntry | null } {
    const v = this.map.get(key);
    if (!v) return { state: "miss", value: null };
    const state = classify(v.fetchedAtMs, this.now(), this.opts.ttlMs, this.opts.swrMs);
    if (state === "miss") {
      this.map.delete(key);
      return { state, value: null };
    }
    this.map.delete(key);
    this.map.set(key, v); // touch → MRU
    return { state, value: v };
  }
  set(key: string, value: { verdict: Verdict; confidence: number }): void {
    this.map.delete(key);
    this.map.set(key, { ...value, fetchedAtMs: this.now() });
    while (this.map.size > this.opts.maxEntries) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
  size(): number {
    return this.map.size;
  }
  close(): void {
    this.map.clear();
  }
}

/** SQLite-backed SWR cache — content-free table, persists across restarts. */
export class SqliteSemanticCache implements SemanticCache {
  private readonly db: Database.Database;
  private readonly now: () => number;
  constructor(pathOrDb: string | Database.Database, private readonly opts: SemanticCacheOptions) {
    this.db = typeof pathOrDb === "string" ? new Database(pathOrDb) : pathOrDb;
    this.now = opts.now ?? Date.now;
    this.db.pragma("journal_mode = WAL");
    this.db.exec("CREATE TABLE IF NOT EXISTS semantic_cache (k TEXT PRIMARY KEY, verdict TEXT NOT NULL, confidence REAL NOT NULL, fetched_at INTEGER NOT NULL)");
  }
  get(key: string): { state: CacheState; value: SemanticCacheEntry | null } {
    const row = this.db.prepare("SELECT verdict, confidence, fetched_at AS f FROM semantic_cache WHERE k=?").get(key) as { verdict: Verdict; confidence: number; f: number } | undefined;
    if (!row) return { state: "miss", value: null };
    const state = classify(row.f, this.now(), this.opts.ttlMs, this.opts.swrMs);
    if (state === "miss") {
      this.db.prepare("DELETE FROM semantic_cache WHERE k=?").run(key);
      return { state, value: null };
    }
    return { state, value: { verdict: row.verdict, confidence: row.confidence, fetchedAtMs: row.f } };
  }
  set(key: string, value: { verdict: Verdict; confidence: number }): void {
    this.db.prepare("INSERT INTO semantic_cache(k,verdict,confidence,fetched_at) VALUES(?,?,?,?) ON CONFLICT(k) DO UPDATE SET verdict=excluded.verdict, confidence=excluded.confidence, fetched_at=excluded.fetched_at")
      .run(key, value.verdict, value.confidence, this.now());
    // LRU-ish eviction: keep newest maxEntries by fetched_at.
    const n = (this.db.prepare("SELECT COUNT(*) c FROM semantic_cache").get() as { c: number }).c;
    if (n > this.opts.maxEntries) {
      this.db.prepare("DELETE FROM semantic_cache WHERE k IN (SELECT k FROM semantic_cache ORDER BY fetched_at ASC LIMIT ?)").run(n - this.opts.maxEntries);
    }
  }
  size(): number {
    return (this.db.prepare("SELECT COUNT(*) c FROM semantic_cache").get() as { c: number }).c;
  }
  close(): void {
    this.db.close();
  }
}
