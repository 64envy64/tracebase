import type { RawRecord } from "./types.js";

/**
 * Ingester — pulls a page of raw records from the upstream source.
 * The actual upstream is mocked by the caller (constructor injection).
 */
export class Ingester {
  constructor(private readonly source: () => Promise<RawRecord[]>) {}

  async fetch(): Promise<RawRecord[]> {
    const rows = await this.source();
    return [...rows];
  }
}
