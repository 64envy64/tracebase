/**
 * Stale-while-revalidate LRU cache for semantic verdicts (R&D).
 *
 * Keys embed the model version (revision + featureVersion via cacheKey()), so a
 * model-version change produces different keys ⇒ automatic invalidation; old
 * entries age out under the LRU cap. Values are content-free (verdict + bounded
 * confidence + fetchedAt). Local + bounded; never persisted to disk.
 *
 *   fresh : age <= ttlMs              → use, no revalidation
 *   stale : ttlMs < age <= ttlMs+swr  → use NOW, caller revalidates async
 *   miss  : absent or age > ttlMs+swr → caller fetches (bounded) or fails open
 */
export type CacheState = "fresh" | "stale" | "miss";

export interface CachedVerdict {
  verdict: "applicable" | "uncertain" | "inapplicable";
  confidence: number;
  fetchedAtMs: number;
}

export interface SwrCacheOptions {
  ttlMs: number;
  /** Extra window past TTL during which a stale value is still served. */
  swrMs: number;
  maxEntries: number;
  now?: () => number;
}

export class SwrCache {
  private readonly map = new Map<string, CachedVerdict>(); // Map preserves insertion order → LRU
  private readonly now: () => number;
  constructor(private readonly opts: SwrCacheOptions) {
    this.now = opts.now ?? Date.now;
  }

  get(key: string): { state: CacheState; value: CachedVerdict | null } {
    const v = this.map.get(key);
    if (!v) return { state: "miss", value: null };
    const age = this.now() - v.fetchedAtMs;
    if (age <= this.opts.ttlMs) {
      this.touch(key, v);
      return { state: "fresh", value: v };
    }
    if (age <= this.opts.ttlMs + this.opts.swrMs) {
      this.touch(key, v);
      return { state: "stale", value: v };
    }
    this.map.delete(key); // expired past the SWR window
    return { state: "miss", value: null };
  }

  set(key: string, value: Omit<CachedVerdict, "fetchedAtMs">): void {
    this.map.delete(key);
    this.map.set(key, { ...value, fetchedAtMs: this.now() });
    while (this.map.size > this.opts.maxEntries) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  private touch(key: string, v: CachedVerdict): void {
    this.map.delete(key);
    this.map.set(key, v); // move to MRU
  }

  get size(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
}
