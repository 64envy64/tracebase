import { LRUCache } from "./lru.js";

interface Entry<V> {
  value: V;
  expiresAt: number;
}

/**
 * TTL cache: LRU + per-key expiration.
 *
 * Contract: an entry that has expired is treated as absent by `get`
 * (returns undefined). Periodic memory pressure: a steady stream of
 * `set` calls with short TTLs must NOT grow the underlying LRU
 * unboundedly — expired entries must be reaped.
 */
export class TtlCache<K, V> {
  private inner: LRUCache<K, Entry<V>>;

  constructor(capacity: number, private now: () => number = Date.now) {
    this.inner = new LRUCache(capacity);
  }

  get(k: K): V | undefined {
    const e = this.inner.get(k);
    if (!e) return undefined;
    if (e.expiresAt <= this.now()) {
      this.inner.delete(k);
      return undefined;
    }
    return e.value;
  }

  set(k: K, v: V, ttlMs: number): void {
    // BUG: never reaps expired entries on the write path. Under a steady
    // stream of short-TTL inserts (write-dominated workload), the inner
    // LRU fills with stale entries that get() would have evicted but
    // never sees because the caller is writing, not reading. RAM grows.
    this.inner.set(k, { value: v, expiresAt: this.now() + ttlMs });
  }

  size(): number {
    return this.inner.size();
  }

  liveKeys(): K[] {
    return this.inner.keys().filter((k) => {
      const e = (this.inner as any).map.get(k) as Entry<V> | undefined;
      return e !== undefined && e.expiresAt > this.now();
    });
  }
}
