import { describe, it, expect } from 'vitest';
import { LRUCache } from './source';

describe('LRUCache', () => {
  it('stores and retrieves values', () => {
    const cache = new LRUCache<string, number>(3);
    cache.put('a', 1);
    cache.put('b', 2);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBe(2);
  });

  it('evicts the least recently used item when capacity is exceeded', () => {
    const cache = new LRUCache<string, number>(2);
    cache.put('a', 1);
    cache.put('b', 2);
    cache.put('c', 3); // should evict 'a'
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
  });

  it('get() refreshes an item so it is NOT evicted next', () => {
    const cache = new LRUCache<string, number>(2);
    cache.put('a', 1);
    cache.put('b', 2);
    cache.get('a');      // access 'a' — now 'b' is least recent
    cache.put('c', 3);   // should evict 'b', NOT 'a'
    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
  });

  it('handles capacity of 1', () => {
    const cache = new LRUCache<string, string>(1);
    cache.put('x', 'hello');
    cache.put('y', 'world');
    expect(cache.get('x')).toBeUndefined();
    expect(cache.get('y')).toBe('world');
  });

  it('updates value on duplicate put without changing size', () => {
    const cache = new LRUCache<string, number>(2);
    cache.put('a', 1);
    cache.put('b', 2);
    cache.put('a', 99);
    expect(cache.get('a')).toBe(99);
    expect(cache.size()).toBe(2);
  });
});
