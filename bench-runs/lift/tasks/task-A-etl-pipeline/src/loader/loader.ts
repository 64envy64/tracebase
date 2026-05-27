import type { TransformedRecord } from "../types.js";
import type { Db } from "../db.js";
import { BatchWriter } from "./batchWriter.js";

/**
 * Loader — top-level loader facade. Wraps the BatchWriter and exposes a
 * single `load()` entry point.
 */
export class Loader {
  private writer: BatchWriter;
  constructor(db: Db) {
    this.writer = new BatchWriter(db);
  }

  async load(records: TransformedRecord[]): Promise<number> {
    return this.writer.writeBatch(records);
  }
}
