import { describe, it, expect } from "vitest";
import { Pipeline } from "../src/pipeline.js";
import type { RawRecord } from "../src/types.js";

function source(n: number) {
  return async (): Promise<RawRecord[]> =>
    Array.from({ length: n }, (_, i) => ({ id: `r-${i}`, raw: `RAW-${i}` }));
}

describe("Pipeline.run", () => {
  it("persists every fetched record to the DB before returning", async () => {
    const p = new Pipeline(source(5));
    const report = await p.run();
    expect(report.fetched).toBe(5);
    expect(p.db.size()).toBe(5);
  });

  it("reports a written count that matches the DB state", async () => {
    const p = new Pipeline(source(10));
    const report = await p.run();
    expect(report.written).toBe(report.transformed);
    expect(report.written).toBe(p.db.size());
  });

  it("persists every record id (deterministic check)", async () => {
    const p = new Pipeline(source(4));
    await p.run();
    for (let i = 0; i < 4; i++) {
      expect(p.db.has(`r-${i}`)).toBe(true);
    }
  });
});
