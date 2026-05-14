/**
 * `tracebase report` — aggregate metrics surface on top of the local
 * event log. Same data model as the cloud dashboard (Phase 6.2) will
 * use; this is the local-first version that runs without a backend.
 *
 * Surfaces, per §L6 binding helpfulness definition:
 *   • counts:  retrieval / injection / fact_injection / agent_used /
 *     fact_agent_used / outcome
 *   • coverage: non-shadow retrievals that produced any injection
 *   • block-side rates: hitRate, helpfulRate, counterRate
 *   • fact-side rates:  factHitRate, factHelpfulRate, factCounterRate
 *   • outcome lift: resolved + token, only when a shadow arm exists
 *   • top-N per-block stats sorted by `helpful`
 *   • integrity diagnostics (shadow/control mismatches, orphan outcomes)
 *
 * A "Known caveats" footer always names the deferred gaps (fact
 * calibrator = identity, aggregation = full-log) so a reader never
 * walks away with calibrated-looking numbers they can't trust at scale.
 */
import { Command } from "commander";
import { existsSync } from "node:fs";
import pc from "picocolors";
import Database from "better-sqlite3";
import { findConfigDir, loadConfig } from "../../core/config.js";
import { BlockStore } from "../../core/block-store.js";
import { computeAggregates, type EventAggregates } from "../../core/analytics.js";
import { computeUsageMetrics, type UsageMetrics } from "../../analytics/usage-metrics.js";
import { parseSince } from "./events.js";

export const reportCommand = new Command("report")
  .description("Aggregate metrics across the event log (coverage, rates, lift, top blocks)")
  .option("-p, --path <path>", "project root", process.cwd())
  .option("--since <when>", "window start: relative (7d / 1h) or ISO / epoch ms")
  .option("--before <when>", "window end: relative / ISO / epoch ms")
  .option("--run <id>", "restrict to a single runId")
  .option("--top <n>", "top-N per-block rows (default 10)", "10")
  .option("--json", "machine-readable JSON output")
  .action((opts: {
    path: string;
    since?: string;
    before?: string;
    run?: string;
    top: string;
    json?: boolean;
  }) => {
    const configDir = findConfigDir(opts.path);
    if (!configDir) {
      console.error(pc.yellow("⚠ Not initialized. ") + "Run " + pc.cyan("npx tracebase-ai init") + " first.");
      process.exitCode = 1;
      return;
    }
    const cfg = loadConfig(opts.path);
    if (!existsSync(cfg.storagePath)) {
      if (opts.json) {
        process.stdout.write(JSON.stringify({ empty: true, note: "no store yet" }) + "\n");
        return;
      }
      console.log(pc.dim("  (no store file yet — report will fill once real runs land)"));
      return;
    }

    let afterTs: number | undefined;
    let beforeTs: number | undefined;
    try {
      if (opts.since) afterTs = parseSince(opts.since);
      if (opts.before) beforeTs = parseSince(opts.before);
    } catch (e) {
      console.error(pc.red("Error: ") + (e instanceof Error ? e.message : String(e)));
      process.exitCode = 1;
      return;
    }

    const topN = Math.max(1, Math.min(parseInt(opts.top, 10) || 10, 100));
    const db = new Database(cfg.storagePath, { readonly: true });
    const store = new BlockStore(db, { skipMigrate: true });
    let agg: EventAggregates;
    try {
      agg = computeAggregates(store, {
        ...(afterTs !== undefined ? { afterTs } : {}),
        ...(beforeTs !== undefined ? { beforeTs } : {}),
        ...(opts.run !== undefined ? { runId: opts.run } : {}),
      });
    } finally {
      db.close();
    }

    if (opts.json) {
      // Trim per-block + per-fact to topN for machine output; caller can
      // still request the full set via computeAggregates directly.
      const trimmed: EventAggregates = {
        ...agg,
        perBlock: agg.perBlock.slice(0, topN),
        perFact: agg.perFact.slice(0, topN),
      };
      // Include the derived UsageMetrics surface so scripts and the
      // dashboard never recompute the funnel/estimates themselves.
      const usageMetrics: UsageMetrics = computeUsageMetrics(agg);
      process.stdout.write(
        JSON.stringify({ ...trimmed, usageMetrics }, null, 2) + "\n",
      );
      return;
    }

    renderReport(agg, topN, { afterTs, beforeTs, runId: opts.run });
  });

