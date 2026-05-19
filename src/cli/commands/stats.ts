import { Command } from "commander";
import pc from "picocolors";
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { ReasoningLayer } from "../../core/engine.js";
import { findProjectRoot, loadConfig, readCascadeConfig } from "../../core/config.js";
import { BlockStore } from "../../core/block-store.js";
import { computeCascadeComparison } from "../../lifecycle/cascade-compare.js";

export const statsCommand = new Command("stats")
  .description("Show storage statistics")
  .option("--json", "output as JSON")
  .action((opts) => {
    const projectRoot = findProjectRoot(process.cwd()) ?? process.cwd();
    const config = loadConfig(projectRoot);
    const layer = new ReasoningLayer(config);

    try {
      const s = layer.stats();
      const cascade = loadCascadeStats(projectRoot, config.storagePath);

      if (opts.json) {
        console.log(JSON.stringify({ ...s, cascade }, null, 2));
        return;
      }

      console.log(pc.bold("TraceBase Statistics\n"));

      console.log(pc.dim("  Traces"));
      console.log(`    Total:      ${pc.bold(String(s.totalTraces))}`);
      console.log(`    Successful: ${pc.green(String(s.successfulTraces))}`);
      console.log(`    Failed:     ${pc.red(String(s.failedTraces))}`);
      console.log(`    Partial:    ${pc.yellow(String(s.partialTraces))}`);
      console.log();

      console.log(pc.dim("  Quality"));
      console.log(`    Avg score:    ${s.avgQualityScore.toFixed(3)}`);
      console.log(`    Total recalls: ${s.totalRecalls}`);
      console.log(`    Helpful:       ${s.totalHelpful}`);
      if (s.totalRecalls > 0) {
        const rate = ((s.totalHelpful / s.totalRecalls) * 100).toFixed(1);
        console.log(`    Helpful rate:  ${rate}%`);
      }
      console.log();

      if (s.topLanguages.length > 0) {
        console.log(pc.dim("  Languages"));
        for (const l of s.topLanguages.slice(0, 5)) {
          console.log(`    ${l.language}: ${l.count}`);
        }
        console.log();
      }

      if (s.topFrameworks.length > 0) {
        console.log(pc.dim("  Frameworks"));
        for (const f of s.topFrameworks.slice(0, 5)) {
          console.log(`    ${f.framework}: ${f.count}`);
        }
        console.log();
      }

      if (s.topErrorTypes.length > 0) {
        console.log(pc.dim("  Error Types"));
        for (const e of s.topErrorTypes.slice(0, 5)) {
          console.log(`    ${e.errorType}: ${e.count}`);
        }
        console.log();
      }

      console.log(pc.dim("  Cascade"));
      console.log(`    ${renderCascadeStats(cascade)}`);
      console.log();

      console.log(pc.dim("  Storage"));
      console.log(`    DB size: ${formatBytes(s.dbSizeBytes)}`);
      if (s.oldestTrace) {
        console.log(`    Oldest:  ${new Date(s.oldestTrace).toLocaleDateString()}`);
      }
      if (s.newestTrace) {
        console.log(`    Newest:  ${new Date(s.newestTrace).toLocaleDateString()}`);
      }
    } finally {
      layer.close();
    }
  });

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(1)} ${units[i]}`;
}

type CascadeStatsView =
  | { configured: false }
  | {
      configured: true;
      enabled: boolean;
      rate: number;
      kind: string;
      comparison: ReturnType<typeof computeCascadeComparison> | null;
    };

function loadCascadeStats(projectRoot: string, storagePath: string): CascadeStatsView {
  const cfg = readCascadeConfig(projectRoot);
  if (!cfg) return { configured: false };
  if (!existsSync(storagePath)) {
    return {
      configured: true,
      enabled: cfg.enabled,
      rate: cfg.rollout.rate,
      kind: cfg.reranker.kind,
      comparison: null,
    };
  }
  const db = new Database(storagePath, { readonly: true });
  try {
    const store = new BlockStore(db, { skipMigrate: true });
    try {
      return {
        configured: true,
        enabled: cfg.enabled,
        rate: cfg.rollout.rate,
        kind: cfg.reranker.kind,
        comparison: computeCascadeComparison(store, { afterTs: Date.now() - 7 * 86_400_000 }),
      };
    } finally {
      store.close();
    }
  } finally {
    if (db.open) db.close();
  }
}

function renderCascadeStats(cascade: CascadeStatsView): string {
  if (!cascade.configured) return "not configured";
  const state = cascade.enabled ? pc.green("on") : pc.dim("off");
  const head = `${state}  rate=${(cascade.rate * 100).toFixed(1)}%  kind=${cascade.kind}`;
  const cmp = cascade.comparison;
  if (!cmp || (cmp.cascade.retrievals === 0 && cmp.sync.retrievals === 0)) {
    return `${head}  ${pc.dim("collecting")}`;
  }
  const lift =
    cmp.lift === null
      ? "lift collecting"
      : `lift ${cmp.lift >= 0 ? "+" : ""}${(cmp.lift * 100).toFixed(2)}pp`;
  return `${head}  ${lift}  ` +
    `cascade=${cmp.cascade.helpfulRuns}/${cmp.cascade.totalRuns}  ` +
    `sync=${cmp.sync.helpfulRuns}/${cmp.sync.totalRuns}`;
}
