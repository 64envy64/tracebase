/**
 * Pull a numeric amount out of a freeform string and return it as a number.
 *
 *   parseAmount("42")     === 42
 *   parseAmount("3.14")   === 3.14
 *   parseAmount("USD 9.99 paid")  === 9.99
 */
export function parseAmount(s: string): number {
  const m = s.match(/(\d+)/);
  return m ? Number(m[1]) : 0;
}
