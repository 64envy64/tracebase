import { describe, it, expect } from 'vitest';
import { deepClone } from './source';

describe('deepClone', () => {
  it('clones a simple nested object', () => {
    const obj = { a: 1, b: { c: 2 } };
    const cloned = deepClone(obj);
    expect(cloned).toEqual(obj);
    expect(cloned).not.toBe(obj);
    expect(cloned.b).not.toBe(obj.b);
  });

  it('clones arrays and nested arrays', () => {
    const arr = [1, [2, 3], { x: [4] }];
    const cloned = deepClone(arr);
    expect(cloned).toEqual(arr);
    expect(cloned[1]).not.toBe(arr[1]);
  });

  it('clones Date objects preserving their time value', () => {
    const obj = { created: new Date('2025-01-15T10:30:00Z'), name: 'test' };
    const cloned = deepClone(obj);
    expect(cloned.created).toBeInstanceOf(Date);
    expect(cloned.created.getTime()).toBe(obj.created.getTime());
    expect(cloned.created).not.toBe(obj.created);
  });

  it('handles objects with circular references without infinite recursion', () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;

    const cloned = deepClone(obj);
    expect(cloned.a).toBe(1);
    expect(cloned.self).toBe(cloned); // circular ref points to the clone
  });

  it('handles primitives and null', () => {
    expect(deepClone(42)).toBe(42);
    expect(deepClone('hello')).toBe('hello');
    expect(deepClone(null)).toBe(null);
    expect(deepClone(true)).toBe(true);
  });
});
