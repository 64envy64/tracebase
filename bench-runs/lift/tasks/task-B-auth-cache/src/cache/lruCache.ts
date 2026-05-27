import type { CacheStats } from "./types.js";

/**
 * Bounded LRU cache, doubly-linked list + map.
 *
 * Contract:
 *   - get(k) refreshes recency (entry moves to MRU on access).
 *   - set(k, v) inserts/refreshes and evicts the LRU when over capacity.
 */
interface Node<V> { key: string; value: V; prev: Node<V> | null; next: Node<V> | null; }

export class LRUCache<V> {
  private head: Node<V> | null = null;
  private tail: Node<V> | null = null;
  private map = new Map<string, Node<V>>();
  public stats: CacheStats = { hits: 0, misses: 0, evictions: 0 };

  constructor(public readonly capacity: number) {}

  get(key: string): V | undefined {
    const n = this.map.get(key);
    if (!n) {
      this.stats.misses++;
      return undefined;
    }
    this.stats.hits++;
    return n.value;
  }

  set(key: string, value: V): void {
    const existing = this.map.get(key);
    if (existing) {
      existing.value = value;
      this.touch(existing);
      return;
    }
    const n: Node<V> = { key, value, prev: null, next: this.head };
    if (this.head) this.head.prev = n;
    this.head = n;
    if (!this.tail) this.tail = n;
    this.map.set(key, n);
    if (this.map.size > this.capacity) this.evictLRU();
  }

  has(key: string): boolean { return this.map.has(key); }
  size(): number { return this.map.size; }

  private touch(n: Node<V>): void {
    if (n === this.head) return;
    if (n.prev) n.prev.next = n.next;
    if (n.next) n.next.prev = n.prev;
    if (n === this.tail) this.tail = n.prev;
    n.prev = null;
    n.next = this.head;
    if (this.head) this.head.prev = n;
    this.head = n;
  }

  private evictLRU(): void {
    if (!this.tail) return;
    const t = this.tail;
    if (t.prev) t.prev.next = null;
    this.tail = t.prev;
    if (this.head === t) this.head = null;
    this.map.delete(t.key);
    this.stats.evictions++;
  }
}
