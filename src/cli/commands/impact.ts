/**
 * `tracebase impact` — one-line, honest summary of the layer's
 * measurable economic impact (PLAN-0.5.7 §C).
 *
 * Reads the same `UsageMetrics` the CLI's `usage sync` and the
 * coordinator's auto-sync produce. Renders one line:
 *
 *   +42 runs assisted · 83% resolved (+12pp vs holdout) ·
 *   ≈ 38k tokens saved over 7d (n=47, CI ±6k) ·
 *   net +24k after injection
 *
 * Honest fallback when there isn't enough data:
 *
 *   Not enough data yet — n=4 in the assisted arm (need ≥30).
 *
 * No invented savings. No optimistic rounding. When the cohort
 * is below the causal threshold (default 30), the per-token
 * numbers stay null; we report counts only and tell the user
 * what's missing.
 */

import { Command } from "commander";
import pc from "picocolors";
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import {
  findProjectRoot,
  isInitialized,
  loadConfig,
} from "../../core/config.js";
import { BlockStore } from "../../core/block-store.js";
import { computeAggregates } from "../../core/analytics.js";
import {
  computeUsageMetrics,
  type UsageMetrics,
} from "../../analytics/usage-metrics.js";

interface ImpactOptions {
  path?: string;
  /** Window (ms) — default 7 days. Accepts plain ms or "Nd" / "Nh". */
  since?: string;
  json?: boolean;
}

