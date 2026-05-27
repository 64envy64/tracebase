/**
 * Merge sort implementation.
 * Returns a new sorted array (ascending order).
 */
export function mergeSort(arr: number[]): number[] {
  if (arr.length <= 1) return [...arr];

  const mid = Math.floor(arr.length / 2);
  const left = mergeSort(arr.slice(0, mid));
  const right = mergeSort(arr.slice(mid));

  return merge(left, right);
}

/**
 * Merges two sorted arrays into one sorted array.
 */
function merge(left: number[], right: number[]): number[] {
  const result: number[] = [];
  let i = 0;
  let j = 0;

  while (i < left.length && j < right.length) {
    if (left[i] <= right[j]) {
      result.push(left[i]);
      i++;
    } else {
      result.push(right[j]);
      j++;
    }
  }

  while (i < left.length) {
    result.push(left[i]);
    i++;
  }

  while (j < right.length) {
    result.push(right[j]);
    j++;
  }

  return result;
}

/**
 * Checks whether an array is sorted in non-descending order.
 */
export function isSorted(arr: number[]): boolean {
  for (let k = 1; k < arr.length; k++) {
    if (arr[k] < arr[k - 1]) return false;
  }
  return true;
}
