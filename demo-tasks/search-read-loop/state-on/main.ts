// on-variant final state: TraceBase recalled the off-by-one pattern,
// agent went straight to main.ts and applied the fix.
export function findIndex<T>(arr: T[], target: T): number {
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] === target) return i;
  }
  return -1;
}
