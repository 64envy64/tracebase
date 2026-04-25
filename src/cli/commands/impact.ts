/**
 * `tracebase impact` — honest, always-on summary of measurable
 * impact (PLAN-0.5.7 §C, completed in 0.5.9).
 *
 * The line ALWAYS leads with what we DO know — assisted run
 * count, resolved rate, total injected token cost — even when
 * causal numbers aren't ready yet. The savings tail is appended
 * only when the holdout cohort is full enough to support it; on
 * smaller samples we tell the user exactly what's missing and
 * how to fix it.
 *
 * Examples:
 *
 *   no holdout configured:
 *     +32 runs assisted · 31% resolved · injected 929 tokens ·
 *     savings unavailable: enable holdout with
 *     `tracebase experiment enable --rate 0.1`
 *
 *   holdout exists but below cohort:
 *     +32 runs assisted · 31% resolved · injected 929 tokens ·
 *     Not enough causal data yet — assisted=4, holdout=2
 *     (need ≥ 30 per arm)
 *
 *   cohort ready:
 *     +42 runs assisted · 83% resolved (+12pp vs holdout) ·
 *     injected 24k tokens · ≈ 38k tokens saved over 7d (n=47) ·
 *     net +14k after injection · latency saved 1.2s
 *
 *   with `--price-input-per-1m 3 --price-output-per-1m 15`:
 *     ... · ≈ $0.34 saved over 7d · net ≈ $0.13
 *
 * No invented savings. No model-name dollar inference. Pricing
 * is rendered ONLY when both flags or both config fields are
 * set; otherwise tokens-only.
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
  /** USD per 1M input tokens. Both --price-* flags required for $ render. */
  priceInputPer1m?: string;
  /** USD per 1M output tokens. Both --price-* flags required for $ render. */
  priceOutputPer1m?: string;
}

export const impactCommand = new Command("impact")
  .description(
    "One-line, honest summary of measurable token / outcome impact. " +
      "Always shows assisted runs / resolved rate / injected token cost; " +
      "appends tokens saved + net + latency only when the holdout cohort " +
      "is large enough. No fabricated savings on small samples.",
  )
  .option("-p, --path <path>", "project root", process.cwd())
  .option("--since <window>", "window: '7d' | '24h' | epoch ms (default 7d)", "7d")
  .option("--json", "emit machine-readable JSON")
  .option(
    "--price-input-per-1m <usd>",
    "USD per 1M input tokens. Both --price-* flags required to render dollars; otherwise tokens-only.",
  )
  .option(
    "--price-output-per-1m <usd>",
    "USD per 1M output tokens. Both --price-* flags required to render dollars; otherwise tokens-only.",
  )
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
// ---------------------------------------------------------------------------

/**
 * Coarse readiness state — drives the rendered line.
 *
 * The split between `no-holdout` and `below-cohort` is the
 * 0.5.9 fix to stop saying "Causal arm not configured" when the
 * arm is configured but the cohort is just small.
 */
export type ImpactReadiness =
  | "ready"
  | "no-store"
  | "no-runs"
  | "no-holdout"
  | "below-cohort";

export interface ImpactReport {
  readiness: ImpactReadiness;
  windowAfterTs: number;
  windowBeforeTs: number;
  metrics: UsageMetrics | null;
  /** Resolved pricing config — `null` when neither flag nor config provides BOTH prices. */
  pricing: { inputPer1mTokens: number; outputPer1mTokens: number } | null;
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
      pricing: null,
      error: "not initialized — run `npx tracebase init` first",
    };
  }
  const config = loadConfig(projectRoot);
  const pricing = resolvePricing(opts, config.pricing);

  if (!existsSync(config.storagePath)) {
    return {
      readiness: "no-store",
      windowAfterTs: 0,
      windowBeforeTs: Date.now(),
      metrics: null,
      pricing,
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
      pricing,
    };
  }

  // 0.5.9 — split the previously-collapsed "below-cohort" state:
  //   - `no-holdout`    when `metrics.causal` is undefined
  //                     (holdout never enabled / no holdout
  //                     outcomes recorded yet → causal block
  //                     omitted by `computeCausal`).
  //   - `below-cohort`  when `metrics.causal` exists but
  //                     `tokensLift.value` is null (cohort < 30
  //                     per arm, default).
  let readiness: ImpactReadiness;
  if (!metrics.causal) {
    readiness = "no-holdout";
  } else if (typeof metrics.causal.tokensLift?.value === "number") {
    readiness = "ready";
  } else {
    readiness = "below-cohort";
  }

  return {
    readiness,
    windowAfterTs: afterTs,
    windowBeforeTs: beforeTs,
    metrics,
    pricing,
  };
}

// ---------------------------------------------------------------------------
// Renderer — always-on head + conditional tail
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

  const windowDays = Math.max(
    1,
    Math.round((report.windowBeforeTs - report.windowAfterTs) / 86_400_000),
  );

  // Always-on head: assisted runs · resolved rate · injected tokens.
  const head = renderHead(m);
  const tail = renderTail(report, windowDays);
  return head + (tail ? " · " + tail : "");
}

