#!/usr/bin/env tsx
/**
 * Offline serving-precision evaluation ($0, deterministic, no DB / no API).
 *
 * Exercises the serving-confidence decision layer over a labelled fixture
 * corpus and reports the precision metrics that gate any paid run:
 *   - precision@fire        (injected ∧ useful) / injected
 *   - recall@useful-match   (injected ∧ useful) / useful
 *   - fire-rate             injected / total
 *   - false-positive rate   (injected ∧ ¬useful) / non-useful
 *   - abstention rate       abstained / total
 *   - ambiguity rate        abstained(ambiguous_margin) / total
 *   - reason distribution
 *   - payload-budget proxy  (max features rendered) — informational
 *   - threshold sensitivity table (gate × margin)
 *
 * The corpus is built from explicit negative + positive controls so the
 * numbers are interpretable, not vibes:
 *   generic one-token · verbose-irrelevant body · ambiguous siblings ·
 *   exact structured (api/error/symbol) · strong multi-token · empty/singleton.
 *
 * Run: npx tsx scripts/reasoning-precision/offline-eval.ts
 */
import {
  decideServing,
  resolveServingPolicy,
  type ServingCandidate,
  type ServingPolicy,
  type ServingReason,
} from "../../src/core/serving-confidence.js";
import type { ReasoningBlock, BlockInvariants } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function block(id: string, situation: string, keywords: string[] = [], invariants: BlockInvariants = {}): ReasoningBlock {
  return { id, trigger: { situation, keywords, invariants, fingerprint: `fp-${id}` } } as unknown as ReasoningBlock;
}
const cand = (b: ReasoningBlock, rank = 1): ServingCandidate => ({ block: b, rankScore: rank });

/**
 * A labelled case. `label`:
 *   "useful"     — a strong/structured match the agent SHOULD see (inject = TP).
 *   "not_useful" — weak/generic/ambiguous; injecting it is a false positive.
 *   "none"       — empty corpus; the only correct action is abstain.
 */
interface EvalCase {
  name: string;
  query: { text: string; invariants?: BlockInvariants };
  candidates: ServingCandidate[];
  label: "useful" | "not_useful" | "none";
}

const CORPUS: EvalCase[] = [
  // ── Positive controls (should INJECT) ────────────────────────────────────
  {
    name: "strong multi-token match",
    query: { text: "metaclass registration conflict in abstract base class" },
    candidates: [cand(block("p1", "metaclass registration conflict in abstract base", ["metaclass", "registration", "abstract"]))],
    label: "useful",
  },
  {
    name: "exact apiSurface match (one-token pass)",
    query: { text: "ufunc override", invariants: { apiSurface: ["numpy.ndarray.__array_ufunc__"] } },
    candidates: [cand(block("p2", "numpy ufunc dispatch override", ["ufunc"], { apiSurface: ["numpy.ndarray.__array_ufunc__"] }))],
    label: "useful",
  },
  {
    name: "exact errorType match",
    query: { text: "recursion limit hit while parsing", invariants: { errorType: "RecursionError" } },
    candidates: [cand(block("p3", "deep nesting trips the parser recursion guard", ["nesting", "parser"], { errorType: "RecursionError" }))],
    label: "useful",
  },
  {
    name: "exact symbol identifier match",
    query: { text: "bug in normalize_ledger_row amount handling" },
    candidates: [cand(block("p4", "normalize_ledger_row drops cents on null", ["normalize_ledger_row", "cents"]))],
    label: "useful",
  },
  {
    name: "clear winner over weak sibling",
    query: { text: "isotonic calibrator regression fitting" },
    candidates: [
      cand(block("p5a", "isotonic calibrator regression fitting curve", ["isotonic", "calibrator", "regression"]), 1.0),
      cand(block("p5b", "unrelated logging note", []), 0.4),
    ],
    label: "useful",
  },
  // ── Negative controls (should ABSTAIN) ───────────────────────────────────
  {
    name: "generic one-token overlap",
    query: { text: "fix the function value handling" },
    candidates: [cand(block("n1", "function value object handling", ["function", "value"]))],
    label: "not_useful",
  },
  {
    name: "single short non-generic token, no structure",
    query: { text: "color tweak please" },
    candidates: [cand(block("n2", "color theme palette tokens", ["color"]))],
    label: "not_useful",
  },
  {
    name: "verbose irrelevant body overlap (no trigger overlap)",
    query: { text: "metaclass registration conflict" },
    candidates: [cand(block("n3", "kubernetes pod scheduling affinity taints tolerations", ["kubernetes", "scheduling"]))],
    label: "not_useful",
  },
  {
    name: "ambiguous sibling patterns (equal evidence)",
    query: { text: "color theme dark mode" },
    candidates: [
      cand(block("n4a", "color theme dark mode toggle", ["color", "theme"]), 1.0),
      cand(block("n4b", "color theme dark mode switch", ["color", "theme"]), 0.99),
    ],
    label: "not_useful",
  },
  {
    name: "two-generic-token overlap (no discriminative match)",
    query: { text: "update the config option value" },
    candidates: [cand(block("n5", "config option value parser", ["config", "option"]))],
    label: "not_useful",
  },
  // ── Empty corpus ─────────────────────────────────────────────────────────
  { name: "empty corpus", query: { text: "anything at all here" }, candidates: [], label: "none" },
];

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

