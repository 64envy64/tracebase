/**
 * Phase D.2 — applicability-reranker shadow comparison, end to end.
 *
 * Verifies the server WIRING: the reranker runs ONLY in shadow (off is
 * byte-identical — no event, no summary), after candidate generation, bounded by
 * a strict timeout, failing open to the unchanged V4 decision. The headline: a
 * strong prose-only query that V4 ABSTAINS on (one corroborating field) is ruled
 * `applicable` by the reranker — a shadow recall recovery — without changing what
 * is served.
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import { BlockServer } from "../../src/core/block-serving.js";
import { importPatternsFromJsonl } from "../../src/ingest/import-patterns.js";
import { PATTERN_DTO_SCHEMA_VERSION as V } from "../../src/ingest/pattern-dto.js";
import { DeterministicLocalProvider } from "../../src/core/deterministic-local-provider.js";
import type { ApplicabilityProvider, ApplicabilityResult } from "../../src/core/applicability-reranker.js";
import type { ReasoningApplicabilityComparisonEvent } from "../../src/types.js";

const ACC = {
  s: "a running balance is off by a tiny fraction",
  m: "summing many floating point values accumulates rounding error because each addition discards low order bits so the order of operations changes the result",
  u: "accumulate with compensated kahan summation or sum in integer cents to avoid floating point rounding drift",
};
const EQ = {
  s: "two computed quantities that should match are treated as different",
  m: "comparing floating point results with strict equality fails because the same mathematical value has more than one bit representation after rounding",
  u: "compare with a tolerance epsilon instead of strict equality or use a decimal type",
};
const mk = (p: typeof ACC, ref: string) =>
  JSON.stringify({
    schemaVersion: V,
    pattern: { situation: p.s, mechanism: p.m, unlock: p.u, verification: "re-run" },
    scope: { language: "general" },
    signals: { tags: [ref] },
    provenance: { sourceType: "import", sourceRef: `t:${ref}`, capturedAt: 1, captureVersion: "t" },
  });

function freshStore(): { store: BlockStore; accId: string } {
  const store = new BlockStore(new Database(":memory:"));
  const sum = importPatternsFromJsonl(store, [mk(ACC, "float-acc"), mk(EQ, "float-eq")].join("\n"), { now: 1 });
  return { store, accId: sum.results[0]!.blockId! };
}

// Strong MECHANISM-only prose (no remediation words) → V4 sees one field and
// abstains; the reranker's strong-single-field-contrastive rule rules applicable.
const STRONG_MECH = "each addition accumulates rounding error and discards the low order bits as the running summation grows so the result changes with the order of operations";

function applEvents(store: BlockStore): ReasoningApplicabilityComparisonEvent[] {
  return store.readEvents({}).filter((e) => e.event === "reasoning.applicability_comparison") as ReasoningApplicabilityComparisonEvent[];
}
function shadowServer(store: BlockStore, extra: Record<string, unknown> = {}): BlockServer {
  return new BlockServer(store, { gateThreshold: 0, servingMode: "v2-family", retrievalMode: "on", retrievalProvider: new DeterministicLocalProvider(), applicabilityMode: "shadow", ...extra });
}

class SlowReranker implements ApplicabilityProvider {
  readonly name = "slow-reranker";
  readonly featureVersion = 1;
  rank(): Promise<ApplicabilityResult[] | null> {
    return new Promise((res) => setTimeout(() => res([]), 40));
  }
}

describe("phase-d.2 applicability reranker shadow", () => {
  it("default off: never runs — no summary, no event (byte-identical serving)", async () => {
    const { store } = freshStore();
    const server = new BlockServer(store, { gateThreshold: 0, servingMode: "v2-family", retrievalMode: "on", retrievalProvider: new DeterministicLocalProvider() });
    expect(server.applicabilityRollout).toBe("off");
    const summary = await server.emitApplicabilityComparison({ text: STRONG_MECH }, "q1");
    expect(summary).toBeUndefined();
    expect(applEvents(store).length).toBe(0);
    store.close();
  });

  it("rules a strong prose-only query APPLICABLE where V4 abstains (shadow recall recovery)", async () => {
    const { store, accId } = freshStore();
    const summary = await shadowServer(store).emitApplicabilityComparison({ text: STRONG_MECH }, "q2");
    expect(summary).toBeDefined();
    expect(summary!.v4Action).toBe("abstain"); // V4 needs >=2 fields → abstains on one strong field
    expect(summary!.verdict).toBe("applicable");
    expect(summary!.topBlockId).toBe(accId);
    expect(summary!.changedDecision).toBe("reranker_only_apply");

    const e = applEvents(store)[0]!;
    expect(e.v4Action).toBe("abstain");
    expect(e.applicabilityVerdict).toBe("applicable");
    expect(e.applicabilityProvider).toBe("deterministic-applicability.v1");
    expect(e.fallback).toBe("none");
    store.close();
  });

  it("the comparison event carries no raw query/body/path/token text", async () => {
    const { store } = freshStore();
    await shadowServer(store).emitApplicabilityComparison({ text: STRONG_MECH }, "q3");
    const s = JSON.stringify(applEvents(store));
    expect(s).not.toContain("accumulates"); // no raw prose
    expect(s).not.toContain("kahan"); // no raw body
    store.close();
  });

  it("fails open on reranker timeout (fallback=timeout, never throws)", async () => {
    const { store } = freshStore();
    const server = shadowServer(store, { applicabilityProvider: new SlowReranker(), applicabilityDeadlineMs: 1 });
    const summary = await server.emitApplicabilityComparison({ text: STRONG_MECH }, "q4");
    expect(summary).toBeDefined();
    expect(summary!.fallback).toBe("timeout");
    expect(summary!.verdict).toBe("none");
    store.close();
  });

  it("shadow reranker does not alter the served decision (parity)", async () => {
    const { store } = freshStore();
    const served = new BlockServer(store, { gateThreshold: 0, servingMode: "v2-family", retrievalMode: "on", retrievalProvider: new DeterministicLocalProvider(), emitEvents: false });
    const shadowed = shadowServer(store, { emitEvents: false });
    const a = await served.recallHybrid({ text: STRONG_MECH });
    const b = await shadowed.recallHybrid({ text: STRONG_MECH });
    expect(b.shouldInject).toBe(a.shouldInject);
    expect(b.blocks.filter((h) => h.passesGate).map((h) => h.block.id)).toEqual(a.blocks.filter((h) => h.passesGate).map((h) => h.block.id));
    store.close();
  });

  it("is deterministic: identical query on the same corpus → identical summary", async () => {
    const { store } = freshStore();
    const server = shadowServer(store, { emitEvents: false });
    const sa = await server.emitApplicabilityComparison({ text: STRONG_MECH }, "qa");
    const sb = await server.emitApplicabilityComparison({ text: STRONG_MECH }, "qb");
    expect(sa).toEqual(sb); // same corpus → same block ids, verdict, changed-decision
    store.close();
  });
});
