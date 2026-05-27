import type { RawRecord, PipelineReport } from "./types.js";
import { Ingester } from "./ingester.js";
import { Transformer } from "./transformer.js";
import { Loader } from "./loader/loader.js";
import { Db } from "./db.js";

/**
 * Pipeline — orchestrates ingester → transformer → loader.
 *
 * `run()` returns a report. The report counts MUST match the actual
 * state of the DB after the call resolves.
 */
export class Pipeline {
  public readonly db: Db;
  private ingester: Ingester;
  private transformer: Transformer;
  private loader: Loader;

  constructor(source: () => Promise<RawRecord[]>) {
    this.db = new Db();
    this.ingester = new Ingester(source);
    this.transformer = new Transformer();
    this.loader = new Loader(this.db);
  }

  async run(): Promise<PipelineReport> {
    const raw = await this.ingester.fetch();
    const transformed = this.transformer.transformAll(raw);
    const written = await this.loader.load(transformed);
    return {
      fetched: raw.length,
      transformed: transformed.length,
      written,
    };
  }
}
