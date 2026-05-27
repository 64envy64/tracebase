import type { TransformedRecord } from "./types.js";

/**
 * Fake async DB. write() simulates a small async I/O.
 * Backing store is plain Map; size() returns the count of persisted rows.
 */
export class Db {
  private store: Map<string, TransformedRecord> = new Map();

  async write(rec: TransformedRecord): Promise<void> {
    await new Promise((r) => setTimeout(r, 4));
    this.store.set(rec.id, rec);
  }

  size(): number {
    return this.store.size;
  }

  has(id: string): boolean {
    return this.store.has(id);
  }
}