interface RunRow {
  name: string;
  label: EvalCase["label"];
  injected: boolean;
  reason: ServingReason;
  confidence: number;
  margin: number;
  features: number;
}

function run(policy: ServingPolicy): RunRow[] {
  return CORPUS.map((c) => {
    const { decision } = decideServing(c.query, c.candidates, policy);
    return {
      name: c.name,
      label: c.label,
      injected: decision.action === "inject",
      reason: decision.reason,
      confidence: decision.features?.evidenceConfidence ?? 0,
      margin: decision.features?.margin ?? 0,
      features: decision.features ? Object.keys(decision.features).length : 0,
    };
  });
}

function metrics(rows: RunRow[]) {
  const total = rows.length;
  const injected = rows.filter((r) => r.injected);
  const useful = rows.filter((r) => r.label === "useful");
  const nonUseful = rows.filter((r) => r.label !== "useful");
  const tp = injected.filter((r) => r.label === "useful").length;
  const fp = injected.filter((r) => r.label !== "useful").length;
  const usefulInjected = useful.filter((r) => r.injected).length;
  const abstained = rows.filter((r) => !r.injected);
  const ambiguous = rows.filter((r) => r.reason === "ambiguous_margin");
  const reasonDist: Record<string, number> = {};
  for (const r of rows) reasonDist[r.reason] = (reasonDist[r.reason] ?? 0) + 1;
  return {
    total,
    fired: injected.length,
    precisionAtFire: injected.length ? round(tp / injected.length) : 1,
    recallAtUseful: useful.length ? round(usefulInjected / useful.length) : 1,
    fireRate: round(injected.length / total),
    falsePositiveRate: nonUseful.length ? round(fp / nonUseful.length) : 0,
    abstentionRate: round(abstained.length / total),
    ambiguityRate: round(ambiguous.length / total),
    maxFeatures: Math.max(...rows.map((r) => r.features), 0),
    reasonDist,
  };
}

const round = (x: number) => Math.round(x * 1000) / 1000;

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const { policy, diagnostics } = resolveServingPolicy();
const rows = run(policy);
const m = metrics(rows);

console.log("=== Serving-precision offline eval ===");
console.log(`policy: gate=${policy.gateThreshold} margin=${policy.marginThreshold} floor=${policy.minEvidenceConfidence} minMatches=${policy.minMeaningfulMatches}`);
if (diagnostics.length) console.log("policy overrides:", diagnostics.join("; "));
console.log("");
console.log("per-case:");
for (const r of rows) {
  const ok = (r.label === "useful") === r.injected || (r.label === "none" && !r.injected);
  console.log(`  ${ok ? "✓" : "✗"} ${r.injected ? "INJECT " : "ABSTAIN"} [${r.label.padEnd(10)}] conf=${r.confidence} margin=${r.margin} ${r.reason}  — ${r.name}`);
}
console.log("");
console.log("metrics:", JSON.stringify(m, null, 2));

// Threshold sensitivity — vary gate × margin around the defaults.
console.log("\nthreshold sensitivity (gate × margin → fire-rate / precision@fire / FP-rate):");
const gates = [0.2, 0.4, 0.6];
const margins = [0.05, 0.15, 0.25];
console.log("        " + margins.map((mg) => `m=${mg}`.padEnd(22)).join(""));
for (const g of gates) {
  const cells = margins.map((mg) => {
    const mm = metrics(run({ ...policy, gateThreshold: g, marginThreshold: mg }));
    return `${mm.fireRate}/${mm.precisionAtFire}/${mm.falsePositiveRate}`.padEnd(22);
  });
  console.log(`gate=${g}  ${cells.join("")}`);
}

// Correctness gate: every case must be classified correctly under defaults.
const wrong = rows.filter((r) => !((r.label === "useful") === r.injected || (r.label === "none" && !r.injected)));
console.log(`\nclassification: ${rows.length - wrong.length}/${rows.length} correct under default policy`);
if (wrong.length) {
  console.log("MISCLASSIFIED:", wrong.map((r) => r.name).join(", "));
  process.exitCode = 1;
}
