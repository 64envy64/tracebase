// off-variant final state: agent ran without TraceBase, did not
// localize the bug. The off-by-one in arr[i + 1] is still here.
export function findIndex<T>(arr: T[], target: T): number {
  for (let i = 0; i < arr.length; i++) {
    if (arr[i + 1] === target) return i;
  }
  return -1;
}
