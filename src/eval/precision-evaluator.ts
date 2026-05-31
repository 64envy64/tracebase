/**
 * Organic reasoning-reuse precision evaluator (Phase 5).
 *
 * Runs a LABELLED corpus of queries through the real serving path
 * (BlockServer.recall → rank → evidence → calibrate → margin → policy) and
 * reports the readiness metrics. Two hard rules baked in:
 *
 *   1. Provenance is load-bearing. Each query is tagged organic | bootstrap by
 *      whether the block it targets was runtime-captured or imported. The
 *      readiness gate counts ONLY organic evidence; the bootstrap subset is
 *      reported separately and never contributes to a READY verdict.
 *   2. No benchmark-specific tuning. The evaluator only observes the policy +
 *      calibrator already in the store; it never lowers a gate to pass.
 *
 * Pure-ish: takes a store + server + corpus, returns a typed report. Latency is
 * wall-clock around each recall.
 */
import type { BlockServer } from "../core/block-serving.js";
import type { BlockInvariants } from "../types.js";
import { wilsonLowerBound } from "../core/block.js";

export type QueryLabel = "useful" | "weak" | "generic" | "unrelated" | "ambiguous";

export interface LabeledQuery {
  text: string;
  invariants?: BlockInvariants;
  label: QueryLabel;
  /** For label "useful": the block id that SHOULD be injected. */
  expectBlockId?: string;
  /**
   * Whether this query's evidence counts toward ORGANIC readiness. Set by the
   * corpus builder from the target block's provenance (runtime → organic).
   */
  provenanceClass: "organic" | "bootstrap";
}

export interface ReadinessGate {
  organicCaptureWorks: boolean;
  minLabeledQueries: { value: number; required: number; pass: boolean };
  minFiredHighConfidence: { value: number; required: number; pass: boolean };
  precisionAtFire: { value: number; required: number; pass: boolean };
  precisionWilsonLB: { value: number; required: number; pass: boolean };
  falsePositiveRate: { value: number; required: number; pass: boolean };
  weakAmbiguousAbstain: { value: number; pass: boolean };
  overall: boolean;
}

export interface PrecisionReport {
  corpus: { blocks: number; runtimeBlocks: number; importBlocks: number };
  queries: { total: number; organic: number; bootstrap: number; byLabel: Record<QueryLabel, number> };
  fireRate: number;
  abstentionByReason: Record<string, number>;
  precisionAtFire: number | null;
  precisionWilsonLB: number | null;
  falsePositiveRate: number | null;
  recallAtUseful: number | null;
  latencyMsP50: number;
  latencyMsP95: number;
  calibratorVersion: number | "identity" | "mixed";
  calibratedCoverage: number;
  /** Organic-only metrics (the gate keys off these). */
  organic: {
    fired: number;
    firedHighConfidence: number;
    precisionAtFire: number | null;
    precisionWilsonLB: number | null;
    falsePositiveRate: number | null;
  };
  readiness: ReadinessGate;
  examples: { correctInjection?: string; correctAbstention?: string };
}

export interface EvalThresholds {
  minQueries: number;
  minFired: number;
  precisionAtFire: number;
  precisionWilsonLB: number;
  falsePositiveRate: number;
  /** A fire counts as "high-confidence" at/above this calibrated probability. */
  highConfidence: number;
}

export const READINESS_THRESHOLDS: EvalThresholds = {
  minQueries: 50,
  minFired: 30,
  precisionAtFire: 0.9,
  precisionWilsonLB: 0.8,
  falsePositiveRate: 0.05,
  highConfidence: 0.6,
};

