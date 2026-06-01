/**
 * Phase D.1 — two-view query-compiler shadow comparison, end to end.
 *
 * Verifies the server WIRING: the compiler runs ONLY in shadow (off is
 * byte-identical — no compile, no event, no summary), builds the three candidate
 * slates (sparse / literal-hybrid / literal+causal) with the causal lane
 * cascade-gated, adjudicates each with shadow V4, and emits a privacy-safe
 * local-only event. The headline: a symbol-heavy causal query that the sparse
 * and literal arms abstain on is INJECTED by the causal arm.
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import { BlockServer } from "../../src/core/block-serving.js";
import { importPatternsFromJsonl } from "../../src/ingest/import-patterns.js";
import { PATTERN_DTO_SCHEMA_VERSION as V } from "../../src/ingest/pattern-dto.js";
import { DeterministicLocalProvider } from "../../src/core/deterministic-local-provider.js";
import type { RetrievalProvider, RetrievalCandidate } from "../../src/core/retrieval-provider.js";
import type { ReasoningQueryCompilerComparisonEvent } from "../../src/types.js";

// Same-domain numeric siblings (so V4's contrastive gate can license the right one).
const ACC = {
  s: "a running total disagrees with the expected amount by a tiny bit",
  m: "summing many floating point values accumulates rounding error because each addition discards low order bits so the order of operations changes the result",
  u: "accumulate with compensated kahan summation or sum in integer cents to avoid floating point rounding drift",
};
const EQ = {
  s: "two computed numbers that should be equal are treated as different",
  m: "comparing floating point results with strict equality fails because the same mathematical value has more than one bit representation after rounding",
  u: "compare with a tolerance epsilon instead of strict equality or use a decimal type for an exact representation",
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

// Symbol-heavy causal query: the mechanism prose (accumulates/rounding/summation)
// is buried under identifiers (FloatMath.sum(), src/calc/total.ts) that the
// literal lane routes away from the body match.
const SYMBOL_CAUSAL = "Accumulator.fold() in src/calc/engine.ts gives the wrong total because each addition accumulates rounding error and discards low order bits so we should switch to kahan summation or integer cents to avoid the drift";

function compilerEvents(store: BlockStore): ReasoningQueryCompilerComparisonEvent[] {
  return store.readEvents({}).filter((e) => e.event === "reasoning.query_compiler_comparison") as ReasoningQueryCompilerComparisonEvent[];
}
function shadowServer(store: BlockStore, extra: Record<string, unknown> = {}): BlockServer {
  return new BlockServer(store, { gateThreshold: 0, servingMode: "v2-family", retrievalMode: "on", retrievalProvider: new DeterministicLocalProvider(), queryCompilerMode: "shadow", ...extra });
}

class ThrowingProvider implements RetrievalProvider {
  readonly name = "throwing";
  readonly capabilities = { location: "local", payload: "sanitized-text", explicitOptIn: false } as const;
  retrieve(): Promise<RetrievalCandidate[] | null> {
    throw new Error("boom");
  }
}

describe("phase-d.1 query-compiler shadow", () => {
  it("default off: never compiles — no summary, no event (byte-identical path)", async () => {
    const { store } = freshStore();
    const server = new BlockServer(store, { gateThreshold: 0, servingMode: "v2-family", retrievalMode: "on", retrievalProvider: new DeterministicLocalProvider() });
    expect(server.queryCompilerRollout).toBe("off");
    const summary = await server.emitQueryCompilerComparison({ text: SYMBOL_CAUSAL }, "q1");
    expect(summary).toBeUndefined();
    expect(compilerEvents(store).length).toBe(0);
    store.close();
  });

  it("the causal arm injects a symbol-heavy query the sparse + literal arms abstain on", async () => {
    const { store, accId } = freshStore();
    const summary = await shadowServer(store).emitQueryCompilerComparison({ text: SYMBOL_CAUSAL }, "q2");
    expect(summary).toBeDefined();
    expect(summary!.sparseAction).toBe("abstain");
    expect(summary!.literalAction).toBe("abstain");
    expect(summary!.causalAction).toBe("inject");
    expect(summary!.causalLaneInvoked).toBe(true); // cascade ran the causal lane
    expect(summary!.causalAddedDecision).toBe(true);

    const evs = compilerEvents(store);
    expect(evs.length).toBe(1);
    const e = evs[0]!;
    expect(e.causalV4Action).toBe("inject");
    expect(e.causalV4TopBlockId).toBe(accId);
    expect(e.causalSemanticOnly).toBeGreaterThanOrEqual(1);
    expect(e.literalViewHash).toMatch(/^q_/);
    expect(e.causalViewHash).toMatch(/^q_/);
    store.close();
  });

  it("the comparison event carries no raw query/body/path/token text", async () => {
    const { store } = freshStore();
    await shadowServer(store).emitQueryCompilerComparison({ text: SYMBOL_CAUSAL }, "q3");
    const s = JSON.stringify(compilerEvents(store));
    expect(s).not.toContain("Accumulator"); // no raw symbol
    expect(s).not.toContain("src/calc"); // no raw path-ish symbol
    expect(s).not.toContain("kahan"); // no raw body
    expect(s).not.toContain("accumulates"); // no raw prose
    store.close();
  });

  it("fails open: a throwing provider never breaks the shadow comparison", async () => {
    const { store } = freshStore();
    const server = new BlockServer(store, { gateThreshold: 0, servingMode: "v2-family", retrievalMode: "on", retrievalProvider: new ThrowingProvider(), queryCompilerMode: "shadow" });
    // Must not throw; returns a summary (sparse FTS arm still works) or undefined.
    const summary = await server.emitQueryCompilerComparison({ text: SYMBOL_CAUSAL }, "q4");
    expect(summary === undefined || typeof summary.sparseAction === "string").toBe(true);
    store.close();
  });

  it("is deterministic: identical query → identical view hashes + per-arm actions", async () => {
    const a = freshStore();
    const b = freshStore();
    const sa = await shadowServer(a.store).emitQueryCompilerComparison({ text: SYMBOL_CAUSAL }, "qa");
    const sb = await shadowServer(b.store).emitQueryCompilerComparison({ text: SYMBOL_CAUSAL }, "qb");
    const ea = compilerEvents(a.store)[0]!;
    const eb = compilerEvents(b.store)[0]!;
    expect(ea.literalViewHash).toBe(eb.literalViewHash);
    expect(ea.causalViewHash).toBe(eb.causalViewHash);
    expect(sa).toEqual(sb);
    a.store.close();
    b.store.close();
  });
});
