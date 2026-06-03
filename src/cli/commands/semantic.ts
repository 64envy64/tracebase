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
import { collectSemanticShadowObservations, type SemanticShadowObservationSkeleton } from "../../analytics/semantic-shadow-observations.js";
import { aggregateSemanticShadow, type SemanticShadowReport } from "../../analytics/semantic-shadow-report.js";
import {
  evaluateSemanticShadowSoak,
  type SemanticShadowSoakReport,
  type SemanticShadowSoakThresholds,
} from "../../analytics/semantic-shadow-soak.js";
import { BlockStore } from "../../core/block-store.js";
import { findConfigDir, loadConfig } from "../../core/config.js";
import { detectLeakageExtended } from "../../core/guard.js";
import type { AnalyticsEvent } from "../../types.js";
import {
  freezeOrganicCalibrationRegistry,
  parseSemanticOrganicLabels,
  type FrozenOrganicCalibrationExport,
} from "../../experiments/semantic-bakeoff/calibration/organic-export.js";
import { probeSemanticShadow, type SemanticShadowDoctorReport } from "../../experiments/semantic-bakeoff/service/doctor.js";
import {
  SEMANTIC_SHADOW_ALLOW_UNPINNED_ENV,
  SEMANTIC_SHADOW_ATTESTATION_ENV,
  SEMANTIC_SHADOW_TOKEN_ENV,
  SEMANTIC_SHADOW_URL_ENV,
} from "../../experiments/semantic-bakeoff/semantic-shadow.js";
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

interface ObservationExportOptions extends BaseOptions {
  out: string;
}

interface SoakOptions extends BaseOptions {
  out?: string;
  minTraffic?: string;
  minV4Abstain?: string;
  minResidualRecovery?: string;
  minWarmCompletions?: string;
  maxLatencyP95Ms?: string;
  maxWarmLatencyP95Ms?: string;
  maxWarmQueuePending?: string;
  allowUnpinnedDevMode?: boolean;
}

interface DogfoodPreflightOptions extends BaseOptions {
  out?: string;
  allowUnpinnedDevMode?: boolean;
}

export interface RunSemanticShadowReportOptions {
  path: string;
  since?: string;
}

export interface RunSemanticShadowSoakCheckOptions extends RunSemanticShadowReportOptions {
  env?: NodeJS.ProcessEnv;
  thresholds?: Partial<SemanticShadowSoakThresholds>;
}

export interface RunSemanticShadowSoakExportOptions extends RunSemanticShadowSoakCheckOptions {
  outPath: string;
}

export interface SemanticDogfoodPreflightReport {
  generatedAt: string;
  verdict: "ready-to-collect" | "blocked";
  project: {
    initialized: boolean;
    storageExists: boolean;
  };
  env: {
    shadowUrlSet: boolean;
    shadowTokenSet: boolean;
    shadowAttestationSet: boolean;
    allowUnpinnedDevMode: boolean;
  };
  doctor: SemanticShadowDoctorReport;
  soak: SemanticShadowSoakReport;
  blockers: string[];
  nextActions: string[];
  shadowOnly: true;
  servingPromoted: false;
  privacyTelemetrySafe: boolean;
}

export interface RunSemanticDogfoodPreflightOptions extends RunSemanticShadowReportOptions {
  env?: NodeJS.ProcessEnv;
  outPath?: string;
  allowUnpinnedDevMode?: boolean;
}

