/**
 * `tracebase semantic` - operator surface for the shadow-only applicability lane.
 *
 * The command reads local privacy-safe telemetry and freezes explicitly labeled
 * organic observations. It never enables serving, calls a remote provider, or
 * infers labels.
 */
import { Command } from "commander";
import Database from "better-sqlite3";
import { dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import pc from "picocolors";
import { aggregateSemanticShadow, type SemanticShadowReport } from "../../analytics/semantic-shadow-report.js";
import { BlockStore } from "../../core/block-store.js";
import { findConfigDir, loadConfig } from "../../core/config.js";
import type { AnalyticsEvent } from "../../types.js";
import {
  freezeOrganicCalibrationRegistry,
  parseSemanticOrganicLabels,
  type FrozenOrganicCalibrationExport,
} from "../../experiments/semantic-bakeoff/calibration/organic-export.js";
import { parseSince } from "./events.js";

interface BaseOptions {
  path: string;
  since?: string;
  json?: boolean;
}

interface ExportOptions extends BaseOptions {
  labels: string;
  out: string;
  frozenAt?: string;
}

export interface RunSemanticShadowReportOptions {
  path: string;
  since?: string;
}

export interface RunSemanticRegistryExportOptions extends RunSemanticShadowReportOptions {
  labelsPath: string;
  outPath: string;
  frozenAt?: string;
}

function readSemanticEvents(path: string, since?: string): AnalyticsEvent[] {
  const configDir = findConfigDir(path);
  if (!configDir) throw new Error("project not initialized - run `npx tracebase-ai init` first");
  const cfg = loadConfig(path);
  if (!existsSync(cfg.storagePath)) return [];
  const db = new Database(cfg.storagePath, { readonly: true });
  try {
    const store = new BlockStore(db, { skipMigrate: true });
    return store.readEvents({
      eventType: "reasoning.semantic_comparison",
      ...(since ? { afterTs: parseSince(since) } : {}),
      limit: 1_000_000,
    });
  } finally {
    db.close();
  }
}

function parseLabels(path: string): ReturnType<typeof parseSemanticOrganicLabels> {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return parseSemanticOrganicLabels(parsed);
}

function writeJsonAtomic(path: string, value: unknown): void {
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(tempPath, JSON.stringify(value, null, 2) + "\n", "utf8");
    renameSync(tempPath, path);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

export function runSemanticShadowReport(options: RunSemanticShadowReportOptions): SemanticShadowReport {
  return aggregateSemanticShadow(readSemanticEvents(options.path, options.since));
}

export function runSemanticRegistryExport(
  options: RunSemanticRegistryExportOptions,
): FrozenOrganicCalibrationExport {
  const frozen = freezeOrganicCalibrationRegistry(
    readSemanticEvents(options.path, options.since),
    parseLabels(options.labelsPath),
    { ...(options.frozenAt ? { frozenAt: options.frozenAt } : {}) },
  );
  writeJsonAtomic(options.outPath, frozen.registry);
  return frozen;
}

function printReport(report: SemanticShadowReport): void {
  console.log(pc.bold("Semantic shadow report"));
  console.log(pc.dim("  traffic:             ") + report.traffic);
  console.log(
    pc.dim("  V4 baseline:         ") +
      `inject=${report.baseline.inject} abstain=${report.baseline.abstain}`,
  );
  console.log(
    pc.dim("  semantic verdicts:   ") +
      `applicable=${report.semantic.applicable} uncertain=${report.semantic.uncertain} ` +
      `inapplicable=${report.semantic.inapplicable} none=${report.semantic.none}`,
  );
  console.log(
    pc.dim("  residual recovery:   ") +
      `${report.residual.semanticApplicable}/${report.residual.v4Abstain} ` +
      `(${(report.residual.recoveryRate * 100).toFixed(1)}%)`,
  );
  console.log(
    pc.dim("  fallback:            ") +
      `miss=${report.fallback.miss} timeout=${report.fallback.timeout} error=${report.fallback.error}`,
  );
  console.log(
    pc.dim("  latency:             ") +
      `p50=${report.latencyMs.p50}ms p95=${report.latencyMs.p95}ms`,
  );
  if (report.readinessBlockers.length === 0) {
    console.log(pc.green("  readiness:           shadow traffic is clean"));
  } else {
    console.log(pc.yellow("  readiness blockers:"));
    for (const blocker of report.readinessBlockers) console.log(pc.yellow("    - " + blocker));
  }
}

function fail(error: unknown): void {
  console.error(pc.red("Error: ") + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}

export const semanticCommand = new Command("semantic")
  .description("Inspect and freeze the shadow-only semantic applicability lane")
  .addCommand(
    new Command("shadow-report")
      .description("Aggregate local privacy-safe semantic comparison events")
      .option("-p, --path <path>", "project root", process.cwd())
      .option("--since <when>", "window start: relative (7d / 1h / 30m) or ISO / epoch ms")
      .option("--json", "machine-readable JSON output")
      .action((opts: BaseOptions) => {
        try {
          const report = runSemanticShadowReport(opts);
          if (opts.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
          else printReport(report);
        } catch (error) {
          fail(error);
        }
      }),
  )
  .addCommand(
    new Command("export-registry")
      .description("Freeze explicitly labeled organic shadow observations into an auditable local registry")
      .requiredOption("--labels <path>", "operator-curated JSON labels file")
      .requiredOption("--out <path>", "output registry JSON path")
      .option("-p, --path <path>", "project root", process.cwd())
      .option("--since <when>", "window start: relative (7d / 1h / 30m) or ISO / epoch ms")
      .option("--frozen-at <iso>", "override freeze timestamp for deterministic replay")
      .option("--json", "machine-readable JSON output")
      .action((opts: ExportOptions) => {
        try {
          const frozen = runSemanticRegistryExport({
            path: opts.path,
            labelsPath: opts.labels,
            outPath: opts.out,
            ...(opts.since ? { since: opts.since } : {}),
            ...(opts.frozenAt ? { frozenAt: opts.frozenAt } : {}),
          });
          const summary = {
            out: opts.out,
            rows: frozen.registry.rows.length,
            datasetHash: frozen.datasetHash,
            provenanceHash: frozen.provenanceHash,
          };
          if (opts.json) process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
          else {
            console.log(pc.green("Frozen.") + ` ${summary.rows} organic calibration rows`);
            console.log(pc.dim("  output:          ") + summary.out);
            console.log(pc.dim("  dataset hash:    ") + summary.datasetHash);
            console.log(pc.dim("  provenance hash: ") + summary.provenanceHash);
          }
        } catch (error) {
          fail(error);
        }
      }),
  );