function renderReport(
  agg: EventAggregates,
  topN: number,
  window: { afterTs?: number; beforeTs?: number; runId?: string },
): void {
  console.log();
  console.log(pc.bold("TraceBase report"));
  const windowParts: string[] = [];
  if (window.afterTs !== undefined) windowParts.push("after " + new Date(window.afterTs).toISOString());
  if (window.beforeTs !== undefined) windowParts.push("before " + new Date(window.beforeTs).toISOString());
  if (window.runId) windowParts.push("runId=" + window.runId);
  if (windowParts.length > 0) console.log(pc.dim("  window: " + windowParts.join(", ")));
  console.log();

  console.log(pc.bold("Counts"));
  const c = agg.counts;
  console.log(`  retrieval ${c.retrieval} · injection ${c.injection} · fact_injection ${c.factInjection}`);
  console.log(`  agent_used ${c.agentUsed} · fact_agent_used ${c.factAgentUsed} · outcome ${c.outcome}`);
  console.log();

  console.log(pc.bold("Retrieval split"));
  console.log(`  total ${agg.retrieval.total} (treatment ${agg.retrieval.treatment} · shadow ${agg.retrieval.shadow})`);
  console.log();

  console.log(pc.bold("Funnel ") + pc.dim("(distinct queryIds per stage)"));
  const f = agg.funnel;
  console.log(`  eligible ${f.eligibleRuns} → recalled ${f.recalledRuns} → injected ${f.injectedRuns} → used ${f.usedRuns} → helpful ${f.helpfulRuns} (verified ${f.verifiedHelpfulRuns})`);
  console.log();

  console.log(pc.bold("Rates"));
  console.log(`  coverage:                ${pct(agg.rates.coverage)}`);
  console.log(`  block hit rate:          ${fmtRate(agg.rates.hitRate)}`);
  console.log(`  block helpful rate:      ${fmtRate(agg.rates.helpfulRate)}`);
  console.log(`  block counter rate:      ${fmtRate(agg.rates.counterproductiveRate)}`);
  console.log(`  fact hit rate:           ${fmtRate(agg.rates.factHitRate)}`);
  console.log(`  fact helpful rate:       ${fmtRate(agg.rates.factHelpfulRate)}`);
  console.log(`  fact counter rate:       ${fmtRate(agg.rates.factCounterproductiveRate)}`);
  console.log();

  console.log(pc.bold("Outcome lift ") + pc.dim("(only when both arms non-empty)"));
  console.log(`  resolved lift:           ${fmtLiftPct(agg.rates.resolvedLift)}`);
  console.log(`  token lift:              ${fmtLiftNum(agg.rates.tokenLift)}`);
  console.log(`  treatment: ${agg.outcome.resolvedTreatment}/${agg.outcome.totalTreatment} resolved  ·  shadow: ${agg.outcome.resolvedShadow}/${agg.outcome.totalShadow} resolved`);
  console.log();

  console.log(pc.bold(`Top blocks `) + pc.dim(`(by helpful, top ${topN})`));
  const topBlocks = agg.perBlock.slice(0, topN);
  if (topBlocks.length === 0) {
    console.log(pc.dim("  (none yet)"));
  } else {
    for (const row of topBlocks) {
      console.log(
        `  ${row.blockId.slice(0, 8)}…  ` +
        `helpful=${row.helpful}  counter=${row.counterproductive}  injected=${row.injected}  agent_used=${row.agentUsed}  neutral=${row.neutral}`,
      );
    }
  }
  console.log();

  console.log(pc.bold(`Top facts `) + pc.dim(`(by helpful, top ${topN})`));
  const topFacts = agg.perFact.slice(0, topN);
  if (topFacts.length === 0) {
    console.log(pc.dim("  (none yet)"));
  } else {
    for (const row of topFacts) {
      console.log(
        `  ${row.factId.slice(0, 8)}…  ` +
        `helpful=${row.helpful}  counter=${row.counterproductive}  injected=${row.injected}  agent_used=${row.agentUsed}  neutral=${row.neutral}`,
      );
    }
  }
  console.log();

  if (agg.integrity.shadowControlMismatches > 0 || agg.integrity.outcomesWithoutRetrieval > 0) {
    console.log(pc.yellow("Integrity diagnostics"));
    if (agg.integrity.shadowControlMismatches > 0) {
      console.log(`  shadow/control mismatches: ${agg.integrity.shadowControlMismatches}`);
    }
    if (agg.integrity.outcomesWithoutRetrieval > 0) {
      console.log(`  outcomes without retrieval: ${agg.integrity.outcomesWithoutRetrieval}`);
    }
    console.log();
  }

  console.log(pc.dim("Known caveats:"));
  console.log(pc.dim("  • Fact calibration is identity (Phase 5.3 adds a fact-side calibrator)."));
  console.log(pc.dim("  • Aggregation reads the full event log (Phase 5.3 adds batched reads)."));
  console.log();
}

function pct(x: number): string {
  return (x * 100).toFixed(1) + "%";
}

function fmtRate(x: number | null): string {
  if (x === null) return pc.dim("n/a (no data)");
  return (x * 100).toFixed(1) + "%";
}

function fmtLiftPct(x: number | null): string {
  if (x === null) return pc.dim("n/a (need shadow arm)");
  const sign = x > 0 ? "+" : "";
  return sign + (x * 100).toFixed(1) + "%";
}

function fmtLiftNum(x: number | null): string {
  if (x === null) return pc.dim("n/a (need shadow arm)");
  const sign = x > 0 ? "+" : "";
  return sign + x.toFixed(1);
}