export interface RunSemanticObservationExportOptions extends RunSemanticShadowReportOptions {
  outPath: string;
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

function readSemanticEventsIfAvailable(path: string, since?: string): {
  initialized: boolean;
  storageExists: boolean;
  events: AnalyticsEvent[];
} {
  const configDir = findConfigDir(path);
  if (!configDir) return { initialized: false, storageExists: false, events: [] };
  const cfg = loadConfig(path);
  if (!existsSync(cfg.storagePath)) return { initialized: true, storageExists: false, events: [] };
  const db = new Database(cfg.storagePath, { readonly: true });
  try {
    const store = new BlockStore(db, { skipMigrate: true });
    return {
      initialized: true,
      storageExists: true,
      events: store.readEvents({
        eventType: "reasoning.semantic_comparison",
        ...(since ? { afterTs: parseSince(since) } : {}),
        limit: 1_000_000,
      }),
    };
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

export async function runSemanticShadowSoakCheck(
  options: RunSemanticShadowSoakCheckOptions,
): Promise<SemanticShadowSoakReport> {
  const shadow = runSemanticShadowReport(options);
  const doctor = await runSemanticShadowDoctor(options.env);
  return evaluateSemanticShadowSoak({ doctor, shadow }, { thresholds: options.thresholds });
}

export async function runSemanticShadowSoakExport(
  options: RunSemanticShadowSoakExportOptions,
): Promise<SemanticShadowSoakReport> {
  const report = await runSemanticShadowSoakCheck(options);
  writeJsonAtomic(options.outPath, report);
  return report;
}

function sidecarTelemetryDirty(report: Extract<SemanticShadowDoctorReport, { status: "ready" }>): string[] {
  const telemetry = report.telemetry;
  const blockers: string[] = [];
  if (telemetry.rejectedAuth > 0) blockers.push("sidecar auth rejection counter is non-zero");
  if (telemetry.rejectedLeak > 0) blockers.push("sidecar leakage rejection counter is non-zero");
  if (telemetry.rejectedMalformed > 0) blockers.push("sidecar malformed-request counter is non-zero");
  if (telemetry.rejectedTooLarge > 0) blockers.push("sidecar payload-too-large counter is non-zero");
  if (telemetry.rejectedExpired > 0) blockers.push("sidecar expired-request counter is non-zero");
  if (telemetry.quotaExceeded > 0) blockers.push("sidecar quota counter is non-zero");
  if (telemetry.timeouts > 0) blockers.push("sidecar timeout counter is non-zero");
  if (telemetry.overloads > 0) blockers.push("sidecar overload counter is non-zero");
  if (telemetry.backendErrors > 0) blockers.push("sidecar backend-error counter is non-zero");
  return blockers;
}

function dogfoodNextActions(blockers: readonly string[]): string[] {
  if (blockers.length === 0) {
    return [
      "restart the long-lived TraceBase MCP/SDK runtime with the semantic shadow env set",
      "use TraceBase normally until semantic shadow traffic reaches the soak floor",
      "run `tracebase semantic soak-check --since <window> --out <artifact.json>` and preserve the artifact",
    ];
  }
  const actions = new Set<string>();
  for (const blocker of blockers) {
    if (blocker.includes("project is not initialized")) actions.add("run `npx tracebase-ai init` in the project before dogfood collection");
    if (blocker.includes("TRACEBASE_SEMANTIC_SHADOW")) actions.add("set TRACEBASE_SEMANTIC_SHADOW_URL, TOKEN, and pinned ATTESTATION in the long-lived runtime environment");
    if (blocker.includes("doctor")) actions.add("start the semantic sidecar and verify `tracebase semantic doctor` returns ready");
    if (blocker.includes("unpinned")) actions.add("pin TRACEBASE_SEMANTIC_SHADOW_ATTESTATION before production-like dogfood");
    if (blocker.includes("counter")) actions.add("restart the sidecar or investigate dirty sidecar telemetry before starting a fresh soak window");
    if (blocker.includes("privacy")) actions.add("inspect the preflight report path; do not share or commit a failed privacy scan artifact");
  }
  if (actions.size === 0) actions.add("fix the listed blocker, then rerun `tracebase semantic dogfood-preflight`");
  return [...actions].sort();
}

export async function runSemanticDogfoodPreflight(
  options: RunSemanticDogfoodPreflightOptions,
): Promise<SemanticDogfoodPreflightReport> {
  const env = options.env ?? process.env;
  const eventState = readSemanticEventsIfAvailable(options.path, options.since);
  const doctor = await runSemanticShadowDoctor(env);
  const shadow = aggregateSemanticShadow(eventState.events);
  const soak = evaluateSemanticShadowSoak({ doctor, shadow }, {
    thresholds: {
      allowUnpinnedDevMode: options.allowUnpinnedDevMode === true,
    },
  });
  const envSummary = {
    shadowUrlSet: Boolean((env[SEMANTIC_SHADOW_URL_ENV] ?? "").trim()),
    shadowTokenSet: Boolean((env[SEMANTIC_SHADOW_TOKEN_ENV] ?? "").trim()),
    shadowAttestationSet: Boolean((env[SEMANTIC_SHADOW_ATTESTATION_ENV] ?? "").trim()),
    allowUnpinnedDevMode: (env[SEMANTIC_SHADOW_ALLOW_UNPINNED_ENV] ?? "").trim() === "1" ||
      options.allowUnpinnedDevMode === true,
  };
  const blockers: string[] = [];
  if (!eventState.initialized) blockers.push("project is not initialized");
  if (!envSummary.shadowUrlSet) blockers.push(`${SEMANTIC_SHADOW_URL_ENV} is not set`);
  if (!envSummary.shadowTokenSet) blockers.push(`${SEMANTIC_SHADOW_TOKEN_ENV} is not set`);
  if (!envSummary.shadowAttestationSet && !envSummary.allowUnpinnedDevMode) {
    blockers.push(`${SEMANTIC_SHADOW_ATTESTATION_ENV} is not set`);
  }
  if (doctor.status !== "ready") blockers.push(`semantic sidecar doctor is ${doctor.status}`);
  if (doctor.status === "ready") {
    if (!envSummary.allowUnpinnedDevMode && doctor.unpinnedDevMode) {
      blockers.push("semantic sidecar is running unpinned");
    }
    blockers.push(...sidecarTelemetryDirty(doctor));
  }

  const reportWithoutPrivacy = {
    generatedAt: new Date().toISOString(),
    verdict: "blocked" as const,
    project: {
      initialized: eventState.initialized,
      storageExists: eventState.storageExists,
    },
    env: envSummary,
    doctor,
    soak,
    blockers,
    nextActions: [] as string[],
    shadowOnly: true as const,
    servingPromoted: false as const,
  };
  const privacyTelemetrySafe = detectLeakageExtended(JSON.stringify(reportWithoutPrivacy)) === null;
  if (!privacyTelemetrySafe) blockers.push("dogfood preflight report failed privacy scan");
  const report: SemanticDogfoodPreflightReport = {
    ...reportWithoutPrivacy,
    verdict: blockers.length === 0 ? "ready-to-collect" : "blocked",
    blockers: blockers.sort(),
    nextActions: dogfoodNextActions(blockers),
    privacyTelemetrySafe,
  };
  if (options.outPath) writeJsonAtomic(options.outPath, report);
  return report;
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

export function runSemanticObservationExport(
  options: RunSemanticObservationExportOptions,
): SemanticShadowObservationSkeleton[] {
  const observations = collectSemanticShadowObservations(readSemanticEvents(options.path, options.since));
  writeJsonAtomic(options.outPath, observations);
  return observations;
}

export function runSemanticShadowDoctor(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SemanticShadowDoctorReport> {
  return probeSemanticShadow(env);
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

function parseNonNegativeInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${flag} must be a non-negative integer`);
  return n;
}

function buildSoakThresholds(opts: SoakOptions): Partial<SemanticShadowSoakThresholds> {
  const thresholds: Partial<SemanticShadowSoakThresholds> = {};
  const minTraffic = parseNonNegativeInt(opts.minTraffic, "--min-traffic");
  const minV4Abstain = parseNonNegativeInt(opts.minV4Abstain, "--min-v4-abstain");
  const minResidualRecovery = parseNonNegativeInt(opts.minResidualRecovery, "--min-residual-recovery");
  const minWarmCompletions = parseNonNegativeInt(opts.minWarmCompletions, "--min-warm-completions");
  const maxLatencyP95Ms = parseNonNegativeInt(opts.maxLatencyP95Ms, "--max-latency-p95-ms");
  const maxWarmLatencyP95Ms = parseNonNegativeInt(opts.maxWarmLatencyP95Ms, "--max-warm-latency-p95-ms");
  const maxWarmQueuePending = parseNonNegativeInt(opts.maxWarmQueuePending, "--max-warm-queue-pending");
  if (minTraffic !== undefined) thresholds.minTraffic = minTraffic;
  if (minV4Abstain !== undefined) thresholds.minV4Abstain = minV4Abstain;
  if (minResidualRecovery !== undefined) thresholds.minSemanticResidualRecovery = minResidualRecovery;
  if (minWarmCompletions !== undefined) thresholds.minWarmCompletions = minWarmCompletions;
  if (maxLatencyP95Ms !== undefined) thresholds.maxLatencyP95Ms = maxLatencyP95Ms;
  if (maxWarmLatencyP95Ms !== undefined) thresholds.maxWarmLatencyP95Ms = maxWarmLatencyP95Ms;
  if (maxWarmQueuePending !== undefined) thresholds.maxWarmQueuePending = maxWarmQueuePending;
  if (opts.allowUnpinnedDevMode) thresholds.allowUnpinnedDevMode = true;
  return thresholds;
}

function printSoakReport(report: SemanticShadowSoakReport): void {
  console.log(pc.bold("Semantic shadow soak check"));
  const verdict = report.verdict === "ready" ? pc.green("READY") : pc.yellow("NOT READY");
  console.log(pc.dim("  verdict:            ") + verdict);
  console.log(pc.dim("  shadow-only:        ") + String(report.shadowOnly));
  console.log(pc.dim("  serving promoted:   ") + String(report.servingPromoted));
  console.log(pc.dim("  doctor:             ") + report.doctor.status);
  if (report.doctor.status === "ready") {
    console.log(pc.dim("  attestation:        ") + report.doctor.attestationId);
    console.log(pc.dim("  sidecar served:     ") + report.doctor.telemetry.served);
  }
  console.log(pc.dim("  traffic:            ") + report.shadow.traffic);
  console.log(pc.dim("  V4 abstain:         ") + report.shadow.baseline.abstain);
  console.log(
    pc.dim("  residual recovery:  ") +
      `${report.shadow.residual.semanticApplicable}/${report.shadow.residual.v4Abstain}`,
  );
  console.log(pc.dim("  latency p95:        ") + `${report.shadow.latencyMs.p95}ms`);
  console.log(
    pc.dim("  warm completed:     ") +
      String(report.shadow.latestHealth?.warmsCompleted ?? 0),
  );
  if (report.blockers.length === 0) {
    console.log(pc.green("  blockers:           none"));
  } else {
    console.log(pc.yellow("  blockers:"));
    for (const blocker of report.blockers) console.log(pc.yellow("    - " + blocker));
  }
}

function printDogfoodPreflightReport(report: SemanticDogfoodPreflightReport): void {
  console.log(pc.bold("Semantic shadow dogfood preflight"));
  const verdict = report.verdict === "ready-to-collect" ? pc.green("READY TO COLLECT") : pc.yellow("BLOCKED");
  console.log(pc.dim("  verdict:            ") + verdict);
  console.log(pc.dim("  project initialized:") + " " + String(report.project.initialized));
  console.log(pc.dim("  storage exists:     ") + String(report.project.storageExists));
  console.log(pc.dim("  shadow env:         ") +
    `url=${report.env.shadowUrlSet} token=${report.env.shadowTokenSet} ` +
    `attestation=${report.env.shadowAttestationSet}`);
  console.log(pc.dim("  doctor:             ") + report.doctor.status);
  console.log(pc.dim("  current traffic:    ") + report.soak.shadow.traffic);
  if (report.blockers.length === 0) {
    console.log(pc.green("  blockers:           none"));
  } else {
    console.log(pc.yellow("  blockers:"));
    for (const blocker of report.blockers) console.log(pc.yellow("    - " + blocker));
  }
  console.log(pc.dim("  next:"));
  for (const action of report.nextActions) console.log(pc.dim("    - " + action));
}

function fail(error: unknown): void {
  console.error(pc.red("Error: ") + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}

export const semanticCommand = new Command("semantic")
  .description("Inspect and freeze the shadow-only semantic applicability lane")
  .addCommand(
    new Command("doctor")
      .description("Probe configured shadow endpoint liveness, auth, and pinned attestation")
      .option("--json", "machine-readable JSON output")
      .action(async (opts: Pick<BaseOptions, "json">) => {
        try {
          const report = await runSemanticShadowDoctor();
          if (opts.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
          else {
            console.log(pc.bold("Semantic shadow doctor"));
            console.log(pc.dim("  status: ") + report.status);
            if ("endpoint" in report) console.log(pc.dim("  endpoint: ") + report.endpoint);
            if (report.status === "ready") {
              console.log(pc.dim("  attestation: ") + report.attestationId);
              console.log(pc.dim("  in-flight: ") + report.inFlight);
            } else if ("reason" in report) {
              console.log(pc.dim("  reason: ") + report.reason);
            }
          }
          if (report.status !== "ready" && report.status !== "off") process.exitCode = 1;
        } catch (error) {
          fail(error);
        }
      }),
  )
  .addCommand(
    new Command("dogfood-preflight")
      .description("Check whether semantic shadow dogfood collection can start safely")
      .option("-p, --path <path>", "project root", process.cwd())
      .option("--since <when>", "window start: relative (7d / 1h / 30m) or ISO / epoch ms")
      .option("--json", "machine-readable JSON output")
      .option("--out <path>", "write the privacy-safe preflight JSON atomically")
      .option("--allow-unpinned-dev-mode", "allow unpinned sidecar attestation for local development only")
      .action(async (opts: DogfoodPreflightOptions) => {
        try {
          const report = await runSemanticDogfoodPreflight({
            path: opts.path,
            ...(opts.since ? { since: opts.since } : {}),
            ...(opts.out ? { outPath: opts.out } : {}),
            ...(opts.allowUnpinnedDevMode ? { allowUnpinnedDevMode: true } : {}),
          });
          if (opts.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
          else {
            printDogfoodPreflightReport(report);
            if (opts.out) console.log(pc.dim("  output:             ") + opts.out);
          }
          if (report.verdict !== "ready-to-collect") process.exitCode = 1;
        } catch (error) {
          fail(error);
        }
      }),
  )
  .addCommand(
    new Command("soak-check")
      .description("Evaluate shadow-only sidecar soak readiness from doctor + local telemetry")
      .option("-p, --path <path>", "project root", process.cwd())
      .option("--since <when>", "window start: relative (7d / 1h / 30m) or ISO / epoch ms")
      .option("--json", "machine-readable JSON output")
      .option("--out <path>", "write the full privacy-safe soak report JSON atomically")
      .option("--min-traffic <n>", "minimum semantic comparison events")
      .option("--min-v4-abstain <n>", "minimum V4-abstain residual observations")
      .option("--min-residual-recovery <n>", "minimum semantic applicable residual observations")
      .option("--min-warm-completions <n>", "minimum completed cache warm operations")
      .option("--max-latency-p95-ms <n>", "maximum comparison p95 latency in ms")
      .option("--max-warm-latency-p95-ms <n>", "maximum warm p95 latency in ms")
      .option("--max-warm-queue-pending <n>", "maximum pending warm queue items at sample time")
      .option("--allow-unpinned-dev-mode", "allow unpinned sidecar attestation for local development only")
      .action(async (opts: SoakOptions) => {
        try {
          const report = await runSemanticShadowSoakCheck({
            path: opts.path,
            ...(opts.since ? { since: opts.since } : {}),
            thresholds: buildSoakThresholds(opts),
          });
          if (opts.out) writeJsonAtomic(opts.out, report);
          if (opts.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
          else {
            printSoakReport(report);
            if (opts.out) console.log(pc.dim("  output:             ") + opts.out);
          }
          if (report.verdict !== "ready") process.exitCode = 1;
        } catch (error) {
          fail(error);
        }
      }),
  )
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
    new Command("export-observations")
      .description("Export privacy-safe local shadow observation skeletons for operator labeling")
      .requiredOption("--out <path>", "output observation JSON path")
      .option("-p, --path <path>", "project root", process.cwd())
      .option("--since <when>", "window start: relative (7d / 1h / 30m) or ISO / epoch ms")
      .option("--json", "machine-readable JSON output")
      .action((opts: ObservationExportOptions) => {
        try {
          const observations = runSemanticObservationExport({
            path: opts.path,
            outPath: opts.out,
            ...(opts.since ? { since: opts.since } : {}),
          });
          const summary = { out: opts.out, observations: observations.length };
          if (opts.json) process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
          else console.log(pc.green("Exported.") + ` ${summary.observations} privacy-safe semantic observation skeletons`);
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
