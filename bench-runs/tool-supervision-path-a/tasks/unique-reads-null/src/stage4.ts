export function emit(rows: string[]): string[] {
  return rows.map((s) => `event:${s}`);
}
