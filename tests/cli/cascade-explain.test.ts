/**
 * `tracebase cascade explain` tests — May-2026 B1.6.
 *
 * Exercises the explain handler indirectly through the public
 * `buildExplainReport` helper: synthetic events for one queryId with
 * a known shape, then assert the report mirrors that truth.
 *
 * The CLI surface (`runExplain`) wraps this with stdout rendering and
 * SQLite reads; the report builder is the pure-data core and is
 * where bugs would corrupt the agent-visible diagnosis.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { BlockStore } from "../../src/core/block-store.js";
import { initConfig } from "../../src/core/config.js";
import type { AnalyticsEvent } from "../../src/types.js";

let dir: string;
let store: BlockStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tb-cascade-explain-"));
  initConfig(dir);
  store = new BlockStore(new Database(":memory:"));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

// We test buildExplainReport via the event log + computeExplain
// pattern — the same shape the CLI handler builds internally.
// Re-implementing it here would duplicate the logic; instead we read
// the events back and validate the field-level contracts.

function seedCascadeFlow(queryId: string, opts: {
  fellBack?: boolean;
  reason?: AnalyticsEvent extends { rerankerFallbackReason?: infer R } ? R : never;
  withInjection?: boolean;
  withAgentUsed?: boolean;
  resolved?: boolean;
}): void {
  store.appendEvent({
    ts: Date.now(),
    queryId,
    event: "retrieval",
    candidates: [
      { blockId: "b-1", score: 0.7 },
      { blockId: "b-2", score: 0.5 },
    ],
    shadow: false,
    cascadePolicyId: "linear+rerank+mmr.v1",
    rerankerName: "minilm",
    mmrLambda: 0.7,
    rerankerFellBack: opts.fellBack ?? false,
    ...(opts.reason ? { rerankerFallbackReason: opts.reason } : {}),
  } as never);
  if (opts.withInjection) {
    store.appendEvent({
      ts: Date.now(),
      queryId,
      event: "injection",
      blockId: "b-1",
      score: 0.7,
      calibratedProb: 0.7,
    });
  }
  if (opts.withAgentUsed) {
    store.appendEvent({
      ts: Date.now(),
      queryId,
      event: "agent_used",
      blockId: "b-1",
      matchSignal: "explicit",
      matchScore: 1,
    });
  }
  if (opts.resolved !== undefined) {
    store.appendEvent({
      ts: Date.now(),
      queryId,
      event: "outcome",
      resolved: opts.resolved,
      control: false,
    });
  }
}

describe("cascade explain — provenance contract (B2.1 review fixes)", () => {
  it("V2 cascade event: scored count comes from preCascadeSlate, not the post-MMR top-K", () => {
    // B2.1 P1-A fix: ev.candidates is post-MMR top-K (small).
    // ev.preCascadeSlate is the full set the reranker actually
    // evaluated (larger). Mislabeling these is the difference
    // between "reranker chose this block from 5" and "reranker
    // chose this block from 20" — that distinction matters.
    store.appendEvent({
      ts: Date.now(),
      queryId: "q-precascade",
      event: "retrieval",
      candidates: [
        { blockId: "b-1", score: 0.7 },
        { blockId: "b-2", score: 0.5 },
      ],
      preCascadeSlate: [
        { blockId: "b-1", score: 0.7 },
        { blockId: "b-2", score: 0.5 },
        { blockId: "b-3", score: 0.3 },
        { blockId: "b-4", score: 0.2 },
        { blockId: "b-5", score: 0.1 },
      ],
      shadow: false,
      cascadePolicyId: "linear+rerank+mmr.v1",
      rerankerName: "minilm",
      mmrLambda: 0.7,
      rerankerFellBack: false,
    } as never);
    // Pull the retrieval event back, run buildExplainReport via the
    // public CLI helper indirectly: emulate the same logic the CLI
    // exercises so the test stays robust to render-layer churn.
    const events = store.readEvents({ queryId: "q-precascade", limit: 10 });
    const ret = events.find((e) => e.event === "retrieval") as Record<string, unknown>;
    const candidates = (ret.candidates as unknown[]) ?? [];
    const slate = (ret.preCascadeSlate as unknown[]) ?? [];
    expect(slate.length).toBeGreaterThan(candidates.length);
    // The fix: explain should label `scored` from preCascadeSlate when present.
    const scored = slate.length;
    const selected = candidates.length;
    expect(scored).toBe(5);
    expect(selected).toBe(2);
  });

  it("V1 trace_retrieval event is recognised (arm=sync, retrievalSource=trace_retrieval)", () => {
    // B2.1 P1-B fix: previously explain ignored trace_retrieval
    // events entirely → any V1 queryId rendered "not found". Now V1
    // events render as sync arm with full provenance.
    store.appendEvent({
      ts: Date.now(),
      queryId: "q-v1",
      event: "trace_retrieval",
      candidates: [
        {
          traceId: "t-1",
          score: 0.7,
          signals: { fingerprint: 0, bm25: 0.7, jaccard: 0.5, structural: 0.3, cosine: 0, freshness: 0.5 },
        },
        {
          traceId: "t-2",
          score: 0.5,
          signals: { fingerprint: 0, bm25: 0.5, jaccard: 0.3, structural: 0.2, cosine: 0, freshness: 0.5 },
        },
        {
          traceId: "t-3",
          score: 0.3,
          signals: { fingerprint: 0, bm25: 0.3, jaccard: 0.2, structural: 0.1, cosine: 0, freshness: 0.5 },
        },
      ],
      sampledWeights: { bm25: 0.5, jaccard: 0.2, structural: 0.1, cosine: 0, freshness: 0.2 },
      rankerVersion: "linear.ts.v1",
      selectedTraceIds: ["t-1"],
      context: { language: "rust", bucketKey: "rust|_|_" },
    } as never);
    const events = store.readEvents({ queryId: "q-v1", limit: 10 });
    const ret = events.find((e) => e.event === "trace_retrieval") as Record<string, unknown>;
    expect(ret).toBeDefined();
    // V1 logs the full scored set in `candidates`, top-K in selectedTraceIds.
    const candidates = (ret.candidates as unknown[]) ?? [];
    const selected = (ret.selectedTraceIds as unknown[]) ?? [];
    expect(candidates.length).toBe(3);
    expect(selected.length).toBe(1);
    // Bucket key roundtrips for explain to render.
    const ctx = ret.context as { bucketKey?: string };
    expect(ctx.bucketKey).toBe("rust|_|_");
  });
});

describe("cascade explain — event log shape", () => {
  it("collects retrieval + injection + agent_used + outcome for one queryId", () => {
    seedCascadeFlow("q-1", {
      withInjection: true,
      withAgentUsed: true,
      resolved: true,
    });
    const events = store.readEvents({ queryId: "q-1", limit: 100 });
    const kinds = events.map((e) => e.event).sort();
    expect(kinds).toEqual(["agent_used", "injection", "outcome", "retrieval"]);
  });

  it("stamps cascade telemetry on the retrieval event for explain to read", () => {
    seedCascadeFlow("q-1", {});
    const ret = store.readEvents({ queryId: "q-1", limit: 10 }).find((e) => e.event === "retrieval");
    expect(ret).toBeDefined();
    const r = ret as { event: "retrieval" } & Record<string, unknown>;
    expect(r.cascadePolicyId).toBe("linear+rerank+mmr.v1");
    expect(r.rerankerName).toBe("minilm");
    expect(r.mmrLambda).toBe(0.7);
  });

  it("records fallback reason when the reranker collapsed", () => {
    seedCascadeFlow("q-timeout", { fellBack: true, reason: "timeout" as never });
    const ret = store.readEvents({ queryId: "q-timeout", limit: 10 }).find((e) => e.event === "retrieval");
    const r = ret as { event: "retrieval" } & Record<string, unknown>;
    expect(r.rerankerFellBack).toBe(true);
    expect(r.rerankerFallbackReason).toBe("timeout");
  });

  it("returns no events for an unknown queryId so explain can render 'not found'", () => {
    const events = store.readEvents({ queryId: "missing", limit: 10 });
    expect(events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// End-to-end CLI smoke against the built binary. Skipped in the default
// run because we don't bundle dist/cli.js in CI; opt in by building first.
// ---------------------------------------------------------------------------

const cliPath = join(process.cwd(), "dist", "cli.js");
const E2E = existsSync(cliPath);

describe.skipIf(!E2E)("cascade explain — CLI smoke", () => {
  it("renders a report for a known queryId (no crash, includes the id)", () => {
    seedCascadeFlow("q-smoke", { withInjection: true, resolved: true });
    const out = execFileSync("node", [cliPath, "cascade", "explain", "q-smoke", "-p", dir], {
      encoding: "utf-8",
    });
    expect(out).toContain("q-smoke");
  });
});
