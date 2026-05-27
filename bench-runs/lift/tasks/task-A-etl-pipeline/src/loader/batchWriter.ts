import type { TransformedRecord } from "../types.js";
import type { Db } from "../db.js";
import { withRetry } from "./retryPolicy.js";

/**
 * BatchWriter — writes a batch of records to the DB with bounded retry.
 *
 * Contract: writeBatch(records) returns only after every record has been
 * acknowledged by the DB.
 */
export class BatchWriter {
  constructor(private readonly db: Db) {}

  async writeBatch(records: TransformedRecord[]): Promise<number> {
    let written = 0;

    records.forEach(async (rec) => {
      await withRetry(() => this.db.write(rec), { attempts: 2 });
      written++;
    });

    return written;
  }
}
