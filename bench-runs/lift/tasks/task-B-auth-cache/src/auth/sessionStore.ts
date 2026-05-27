import { LRUCache } from "../cache/lruCache.js";
import { Clock } from "../util/clock.js";

export interface SessionRecord {
  sid: string;
  userId: string;
  roles: string[];
  lastSeen: number;
}

/**
 * SessionStore — typed façade over the LRU cache.
 *
 * Capacity is bounded; the cache evicts least-recently-used entries.
 * `lookup(sid)` is the hot-path read called by the auth middleware on
 * every authenticated request and MUST refresh recency.
 */
export class SessionStore {
  private cache: LRUCache<SessionRecord>;
  constructor(capacity: number, private readonly clock: Clock = new Clock()) {
    this.cache = new LRUCache(capacity);
  }

  create(sid: string, userId: string, roles: string[]): SessionRecord {
    const rec: SessionRecord = { sid, userId, roles, lastSeen: this.clock.now() };
    this.cache.set(sid, rec);
    return rec;
  }

  lookup(sid: string): SessionRecord | null {
    const rec = this.cache.get(sid);
    if (!rec) return null;
    rec.lastSeen = this.clock.now();
    return rec;
  }

  has(sid: string): boolean { return this.cache.has(sid); }
  size(): number { return this.cache.size(); }
}
