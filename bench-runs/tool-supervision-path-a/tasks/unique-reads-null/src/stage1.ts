export function normalize(rows: Array<{ raw: string }>): string[] {
  return rows.map((r) => r.raw.trim().toLowerCase()).filter((s) => s.length > 0);
}
