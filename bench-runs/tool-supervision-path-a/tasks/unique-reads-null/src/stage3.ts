export function transform(rows: string[]): string[] {
  return rows.map((s) => s.replace(/[^a-z0-9-]+/g, "-"));
}
