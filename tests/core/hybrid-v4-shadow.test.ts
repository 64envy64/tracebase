/**
 * Phase C.3 — hybrid retrieval + ServingEvidenceV4 contrastive shadow, end to end.
 *
 * Verifies the server WIRING: V4 is computed in shadow alongside V3, surfaced on
 * `shadowV4` + the local-only comparison event, never served, fail-open, and
 * privacy-safe. The headline: a same-domain sibling collision that V3 licenses
 * is ABSTAINED by V4's contrastive gap, while a discriminative paraphrase still
 * licenses. (Metric tables live in the frozen eval; this guards the plumbing.)
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import { BlockServer } from "../../src/core/block-serving.js";
import { importPatternsFromJsonl } from "../../src/ingest/import-patterns.js";
import { PATTERN_DTO_SCHEMA_VERSION as V } from "../../src/ingest/pattern-dto.js";
import { DeterministicLocalProvider } from "../../src/core/deterministic-local-provider.js";
import type { ReasoningEvidenceComparisonEvent } from "../../src/types.js";

// Same-domain numeric siblings: accumulation drift vs equality comparison.
const ACC = {
  s: "a running total disagrees with the expected sum by a tiny amount",
  m: "summing many floating point values accumulates rounding error because each addition discards low order bits so the order of operations changes the result",
  u: "accumulate with compensated kahan summation or sum in integer cents to avoid floating point rounding drift",
};
const EQ = {
  s: "two computed numbers that should be equal compare as different",
  m: "comparing floating point results with strict equality fails because the same mathematical value has more than one bit representation after rounding",
  u: "compare with a tolerance epsilon instead of strict equality or use a decimal type for exact representation",
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
  const summary = importPatternsFromJsonl(store, [mk(ACC, "float-acc"), mk(EQ, "float-eq")].join("\n"), { now: 1 });
  return { store, accId: summary.results[0]!.blockId! };
}

// A genuine accumulation paraphrase (matches ACC on UNIQUE tokens).
const TRUE_ACC = "rounding error accumulates across a long floating point summation so the order of additions changes the result";
// A same-domain COLLISION: shares only generic float vocabulary, different problem.
const COLLISION = "a slider snaps to coarse steps because the floating point value is rounded to one decimal place purely for display";

function evidenceEvents(store: BlockStore): ReasoningEvidenceComparisonEvent[] {
  return store.readEvents({}).filter((e) => e.event === "reasoning.evidence_comparison") as ReasoningEvidenceComparisonEvent[];
}

function shadowServer(store: BlockStore, extra: Record<string, unknown> = {}): BlockServer {
  return new BlockServer(store, { gateThreshold: 0, servingMode: "v2-family", retrievalMode: "on", retrievalProvider: new DeterministicLocalProvider(), evidenceMode: "shadow", ...extra });
}

describe("phase-c.3 hybrid + V4 contrastive shadow", () => {
  it("default evidence mode off: no shadowV4, no comparison events", async () => {
    const { store } = freshStore();
    const server = new BlockServer(store, { gateThreshold: 0, servingMode: "v2-family", retrievalMode: "on", retrievalProvider: new DeterministicLocalProvider() });
    const r = await server.recallHybrid({ text: TRUE_ACC });
    expect(r.shadowV4).toBeUndefined();
    expect(evidenceEvents(store).length).toBe(0);
    store.close();
  });

  it("V4 abstains on the same-domain collision that V3 licenses (contrastive gap)", async () => {
    const { store } = freshStore();
    const r = await shadowServer(store).recallHybrid({ text: COLLISION });
    expect(r.shadowV3).toBeDefined();
    expect(r.shadowV4).toBeDefined();
    // V3 (absolute corroboration) licenses; V4 (contrastive) abstains.
    expect(r.shadowV3!.action).toBe("inject");
    expect(r.shadowV4!.action).toBe("abstain");
    expect(["ambiguous-sibling", "no-competitor", "no-family-separation"]).toContain(r.shadowV4!.licenseReason);

    const e = evidenceEvents(store)[0]!;
    expect(e.v3Action).toBe("inject");
    expect(e.v4Action).toBe("abstain");
    expect(typeof e.v4LicenseReason).toBe("string");
    expect(e.v4LicensedCandidates).toBe(0); // nothing contrastively licensed
    store.close();
  });

  it("V4 still licenses a discriminative paraphrase (recall retained)", async () => {
    const { store, accId } = freshStore();
    const r = await shadowServer(store).recallHybrid({ text: TRUE_ACC });
    expect(r.shadowV4!.action).toBe("inject");
    expect(r.shadowV4!.topBlockId).toBe(accId);
    expect(r.shadowV4!.lane).toBe("semantic-license");
    expect(r.shadowV4!.licenseReason).toBe("structured-corroborated");
    expect(r.shadowV4!.discriminativeSupport!).toBeGreaterThanOrEqual(0.5);
    expect(r.shadowV4!.hasCompetitor).toBe(true);
    store.close();
  });

  it("the comparison event carries no raw query/body/path", async () => {
    const { store } = freshStore();
    await shadowServer(store).recallHybrid({ text: COLLISION });
    const s = JSON.stringify(evidenceEvents(store));
    expect(s).not.toContain("slider snaps"); // no raw query
    expect(s).not.toContain("kahan"); // no raw body
    store.close();
  });

  it("shadow V4 does not alter the served V2 decision (parity)", async () => {
    const { store } = freshStore();
    const served = new BlockServer(store, { gateThreshold: 0, servingMode: "v2-family", retrievalMode: "on", retrievalProvider: new DeterministicLocalProvider(), emitEvents: false });
    const shadowed = shadowServer(store, { emitEvents: false });
    const a = await served.recallHybrid({ text: TRUE_ACC });
    const b = await shadowed.recallHybrid({ text: TRUE_ACC });
    expect(b.shouldInject).toBe(a.shouldInject);
    expect(b.blocks.filter((h) => h.passesGate).map((h) => h.block.id)).toEqual(a.blocks.filter((h) => h.passesGate).map((h) => h.block.id));
    store.close();
  });
});
