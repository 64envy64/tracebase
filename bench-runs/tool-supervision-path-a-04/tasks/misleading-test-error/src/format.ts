import { parseAmount } from "./parser.js";

/**
 * Format a freeform amount string as `$NN.NN`. Wraps the parser
 * with a fixed-2-decimal renderer; precision is the parser's job.
 */
export function formatAmount(s: string): string {
  const n = parseAmount(s);
  return `$${n.toFixed(2)}`;
}