interface Row {
  q: LabeledQuery;
  fired: boolean;
  reason: string;
  calibratedProb: number;
  correct: boolean; // fired-and-right, or abstained-and-should-have
  latencyMs: number;
  calibrated: boolean; // calibrator was non-identity
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

/**
 * Evaluate a corpus. `organicCaptureWorks` is asserted by the caller (the
 * integration suite proves it); pass it through so the gate reflects reality.
 */
export function evaluatePrecision(
  server: BlockServer,
  blocks: Array<{ id: string; sourceType: "runtime" | "import" }>,
  queries: LabeledQuery[],
  opts: { thresholds?: EvalThresholds; organicCaptureWorks?: boolean } = {},
): PrecisionReport {
  const T = opts.thresholds ?? READINESS_THRESHOLDS;
  const rows: Row[] = queries.map((q) => {
    const t0 = Date.now();
    const r = server.recall({ text: q.text, ...(q.invariants ? { invariants: q.invariants } : {}) });
    const latencyMs = Date.now() - t0;
    const fired = r.shouldInject;
    const decision = r.servingDecision;
    const injectedId = r.blocks.find((h) => h.passesGate)?.block.id;
    const correct = fired
      ? q.label === "useful" && injectedId === q.expectBlockId
      : q.label !== "useful"; // abstaining is correct on every non-useful label
    return {
      q,
      fired,
      reason: decision?.reason ?? (fired ? "injected" : "abstain"),
      calibratedProb: decision?.calibratedProb ?? 0,
      correct,
      latencyMs,
      calibrated: (r.blocks[0]?.calibratedProb ?? 0) !== (r.blocks[0]?.evidenceConfidence ?? -1),
    };
  });

  const metricsFor = (subset: Row[]) => {
    const fired = subset.filter((r) => r.fired);
    const firedHi = fired.filter((r) => r.calibratedProb >= T.highConfidence);
    const correctFires = fired.filter((r) => r.correct).length;
    const usefulQ = subset.filter((r) => r.q.label === "useful");
    const usefulFiredCorrect = usefulQ.filter((r) => r.fired && r.correct).length;
    const nonUseful = subset.filter((r) => r.q.label !== "useful");
    const fp = nonUseful.filter((r) => r.fired).length;
    return {
      fired: fired.length,
      firedHighConfidence: firedHi.length,
      precisionAtFire: fired.length ? correctFires / fired.length : null,
      precisionWilsonLB: fired.length ? wilsonLowerBound(correctFires, fired.length) : null,
      falsePositiveRate: nonUseful.length ? fp / nonUseful.length : null,
      recallAtUseful: usefulQ.length ? usefulFiredCorrect / usefulQ.length : null,
    };
  };

  const all = metricsFor(rows);
  const organicRows = rows.filter((r) => r.q.provenanceClass === "organic");
  const org = metricsFor(organicRows);

  const reasonDist: Record<string, number> = {};
  for (const r of rows.filter((x) => !x.fired)) reasonDist[r.reason] = (reasonDist[r.reason] ?? 0) + 1;

  const byLabel = { useful: 0, weak: 0, generic: 0, unrelated: 0, ambiguous: 0 } as Record<QueryLabel, number>;
  for (const q of queries) byLabel[q.label]++;
  const weakAmb = rows.filter((r) => r.q.label === "weak" || r.q.label === "ambiguous");
  const weakAmbAbstained = weakAmb.filter((r) => !r.fired).length;

  const lat = rows.map((r) => r.latencyMs).sort((a, b) => a - b);
  const calibratedCount = rows.filter((r) => r.calibrated).length;

  const round = (x: number | null) => (x === null ? null : Math.round(x * 1000) / 1000);

  const readiness: ReadinessGate = {
    organicCaptureWorks: opts.organicCaptureWorks ?? false,
    minLabeledQueries: { value: organicRows.length, required: T.minQueries, pass: organicRows.length >= T.minQueries },
    minFiredHighConfidence: { value: org.firedHighConfidence, required: T.minFired, pass: org.firedHighConfidence >= T.minFired },
    precisionAtFire: { value: round(org.precisionAtFire) ?? 0, required: T.precisionAtFire, pass: (org.precisionAtFire ?? 0) >= T.precisionAtFire },
    precisionWilsonLB: { value: round(org.precisionWilsonLB) ?? 0, required: T.precisionWilsonLB, pass: (org.precisionWilsonLB ?? 0) >= T.precisionWilsonLB },
    falsePositiveRate: { value: round(org.falsePositiveRate) ?? 0, required: T.falsePositiveRate, pass: (org.falsePositiveRate ?? 1) <= T.falsePositiveRate },
    weakAmbiguousAbstain: { value: weakAmb.length ? weakAmbAbstained / weakAmb.length : 1, pass: weakAmbAbstained === weakAmb.length },
    overall: false,
  };
  readiness.overall =
    readiness.organicCaptureWorks &&
    readiness.minLabeledQueries.pass &&
    readiness.minFiredHighConfidence.pass &&
    readiness.precisionAtFire.pass &&
    readiness.precisionWilsonLB.pass &&
    readiness.falsePositiveRate.pass &&
    readiness.weakAmbiguousAbstain.pass;

  return {
    corpus: {
      blocks: blocks.length,
      runtimeBlocks: blocks.filter((b) => b.sourceType === "runtime").length,
      importBlocks: blocks.filter((b) => b.sourceType === "import").length,
    },
    queries: {
      total: queries.length,
      organic: organicRows.length,
      bootstrap: rows.length - organicRows.length,
      byLabel,
    },
    fireRate: round(rows.filter((r) => r.fired).length / Math.max(1, rows.length))!,
    abstentionByReason: reasonDist,
    precisionAtFire: round(all.precisionAtFire),
    precisionWilsonLB: round(all.precisionWilsonLB),
    falsePositiveRate: round(all.falsePositiveRate),
    recallAtUseful: round(all.recallAtUseful),
    latencyMsP50: pct(lat, 0.5),
    latencyMsP95: pct(lat, 0.95),
    calibratorVersion: calibratedCount === 0 ? "identity" : calibratedCount === rows.length ? 1 : "mixed",
    calibratedCoverage: round(calibratedCount / Math.max(1, rows.length))!,
    organic: {
      fired: org.fired,
      firedHighConfidence: org.firedHighConfidence,
      precisionAtFire: round(org.precisionAtFire),
      precisionWilsonLB: round(org.precisionWilsonLB),
      falsePositiveRate: round(org.falsePositiveRate),
    },
    readiness,
    examples: {
      correctInjection: rows.find((r) => r.fired && r.correct)?.q.text,
      correctAbstention: rows.find((r) => !r.fired && r.correct)?.q.text,
    },
  };
}
