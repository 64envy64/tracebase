/**
 * Pull the first numeric token (integer OR decimal) out of a string.
 *
 *   parseNum("hello 42 world")    === 42
 *   parseNum("price: 9.99 USD")   === 9.99
 *   parseNum("no number here")    === null
 */
export function parseNum(s: string): number | null {
  const m = s.match(/(\d+)/);
  return m ? Number(m[1]) : null;
}
