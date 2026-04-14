/**
 * Binary search implementation.
 * Returns the index of `target` in a sorted array, or -1 if not found.
 */
export function binarySearch(arr: number[], target: number): number {
  let lo = 0;
  let hi = arr.length - 1;

  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);

    if (arr[mid] === target) {
      return mid;
    } else if (arr[mid] < target) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return -1;
}

/**
 * Finds the insertion index for `target` in a sorted array
 * using binary search.
 */
export function findInsertionIndex(arr: number[], target: number): number {
  let lo = 0;
  let hi = arr.length;

  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (arr[mid] < target) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  return lo;
}
