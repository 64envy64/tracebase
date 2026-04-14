import { describe, it, expect } from 'vitest';
import { binarySearch } from './source';

describe('binarySearch', () => {
  it('finds an element in the middle of the array', () => {
    expect(binarySearch([1, 3, 5, 7, 9], 5)).toBe(2);
  });

  it('finds the first element', () => {
    expect(binarySearch([10, 20, 30, 40, 50], 10)).toBe(0);
  });

  it('finds the last element in the array', () => {
    expect(binarySearch([2, 4, 6, 8, 10], 10)).toBe(4);
  });

  it('returns -1 for a missing element', () => {
    expect(binarySearch([1, 2, 3, 4, 5], 6)).toBe(-1);
  });

  it('finds the only element in a single-element array', () => {
    expect(binarySearch([42], 42)).toBe(0);
  });
});
