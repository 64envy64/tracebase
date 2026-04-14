import { describe, it, expect } from 'vitest';
import { mergeSort, isSorted } from './source';

describe('mergeSort', () => {
  it('sorts a simple unsorted array', () => {
    expect(mergeSort([3, 1, 2])).toEqual([1, 2, 3]);
  });

  it('handles an already sorted array', () => {
    expect(mergeSort([1, 2, 3, 4])).toEqual([1, 2, 3, 4]);
  });

  it('handles an array with all duplicate values', () => {
    expect(mergeSort([5, 5, 5, 5])).toEqual([5, 5, 5, 5]);
  });

  it('is stable: preserves count of duplicate elements', () => {
    const input = [4, 2, 4, 1, 2, 4];
    const sorted = mergeSort(input);
    expect(sorted).toEqual([1, 2, 2, 4, 4, 4]);
    expect(sorted.length).toBe(input.length);
  });

  it('preserves all elements when duplicates span the split boundary', () => {
    // With 6 elements, mid = 3 → left = [3,3,3], right = [3,1,2]
    // The merge must keep all four 3s.
    const input = [3, 3, 3, 3, 1, 2];
    const sorted = mergeSort(input);
    expect(sorted).toEqual([1, 2, 3, 3, 3, 3]);
    expect(isSorted(sorted)).toBe(true);
  });
});
