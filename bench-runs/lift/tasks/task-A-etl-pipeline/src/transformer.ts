import type { RawRecord, TransformedRecord } from "./types.js";

/**
 * Transformer — normalises raw records. Pure / synchronous.
 */
export class Transformer {
  constructor(private readonly now: () => number = Date.now) {}

  transformAll(raw: RawRecord[]): TransformedRecord[] {
    return raw.map((r) => ({
      id: r.id,
      normalized: r.raw.trim().toLowerCase(),
      ts: this.now(),
    }));
  }
}
