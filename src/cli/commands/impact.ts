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
 *     re-running `tracebase init --holdout-rate 0.1`
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
  readHoldoutConfig,
  DEFAULT_HOLDOUT_RATE,
} from "../../core/config.js";
import { BlockStore } from "../../core/block-store.js";
import { computeAggregates, type EventAggregates } from "../../core/analytics.js";
import {
  computeUsageMetrics,
  DEFAULT_MIN_CAUSAL_COHORT,
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
  /**
   * 0.6.0 — surface the experiment-side state separately from
   * `metrics.causal`. The aggregator omits the causal block
   * entirely when no holdout outcomes are recorded, but a
   * just-enabled experiment is "collecting" not "missing" — the
   * render needs both signals.
   */
  experiment: {
    enabled: boolean;
    /** Configured rate when enabled; otherwise the would-be rate. */
    rate: number;
    /** Per-arm outcome counts pulled directly from the aggregator (bypasses metrics filtering). */
    assistedN: number;
    holdoutN: number;
    minCohortSize: number;
  } | null;
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
      experiment: null,
      error: "not initialized — run `npx tracebase init` first",
    };
  }
  const config = loadConfig(projectRoot);
  const pricing = resolvePricing(opts, config.pricing);
  const holdout = readHoldoutConfig(projectRoot);

  if (!existsSync(config.storagePath)) {
    return {
      readiness: "no-store",
      windowAfterTs: 0,
      windowBeforeTs: Date.now(),
      metrics: null,
      pricing,
      experiment: holdout
        ? {
            enabled: holdout.enabled,
            rate: holdout.rate,
            assistedN: 0,
            holdoutN: 0,
            minCohortSize: DEFAULT_MIN_CAUSAL_COHORT,
          }
        : null,
    };
  }

  const beforeTs = Date.now();
  const afterTs = beforeTs - parseWindow(opts.since ?? "7d");

  const db = new Database(config.storagePath, { readonly: true });
  const store = new BlockStore(db, { skipMigrate: true });
  let metrics: UsageMetrics;
  let agg: EventAggregates;
  try {
    agg = computeAggregates(store, { afterTs, beforeTs });
    metrics = computeUsageMetrics(agg);
  } finally {
    store.close();
  }

  // 0.6.0 — pull experiment-side counts directly off the
  // aggregator. `metrics.causal` is filtered out when
  // `holdout.n === 0`, but for an enabled-but-just-started
  // experiment we still want to surface "collecting" with the
  // current per-arm counts.
  const experiment: ImpactReport["experiment"] = holdout
    ? {
        enabled: holdout.enabled,
        rate: holdout.rate,
        assistedN: agg.causal.assisted.n,
        holdoutN: agg.causal.holdout.n,
        minCohortSize: metrics.causal?.minCohortSize ?? DEFAULT_MIN_CAUSAL_COHORT,
      }
    : null;

  if (metrics.observed.eligibleRuns === 0) {
    return {
      readiness: "no-runs",
      windowAfterTs: afterTs,
      windowBeforeTs: beforeTs,
      metrics,
      pricing,
      experiment,
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
    experiment,
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
  // 0.6.1 — render is two explicit segments: estimated (always
  // populates when helpful runs exist) and verified (separately
  // tagged disabled / collecting / ready). Copy never says
  // "saved" alone — always "estimated saved" or "verified saved"
  // — so the reader can never confuse a heuristic estimate for
  // a verified causal lift.
  const estimated = renderEstimatedSegment(m, report.pricing);
  const verified = renderVerifiedSegment(report, windowDays);
  return [estimated, verified].filter((s) => s.length > 0).join(" · ");
}

/**
 * Always-on estimated section. Heuristic-based: helpful runs
 * × per-run constant. The formula is implicit in the
 * `(n=N helpful)` tail; consumers who want the literal multiplier
 * can read `metrics.estimated.heuristicTokensSaved.formula`.
 */
function renderEstimatedSegment(
  m: UsageMetrics,
  pricing: ImpactReport["pricing"],
): string {
  const heur = m.estimated.heuristicTokensSaved;
  const helpfulN = heur.sampleSize;
  if (helpfulN === 0 || typeof heur.value !== "number") {
    // No helpful runs yet — be honest: there's nothing to
    // estimate. The head already showed the injected token cost.
    return pc.dim("estimated: collecting (no helpful runs in window yet)");
  }
  const tokens = heur.value;
  const parts: string[] = [];
  parts.push(pc.dim(`≈ ${humanTokens(tokens)} estimated saved (n=${helpfulN} helpful)`));
  // Net after context cost — uses the heuristic-saved value
  // since this segment is the always-on view that doesn't depend
  // on holdout.
  const injected = m.totalInjectedTokensEstimate ?? 0;
  const netEst = tokens - injected;
  parts.push(pc.dim(`net est ${humanSignedTokens(netEst)} after context cost`));
  // Latency: heuristic-derived (helpful × 5s default).
  const heurLat = m.estimated.heuristicLatencySavedMs;
  if (typeof heurLat.value === "number" && heurLat.value > 0) {
    parts.push(pc.dim(`≈ ${humanLatency(heurLat.value)} estimated latency saved`));
  }
  if (pricing) {
    const blendedPer1m = (pricing.inputPer1mTokens + pricing.outputPer1mTokens) / 2;
    const dollarsEst = (tokens * blendedPer1m) / 1_000_000;
    parts.push(pc.dim(`≈ ${formatUsd(dollarsEst)} estimated`));
    const dollarsNet = (netEst * blendedPer1m) / 1_000_000;
    parts.push(pc.dim(`net est ≈ ${formatSignedUsd(dollarsNet)}`));
  }
  return parts.join(" · ");
}

/**
 * Verified segment — three states keyed off readiness +
 * experiment config:
 *   - disabled   → tag with the enable command
 *   - collecting → assisted=N / holdout=M progress
 *   - ready      → "verified saved", net, latency, dollars
 */
function renderVerifiedSegment(
  report: ImpactReport,
  windowDays: number,
): string {
  const m = report.metrics!;
  switch (report.readiness) {
    case "no-holdout": {
      if (report.experiment?.enabled) {
        const exp = report.experiment;
        return pc.dim(
          `verified: collecting — assisted=${exp.assistedN}, holdout=${exp.holdoutN} (need ≥ ${exp.minCohortSize} per arm)`,
        );
      }
      return pc.dim(
        `verified: disabled (enable: re-run \`tracebase init --holdout-rate ${formatRateForCli(report.experiment?.rate)}\`)`,
      );
    }
    case "below-cohort": {
      const causal = m.causal!;
      const need = causal.minCohortSize;
      const haveA = causal.assisted.n;
      const haveH = causal.holdout.n;
      const verb = report.experiment?.enabled === false ? "disabled (collecting historical)" : "collecting";
      return pc.dim(
        `verified: ${verb} — assisted=${haveA}, holdout=${haveH} (need ≥ ${need} per arm)`,
      );
    }
    case "ready": {
      return renderVerifiedReadyTail(m, windowDays, report.pricing);
    }
    default:
      return "";
  }
}

/** Format a holdout rate for the CLI hint. Default 0.1 → "0.1". */
function formatRateForCli(rate: number | undefined): string {
  const r = typeof rate === "number" && rate > 0 && rate <= 1 ? rate : DEFAULT_HOLDOUT_RATE;
  return r.toString();
}

function renderVerifiedReadyTail(
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
  const parts: string[] = [];
  parts.push(
    pc.dim(
      `≈ ${humanTokens(tokensLift)} verified saved over ${windowDays}d (n=${tokensSampleSize})${resolvedDelta}`,
    ),
  );
  if (typeof m.netTokenImpact === "number") {
    parts.push(pc.dim(`net verified ${humanSignedTokens(m.netTokenImpact)} after context cost`));
  }
  // 0.5.9 §2 — verified latency saved when the causal arm carries
  // it. Renamed from "latency saved" → "verified latency saved"
  // to match the §5 copy rule.
  if (typeof causal.latencyLift?.value === "number") {
    parts.push(pc.dim(`verified latency saved ${humanLatency(causal.latencyLift.value)}`));
  }
  if (pricing) {
    const blendedPer1m = (pricing.inputPer1mTokens + pricing.outputPer1mTokens) / 2;
    const dollarsSaved = (tokensLift * blendedPer1m) / 1_000_000;
    parts.push(pc.dim(`≈ ${formatUsd(dollarsSaved)} verified`));
    if (typeof m.netTokenImpact === "number") {
      const dollarsNet = (m.netTokenImpact * blendedPer1m) / 1_000_000;
      parts.push(pc.dim(`net verified ≈ ${formatSignedUsd(dollarsNet)}`));
    }
  }
  return parts.join(" · ");
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