export const impactCommand = new Command("impact")
  .description(
    "One-line, honest summary of measurable token / outcome impact. " +
      "Returns 'not enough data yet' on small samples — no fabricated lift.",
  )
  .option("-p, --path <path>", "project root", process.cwd())
  .option("--since <window>", "window: '7d' | '24h' | epoch ms (default 7d)", "7d")
  .option("--json", "emit machine-readable JSON")
  .action((opts: ImpactOptions) => {
    const result = runImpact(opts);
    if (opts.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else {
      process.stdout.write(renderImpactLine(result) + "\n");
    }
    if (result.error) process.exitCode = 1;
  });

// ---------------------------------------------------------------------------
// Public API — exposed for tests + the future TB IMPACT badge
// (deferred to 0.5.8 per the §A scope amendment)
// ---------------------------------------------------------------------------

export type ImpactReadiness =
  | "ready"
  | "no-store"
  | "no-runs"
  | "below-cohort";

export interface ImpactReport {
  /** Coarse status — drives the rendered line. */
  readiness: ImpactReadiness;
  /** Window the report was computed over (epoch ms). */
  windowAfterTs: number;
  windowBeforeTs: number;
  /** Snapshot of the underlying metrics for `--json` consumers. */
  metrics: UsageMetrics | null;
  /** Set when readiness gating identified a precondition failure. */
  error?: string;
}

export function runImpact(opts: ImpactOptions): ImpactReport {
  const projectRoot = resolveBasePath(opts.path);
  if (!projectRoot || !isInitialized(projectRoot)) {
    return {
      readiness: "no-store",
      windowAfterTs: 0,
      windowBeforeTs: Date.now(),
      metrics: null,
      error: "not initialized — run `npx tracebase init` first",
    };
  }
  const config = loadConfig(projectRoot);
  if (!existsSync(config.storagePath)) {
    return {
      readiness: "no-store",
      windowAfterTs: 0,
      windowBeforeTs: Date.now(),
      metrics: null,
    };
  }

  const beforeTs = Date.now();
  const afterTs = beforeTs - parseWindow(opts.since ?? "7d");

  const db = new Database(config.storagePath, { readonly: true });
  const store = new BlockStore(db, { skipMigrate: true });
  let metrics: UsageMetrics;
  try {
    const agg = computeAggregates(store, { afterTs, beforeTs });
    metrics = computeUsageMetrics(agg);
  } finally {
    store.close();
  }

  if (metrics.observed.eligibleRuns === 0) {
    return {
      readiness: "no-runs",
      windowAfterTs: afterTs,
      windowBeforeTs: beforeTs,
      metrics,
    };
  }

  // Causal numbers absent OR cohort below threshold → "below
  // cohort" — we have observed counts but no defensible token
  // savings yet.
  const tokensLiftValue = metrics.causal?.tokensLift?.value;
  const readiness: ImpactReadiness =
    typeof tokensLiftValue === "number" ? "ready" : "below-cohort";

  return {
    readiness,
    windowAfterTs: afterTs,
    windowBeforeTs: beforeTs,
    metrics,
  };
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export function renderImpactLine(report: ImpactReport): string {
  if (report.error) return pc.yellow("⚠ ") + report.error;

  if (report.readiness === "no-store") {
    return pc.dim("no store yet — run an agent turn first to populate metrics");
  }

  const m = report.metrics;
  if (!m || report.readiness === "no-runs") {
    return pc.dim("Not enough data yet — no eligible runs in the window.");
  }

  const windowDays = Math.round(
    (report.windowBeforeTs - report.windowAfterTs) / 86_400_000,
  );

  const observed = m.observed;
  const head = `+${observed.injectedRuns} runs assisted`;
  const resolveRate =
    observed.injectedRuns > 0
      ? Math.round((observed.helpfulRuns / observed.injectedRuns) * 100)
      : null;
  const headWithRate =
    resolveRate !== null ? `${head} · ${resolveRate}% resolved` : head;

  if (report.readiness === "below-cohort") {
    const causal = m.causal;
    const need = causal?.minCohortSize ?? 30;
    const haveAssisted = causal?.assisted?.n ?? 0;
    const haveHoldout = causal?.holdout?.n ?? 0;
    const cohortNote = causal
      ? pc.dim(
          ` · Not enough causal data yet — assisted=${haveAssisted}, holdout=${haveHoldout} (need ≥ ${need} per arm).`,
        )
      : pc.dim(" · Causal arm not configured — `tracebase experiment enable` to start the holdout split.");
    return headWithRate + cohortNote;
  }

  // readiness === "ready" — every per-token number resolved.
  const causal = m.causal!;
  const tokensLift = causal.tokensLift.value as number;
  const tokensSampleSize = causal.tokensLift.sampleSize;
  const liftDeltaPp =
    typeof causal.resolvedLift === "number"
      ? Math.round(causal.resolvedLift * 100)
      : null;
  const resolvedDelta =
    liftDeltaPp !== null
      ? ` (${liftDeltaPp >= 0 ? "+" : ""}${liftDeltaPp}pp vs holdout)`
      : "";
  const tokensSavedHuman = humanTokens(tokensLift);
  const netImpact = m.netTokenImpact;
  const netHuman =
    typeof netImpact === "number" ? humanSignedTokens(netImpact) : "—";

  const parts = [
    pc.green(headWithRate + resolvedDelta),
    pc.dim(
      `≈ ${tokensSavedHuman} tokens saved over ${windowDays}d (n=${tokensSampleSize})`,
    ),
    pc.dim(`net ${netHuman} after injection`),
  ];
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resolveBasePath(explicit: string | undefined): string | null {
  if (explicit) return explicit;
  return findProjectRoot(process.cwd()) ?? process.cwd();
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

function parseWindow(raw: string): number {
  const trimmed = raw.trim();
  const days = /^(\d+)d$/.exec(trimmed);
  if (days) return Number(days[1]) * DAY_MS;
  const hours = /^(\d+)h$/.exec(trimmed);
  if (hours) return Number(hours[1]) * HOUR_MS;
  const ms = Number(trimmed);
  if (Number.isFinite(ms) && ms > 0) return ms;
  return 7 * DAY_MS;
}

function humanTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${Math.round(n)}`;
}

function humanSignedTokens(n: number): string {
  const sign = n >= 0 ? "+" : "−";
  return sign + humanTokens(Math.abs(n));
}