function renderHead(m: UsageMetrics): string {
  const observed = m.observed;
  const injected = observed.injectedRuns;
  const head = `+${injected} run${injected === 1 ? "" : "s"} assisted`;
  const resolveRate =
    injected > 0
      ? Math.round((observed.helpfulRuns / injected) * 100)
      : null;
  const withRate =
    resolveRate !== null ? `${head} · ${resolveRate}% resolved` : head;
  // 0.5.9 §1 — always show the injected token cost so the user
  // sees what TraceBase is spending in input-side tokens, even
  // when no savings are available yet.
  const injectedTokens = m.totalInjectedTokensEstimate ?? 0;
  return pc.green(withRate) + pc.dim(` · injected ${humanTokens(injectedTokens)} tokens`);
}

function renderTail(report: ImpactReport, windowDays: number): string {
  const m = report.metrics!;
  switch (report.readiness) {
    case "no-holdout":
      // 0.5.9 §4 — actionable, not just descriptive. The user
      // gets the exact command to enable the experiment.
      return pc.dim(
        "savings unavailable: enable holdout with `tracebase experiment enable --rate 0.1`",
      );
    case "below-cohort": {
      const causal = m.causal!;
      const need = causal.minCohortSize;
      const haveA = causal.assisted.n;
      const haveH = causal.holdout.n;
      return pc.dim(
        `Not enough causal data yet — assisted=${haveA}, holdout=${haveH} (need ≥ ${need} per arm)`,
      );
    }
    case "ready": {
      return renderReadyTail(m, windowDays, report.pricing);
    }
    default:
      return "";
  }
}

function renderReadyTail(
  m: UsageMetrics,
  windowDays: number,
  pricing: ImpactReport["pricing"],
): string {
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
  // The head already rendered "+N runs assisted · X% resolved";
  // append the lift indicator before the tail begins.
  const liftPart = resolvedDelta ? pc.green(resolvedDelta) : "";

  const parts: string[] = [];
  parts.push(
    pc.dim(`≈ ${humanTokens(tokensLift)} tokens saved over ${windowDays}d (n=${tokensSampleSize})`),
  );
  if (typeof m.netTokenImpact === "number") {
    parts.push(pc.dim(`net ${humanSignedTokens(m.netTokenImpact)} after injection`));
  }
  // 0.5.9 §2 — latency saved when the causal arm carries it.
  if (typeof causal.latencyLift?.value === "number") {
    parts.push(pc.dim(`latency saved ${humanLatency(causal.latencyLift.value)}`));
  }
  // 0.5.9 §3 — pricing-gated dollar render. Only when BOTH
  // input + output prices are configured. Tokens we save are a
  // mix of input + output across queries; we render a 50/50
  // blend with no pretence of model-aware accuracy.
  if (pricing) {
    const blendedPer1m = (pricing.inputPer1mTokens + pricing.outputPer1mTokens) / 2;
    const dollarsSaved = (tokensLift * blendedPer1m) / 1_000_000;
    parts.push(pc.dim(`≈ ${formatUsd(dollarsSaved)} saved`));
    if (typeof m.netTokenImpact === "number") {
      const dollarsNet = (m.netTokenImpact * blendedPer1m) / 1_000_000;
      parts.push(pc.dim(`net ≈ ${formatSignedUsd(dollarsNet)}`));
    }
  }
  return liftPart.replace(/^ /, "") + (liftPart ? " · " : "") + parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resolveBasePath(explicit: string | undefined): string | null {
  if (explicit) return explicit;
  return findProjectRoot(process.cwd()) ?? process.cwd();
}

/**
 * Pricing resolution. CLI flags win over config; both prices
 * must resolve to positive finite numbers, otherwise we return
 * `null` (tokens-only render). This deliberately requires an
 * EXPLICIT setup — never inferred from a model name.
 */
function resolvePricing(
  opts: ImpactOptions,
  configPricing: { inputPer1mTokens?: number; outputPer1mTokens?: number } | undefined,
): ImpactReport["pricing"] {
  const flagInput = parsePositiveNumber(opts.priceInputPer1m);
  const flagOutput = parsePositiveNumber(opts.priceOutputPer1m);
  const cfgInput = parsePositiveNumber(configPricing?.inputPer1mTokens);
  const cfgOutput = parsePositiveNumber(configPricing?.outputPer1mTokens);
  const inputPer1mTokens = flagInput ?? cfgInput;
  const outputPer1mTokens = flagOutput ?? cfgOutput;
  if (inputPer1mTokens === undefined || outputPer1mTokens === undefined) return null;
  return { inputPer1mTokens, outputPer1mTokens };
}

function parsePositiveNumber(raw: string | number | undefined): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
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

/**
 * Format ms latency as `1.2s` / `340ms` / `2m`. The window
 * tail uses this for `causal.latencyLift.value` which is a
 * total-ms quantity over the window.
 */
function humanLatency(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

function formatUsd(n: number): string {
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

function formatSignedUsd(n: number): string {
  const sign = n >= 0 ? "+" : "−";
  return sign + formatUsd(Math.abs(n));
}
