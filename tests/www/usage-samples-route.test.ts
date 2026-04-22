/**
 * Schema-guard regression for POST /api/control-plane/usage-samples.
 *
 * Phase 1E.5 locks the ingest side: bad metrics payloads are rejected
 * at the route, not silently stored and then dropped out of the
 * dashboard read. The route file must:
 *   - import `parseUsageMetrics` from the shared module, so ingest
 *     and dashboard read use the same schema gate;
 *   - return 400 when the parse fails, before the store.upsert
 *     call — otherwise malformed rows reach Postgres.
 *
 * Textual check (vitest runs from root, Next route handlers are
 * non-trivial to stand up). Catches regressions that remove the
 * gate or route the call around it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROUTE_PATH = resolve(
  __dirname,
  "../../www/src/app/api/control-plane/usage-samples/route.ts",
);

const source = readFileSync(ROUTE_PATH, "utf-8");

describe("POST /api/control-plane/usage-samples — schema guard", () => {
  it("imports parseUsageMetrics from the shared usage module", () => {
    expect(source).toMatch(
      /import\s+\{[^}]*parseUsageMetrics[^}]*\}\s+from\s+"@\/lib\/control-plane\/usage"/,
    );
  });

  it("rejects invalid metrics payloads with a 400 before reaching the store", () => {
    // Gate must exist.
    expect(source).toContain("parseUsageMetrics(body.metrics)");
    expect(source).toContain(
      "metrics payload failed UsageMetrics schema validation",
    );
    // And it must run before the upsert — source order check is
    // enough for this tiny file.
    const gateIdx = source.indexOf("metrics payload failed UsageMetrics schema");
    const upsertIdx = source.indexOf("store.upsertUsageSample");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(upsertIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(upsertIdx);
  });
});
