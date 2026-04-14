interface CacheNode<K, V> {
  key: K;
  value: V;
  prev: CacheNode<K, V> | null;
  next: CacheNode<K, V> | null;
}

/**
 * Least-Recently-Used cache with O(1) get and put.
 */
export class LRUCache<K, V> {
  private capacity: number;
  private map: Map<K, CacheNode<K, V>> = new Map();
  private head: CacheNode<K, V> | null = null; // most recent
  private tail: CacheNode<K, V> | null = null; // least recent

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  get(key: K): V | undefined {
    const node = this.map.get(key);
    if (!node) return undefined;
    return node.value;
  }

  put(key: K, value: V): void {
    if (this.map.has(key)) {
      const node = this.map.get(key)!;
      node.value = value;
      this.moveToFront(node);
      return;
    }

    const newNode: CacheNode<K, V> = { key, value, prev: null, next: null };

    if (this.map.size >= this.capacity) {
      this.evictLRU();
    }

    this.addToFront(newNode);
    this.map.set(key, newNode);
  }

  size(): number {
    return this.map.size;
  }

  private addToFront(node: CacheNode<K, V>): void {
    node.next = this.head;
    node.prev = null;
    if (this.head) this.head.prev = node;
    this.head = node;
    if (!this.tail) this.tail = node;
  }

  private removeNode(node: CacheNode<K, V>): void {
    if (node.prev) node.prev.next = node.next;
    else this.head = node.next;
    if (node.next) node.next.prev = node.prev;
    else this.tail = node.prev;
  }

  private moveToFront(node: CacheNode<K, V>): void {
    this.removeNode(node);
    this.addToFront(node);
  }

  private evictLRU(): void {
    if (!this.tail) return;
    this.map.delete(this.tail.key);
    this.removeNode(this.tail);
  }
}
