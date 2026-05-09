/**
 * 0.7.1 Contextual Runtime — pilot report aggregator
 *
 * Pure aggregation. Takes the per-run metric stream from
 * `runner.ts` and folds it into a `PilotReport` an integrator
 * (and our own analytics) can read directly.
 *
 * Privacy: this module never sees raw model output, raw prompts,
 * tool bodies, file content, absolute paths, or secrets. It only
 * touches the `RunMetric` type, which by construction carries
 * structured ids, counts, and durations — no free-form payload.
 * The privacy test suite asserts this serialized output stays
 * leak-free.
 */

import type {
  CausalLift,
  CaptureSummary,
  Condition,
  ConditionAggregates,
  PilotReport,
  RunMetric,
} from "./types.js";

/**
 * Build the pilot report. `driver` is reported at the top so a
 * reader doesn't conflate stub-driver runs with real Anthropic
 * loops — the headline numbers are very different.
 */
export function buildPilotReport(args: {
  runs: RunMetric[];
  conditions: Condition[];
  fixtureCount: number;
  capture: CaptureSummary;
  driver: "anthropic" | "stub";
  generatedAtIso?: string;
}): PilotReport {
  const aggregates = args.conditions.map((c) =>
    aggregateForCondition(c, args.runs.filter((r) => r.condition === c)),
  );

  const causal = buildCausalLifts(aggregates);

  return {
    protocol: "tracebase.contextual_runtime.v1",
    generatedAt: args.generatedAtIso ?? new Date().toISOString(),
    driver: args.driver,
    fixtureCount: args.fixtureCount,
    conditions: args.conditions,
    aggregates,
    causal,
    capture: args.capture,
    runs: args.runs,
  };
}

/** Per-condition aggregator. Empty-cohort safe. */
export function aggregateForCondition(
  condition: Condition,
  runs: RunMetric[],
): ConditionAggregates {
  const n = runs.length;
  if (n === 0) {
    return {
      condition,
      n: 0,
      resolved: 0,
      resolvedRate: 0,
      avgDurationMs: 0,
      medianDurationMs: 0,
      avgTokens: 0,
      avgSteps: 0,
      regressedRate: 0,
      injectionRate: 0,
      usedAfterInjectionRate: 0,
    };
  }

  const resolved = runs.filter((r) => r.resolved).length;
  const durations = runs.map((r) => r.durationMs);
  const tokens = runs.map((r) => r.tokens);
  const steps = runs.map((r) => r.steps);
  const regressed = runs.filter((r) => r.regressed === true).length;
  const injected = runs.filter((r) => r.hadInjection).length;
  const usedAfterInjection = runs.filter(
    (r) => r.hadInjection && r.usedIds.length > 0,
  ).length;

  return {
    condition,
    n,
    resolved,
    resolvedRate: resolved / n,
    avgDurationMs: avg(durations),
    medianDurationMs: median(durations),
    avgTokens: avg(tokens),
    avgSteps: avg(steps),
    regressedRate: regressed / n,
    injectionRate: injected / n,
    usedAfterInjectionRate: injected === 0 ? 0 : usedAfterInjection / injected,
  };
}

/**
 * Causal lift table — TraceBase against each comparator condition.
 * Returns one entry per (vs) comparator that is present in the
 * aggregates. Cohort sizes are surfaced so a reader can see the
 * statistical weight behind the headline numbers.
 */
export function buildCausalLifts(
  aggregates: ConditionAggregates[],
): CausalLift[] {
  const map = new Map<Condition, ConditionAggregates>();
  for (const a of aggregates) map.set(a.condition, a);
  const tracebase = map.get("tracebase");
  if (!tracebase || tracebase.n === 0) return [];

  const out: CausalLift[] = [];
  const comparators: Array<"off" | "naive-cache" | "tracebase-holdout"> = [
    "off",
    "naive-cache",
    "tracebase-holdout",
  ];
  for (const cmpName of comparators) {
    const cmp = map.get(cmpName);
    if (!cmp) continue;
    const cohortSize = { tracebase: tracebase.n, comparator: cmp.n };
    out.push({
      vs: cmpName,
      resolvedLiftPP: tracebase.resolvedRate - cmp.resolvedRate,
      durationDeltaMs:
        tracebase.n === 0 || cmp.n === 0
          ? null
          : tracebase.avgDurationMs - cmp.avgDurationMs,
      cohortSize,
    });
  }
  return out;
}

/**
 * Pretty-print the report for terminal output. Prefer JSON
 * (`buildPilotReport` → `JSON.stringify`) when piping into another
 * tool — this format exists for a human reading the raw runner
 * output.
 */
export function formatPilotReport(report: PilotReport): string {
  const lines: string[] = [];
  lines.push(
    `# TraceBase Contextual Runtime — Pilot Report  (${report.driver})`,
  );
  lines.push(`generated: ${report.generatedAt}`);
  lines.push(
    `fixtures:  ${report.fixtureCount}    conditions: ${report.conditions.join(", ")}`,
  );
  lines.push("");
  lines.push("## Aggregates (per condition)");
  for (const a of report.aggregates) {
    lines.push(
      `  ${a.condition.padEnd(20)} n=${String(a.n).padStart(3)}  ` +
        `resolved=${pctStr(a.resolvedRate)}  ` +
        `avgMs=${a.avgDurationMs.toFixed(0).padStart(5)}  ` +
        `medMs=${a.medianDurationMs.toFixed(0).padStart(5)}  ` +
        `tokens=${a.avgTokens.toFixed(0).padStart(5)}  ` +
        `steps=${a.avgSteps.toFixed(1).padStart(4)}  ` +
        `regr=${pctStr(a.regressedRate)}  ` +
        `inj=${pctStr(a.injectionRate)}  ` +
        `usedᵢ=${pctStr(a.usedAfterInjectionRate)}`,
    );
  }
  lines.push("");
  lines.push("## Causal lift (TraceBase vs comparator)");
  if (report.causal.length === 0) {
    lines.push("  (no tracebase cohort or no comparators present)");
  } else {
    for (const c of report.causal) {
      const dur =
        c.durationDeltaMs === null
          ? "  n/a "
          : `${(c.durationDeltaMs / 1000).toFixed(1)}s`;
      lines.push(
        `  vs ${c.vs.padEnd(18)}  resolved Δ=${pctSigned(c.resolvedLiftPP)}  ` +
          `duration Δ=${dur}  ` +
          `n=${c.cohortSize.tracebase}/${c.cohortSize.comparator}`,
      );
    }
  }
  lines.push("");
  lines.push("## Capture summary (pre-seed)");
  lines.push(
    `  attempted=${report.capture.capturesAttempted}  ` +
      `accepted=${report.capture.capturesAccepted}  ` +
      `rejected=${report.capture.capturesRejected}  ` +
      `rejectRate=${pctStr(report.capture.captureRejectRate)}`,
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// numeric helpers
// ---------------------------------------------------------------------------

function avg(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

function pctStr(x: number): string {
  return `${(x * 100).toFixed(1)}%`.padStart(6);
}

function pctSigned(x: number): string {
  const v = (x * 100).toFixed(1);
  const s = x >= 0 ? `+${v}%` : `${v}%`;
  return s.padStart(7);
}
