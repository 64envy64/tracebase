/**
 * `tracebase cascade` — May-2026 B1.4 operational surface.
 *
 * Before this PR, ramping the cascade meant hand-editing
 * `.tracebase/config.json`. That's infrastructure, not a product.
 * Subcommands here are the entire human-facing rollout pathway:
 *
 *   tracebase cascade enable [--rate R] [--kind K] [--endpoint URL]
 *   tracebase cascade disable
 *   tracebase cascade set-rate <rate>
 *   tracebase cascade set-kind <kind>
 *   tracebase cascade status
 *   tracebase cascade compare [--since DURATION]
 *
 * The full ramp loop:
 *
 *   1. `enable --rate 0.01 --kind minilm` — 1% canary
 *   2. wait, accumulate events
 *   3. `compare` — see cascade vs sync helpful-rate split
 *   4. `set-rate 0.05` if the lift looks real, or `disable` if not
 *
 * All writes round-trip through `core/config.ts` helpers (B1.4),
 * which now merge fields instead of replacing — adding cascade
 * never wipes holdout and vice-versa.
 */
import { Command } from "commander";
import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import pc from "picocolors";
import {
  DEFAULT_CASCADE_RATE,
  disableCascade,
  enableCascade,
  findProjectRoot,
  loadConfig,
  readCascadeConfig,
  setCascadeKind,
  setCascadeRate,
  type CascadeRerankerKind,
} from "../../core/config.js";
import { BlockStore } from "../../core/block-store.js";
import {
  computeCascadeComparisonByDay,
  computeCascadeComparison,
  MIN_SAMPLE,
  type CascadeArmMetrics,
  type CascadeComparisonBucket,
  type CascadeComparison,
} from "../../lifecycle/cascade-compare.js";

interface BaseOpts {
  path: string;
  json?: boolean;
}

interface EnableOpts extends BaseOpts {
  rate?: string;
  kind?: string;
  endpoint?: string;
  apiKey?: string;
  model?: string;
}

interface SetRateOpts extends BaseOpts {
  rate?: string;
}

interface SetKindOpts extends BaseOpts {
  kind?: string;
}

interface CompareOpts extends BaseOpts {
  since?: string;
  byDay?: boolean;
}

const KINDS: readonly CascadeRerankerKind[] = ["noop", "cloud", "minilm", "bge-v2-m3"];

export const cascadeCommand = new Command("cascade")
  .description(
    "Manage the B1 retrieval cascade: enable / disable / set-rate / set-kind / status / compare. " +
      "Replaces hand-editing .tracebase/config.json.",
  )
  .addCommand(
    new Command("enable")
      .description(
        "Enable the cascade. Idempotent — re-running with new flags updates the config without " +
          "resetting unrelated fields (salt and createdAt are preserved across cycles).",
      )
      .option("-p, --path <path>", "project root", process.cwd())
      .option(
        "--rate <rate>",
        `rollout rate in (0, 1]; defaults to ${DEFAULT_CASCADE_RATE} (5%)`,
      )
      .option(
        "--kind <kind>",
        `reranker kind: ${KINDS.join(" | ")}`,
      )
      .option("--endpoint <url>", "CloudReranker endpoint (kind=cloud)")
      .option("--api-key <key>", "Bearer token for the cloud endpoint")
      .option("--model <id>", "model id pass-through")
      .option("--json", "machine-readable output")
      .action((opts: EnableOpts) => runEnable(opts)),
  )
  .addCommand(
    new Command("disable")
      .description(
        "Flip the cascade master switch to false. Salt and tunables are preserved so " +
          "`enable` later resumes at the same configuration.",
      )
      .option("-p, --path <path>", "project root", process.cwd())
      .option("--json", "machine-readable output")
      .action((opts: BaseOpts) => runDisable(opts)),
  )
  .addCommand(
    new Command("set-rate")
      .description(
        "Update only the rollout rate. The common ramp operation: " +
          "`set-rate 0.05` after the canary phase, `set-rate 0` for an emergency rollback " +
          "that doesn't touch the rest of the config.",
      )
      .option("-p, --path <path>", "project root", process.cwd())
      .option("--rate <rate>", "new rate in [0, 1] (0 = effectively disabled for routing)")
      .option("--json", "machine-readable output")
      .action((opts: SetRateOpts) => runSetRate(opts)),
  )
  .addCommand(
    new Command("set-kind")
      .description(
        "Update only the reranker kind. NOTE: BlockServer captures the reranker at boot, " +
          "so switching kind requires an MCP server restart to take effect (the rollout rate " +
          "and tunables are hot, but `kind` is not).",
      )
      .option("-p, --path <path>", "project root", process.cwd())
      .option("--kind <kind>", `new reranker kind: ${KINDS.join(" | ")}`)
      .option("--json", "machine-readable output")
      .action((opts: SetKindOpts) => runSetKind(opts)),
  )
  .addCommand(
    new Command("status")
      .description("Print the current cascade config + a one-line summary of recent activity.")
      .option("-p, --path <path>", "project root", process.cwd())
      .option("--json", "machine-readable output")
      .action((opts: BaseOpts) => runStatus(opts)),
  )
  .addCommand(
    new Command("compare")
      .description(
        "A/B view: helpful-rate on the cascade arm vs the sync arm using analytics_events. " +
          "Flags low-sample arms so the reader knows when the lift is below the noise floor.",
      )
      .option("-p, --path <path>", "project root", process.cwd())
      .option(
        "--since <duration>",
        "window the comparison: `7d`, `24h`, `90m`. Default: all-time.",
      )
      .option("--by-day", "include a UTC daily trend table")
      .option("--json", "machine-readable output")
      .action((opts: CompareOpts) => runCompare(opts)),
  )
  .addCommand(
    new Command("explain")
      .description(
        "Post-mortem one query: which arm it landed in, what BM25 + reranker chose, " +
          "whether the cascade fell back, and what got injected. " +
          "Pass the queryId from a prior get_reasoning_patterns or trace_retrieval event.",
      )
      .argument("<queryId>", "queryId returned by get_reasoning_patterns / recall")
      .option("-p, --path <path>", "project root", process.cwd())
      .option("--json", "machine-readable output")
      .action((queryId: string, opts: BaseOpts) => runExplain(queryId, opts)),
  );

// ---------------------------------------------------------------------------
// Subcommand handlers
// ---------------------------------------------------------------------------

function runEnable(opts: EnableOpts): void {
  const basePath = resolveBasePath(opts.path);
  if (!basePath) {
    fail("project not initialised — run `npx tracebase-ai init` first");
    return;
  }
  const rate = opts.rate !== undefined ? Number(opts.rate) : undefined;
  if (rate !== undefined && (!Number.isFinite(rate) || rate <= 0 || rate > 1)) {
    fail(`--rate must be in (0, 1]; got ${opts.rate}`);
    return;
  }
  const kind = opts.kind ? validateKind(opts.kind) : undefined;
  if (opts.kind && !kind) return; // validateKind already printed

  const cfg = enableCascade(basePath, {
    ...(rate !== undefined ? { rate } : {}),
    ...(kind ? { kind } : {}),
    ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
    ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
    ...(opts.model ? { model: opts.model } : {}),
  });
  if (!cfg) {
    fail("project not initialised — run `npx tracebase-ai init` first");
    return;
  }
  emit(opts.json, cfg, () => {
    process.stdout.write(
      pc.green(`✓ cascade enabled`) +
        `  rate=${cfg.rollout.rate}  kind=${cfg.reranker.kind}\n`,
    );
    if (cfg.reranker.kind === "minilm") {
      process.stdout.write(
        pc.dim(
          `  pre-warm with \`tracebase doctor --fix\` so the first production query is hot.\n`,
        ),
      );
    }
    if (cfg.reranker.kind === "cloud" && !cfg.reranker.endpoint) {
      process.stdout.write(
        pc.yellow(
          `  ⚠ kind="cloud" but no --endpoint supplied. doctor will flag this.\n`,
        ),
      );
    }
  });
}

function runDisable(opts: BaseOpts): void {
  const basePath = resolveBasePath(opts.path);
  if (!basePath) {
    fail("project not initialised — run `npx tracebase-ai init` first");
    return;
  }
  const cfg = disableCascade(basePath);
  if (!cfg) {
    emit(opts.json, { disabled: false, reason: "no-cascade-config" }, () => {
      process.stdout.write(pc.dim(`cascade was never configured on this project — nothing to disable.\n`));
    });
    return;
  }
  emit(opts.json, cfg, () => {
    process.stdout.write(pc.green(`✓ cascade disabled`) + ` (config preserved for re-enable)\n`);
  });
}

function runSetRate(opts: SetRateOpts): void {
  const basePath = resolveBasePath(opts.path);
  if (!basePath) {
    fail("project not initialised — run `npx tracebase-ai init` first");
    return;
  }
  if (opts.rate === undefined) {
    fail("--rate is required");
    return;
  }
  const rate = Number(opts.rate);
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
    fail(`--rate must be in [0, 1]; got ${opts.rate}`);
    return;
  }
  const cfg = setCascadeRate(basePath, rate);
  if (!cfg) {
    fail("cascade not configured — run `tracebase cascade enable` first");
    return;
  }
  emit(opts.json, cfg, () => {
    process.stdout.write(pc.green(`✓ rate → ${rate}`) + `  (kind=${cfg.reranker.kind}, enabled=${cfg.enabled})\n`);
  });
}

function runSetKind(opts: SetKindOpts): void {
  const basePath = resolveBasePath(opts.path);
  if (!basePath) {
    fail("project not initialised — run `npx tracebase-ai init` first");
    return;
  }
  if (!opts.kind) {
    fail("--kind is required");
    return;
  }
  const kind = validateKind(opts.kind);
  if (!kind) return;
  const cfg = setCascadeKind(basePath, kind);
  if (!cfg) {
    fail("cascade not configured — run `tracebase cascade enable` first");
    return;
  }
  emit(opts.json, cfg, () => {
    process.stdout.write(
      pc.green(`✓ kind → ${kind}`) +
        `  ${pc.yellow("restart the MCP server to load the new reranker.")}\n`,
    );
  });
}

function runStatus(opts: BaseOpts): void {
  const basePath = resolveBasePath(opts.path);
  if (!basePath) {
    fail("project not initialised — run `npx tracebase-ai init` first");
    return;
  }
  const cfg = readCascadeConfig(basePath);
  if (!cfg) {
    emit(opts.json, { configured: false }, () => {
      process.stdout.write(
        pc.dim(`cascade not configured. Run \`tracebase cascade enable\` to start a canary rollout.\n`),
      );
    });
    return;
  }
  emit(opts.json, cfg, () => {
    const state = cfg.enabled ? pc.green("on") : pc.dim("off");
    process.stdout.write(
      `cascade: ${state}  rate=${cfg.rollout.rate}  kind=${cfg.reranker.kind}` +
        (cfg.reranker.endpoint ? `  endpoint=${cfg.reranker.endpoint}` : "") +
        `\n`,
    );
    if (cfg.timeoutMs !== undefined || cfg.mmrLambda !== undefined || cfg.fetchMultiplier !== undefined) {
      const parts: string[] = [];
      if (cfg.timeoutMs !== undefined) parts.push(`timeout=${cfg.timeoutMs}ms`);
      if (cfg.mmrLambda !== undefined) parts.push(`λ=${cfg.mmrLambda}`);
      if (cfg.fetchMultiplier !== undefined) parts.push(`×${cfg.fetchMultiplier} fetch`);
      process.stdout.write(pc.dim(`  ${parts.join("  ")}\n`));
    }
    process.stdout.write(pc.dim(`  created ${cfg.createdAt}, updated ${cfg.updatedAt}\n`));
  });
}

function runCompare(opts: CompareOpts): void {
  const basePath = resolveBasePath(opts.path);
  if (!basePath) {
    fail("project not initialised — run `npx tracebase-ai init` first");
    return;
  }
  const config = loadConfig(basePath);
  if (!existsSync(config.storagePath)) {
    emit(opts.json, { comparison: null, reason: "no-store" }, () => {
      process.stdout.write(pc.dim(`no memory.db yet — no events to compare.\n`));
    });
    return;
  }
  let afterTs: number | undefined;
  if (opts.since) {
    const parsed = parseDurationAgo(opts.since);
    if (parsed === null) {
      fail(`--since must look like "7d", "24h", or "90m"; got "${opts.since}"`);
      return;
    }
    afterTs = parsed;
  }
  const db = new Database(config.storagePath, { readonly: true });
  try {
    const store = new BlockStore(db, { skipMigrate: true });
    const cmp = computeCascadeComparison(store, {
      ...(afterTs !== undefined ? { afterTs } : {}),
    });
    if (opts.byDay) {
      const byDay = computeCascadeComparisonByDay(store, {
        ...(afterTs !== undefined ? { afterTs } : {}),
      });
      emit(opts.json, { summary: cmp, byDay }, () => {
        renderCompare(cmp);
        renderByDay(byDay);
      });
    } else {
      emit(opts.json, cmp, () => renderCompare(cmp));
    }
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Rendering + helpers
// ---------------------------------------------------------------------------

function renderCompare(c: CascadeComparison): void {
  if (c.lowSample) {
    process.stdout.write(
      pc.yellow(`⚠ low sample`) +
        `  (need ≥${MIN_SAMPLE} outcomes per arm; have ${c.cascade.totalRuns} cascade / ${c.sync.totalRuns} sync). ` +
        `lift below the noise floor.\n\n`,
    );
  }
  process.stdout.write(renderArm("cascade", c.cascade) + "\n");
  process.stdout.write(renderArm("sync   ", c.sync) + "\n");
  if (c.lift !== null) {
    const liftStr = (c.lift * 100).toFixed(2) + "%";
    const colored = c.lift > 0 ? pc.green(`+${liftStr}`) : c.lift < 0 ? pc.red(liftStr) : pc.dim(liftStr);
    process.stdout.write(`\nhelpful-rate lift (cascade − sync): ${colored}\n`);
  }
  const fb = c.cascadeFallback;
  const fbTotal = fb.timeout + fb.error + fb.null + fb.empty + fb.validation;
  if (c.cascade.retrievals > 0) {
    process.stdout.write(
      `\ncascade reranker: ${c.cascadeRerankerRan} ran successfully, ${fbTotal} fell back` +
        (fbTotal > 0
          ? `  (${["timeout", "error", "null", "empty", "validation"]
              .map((k) => `${k}=${fb[k as keyof typeof fb]}`)
              .filter((s) => !s.endsWith("=0"))
              .join(", ")})`
          : "") +
        `\n`,
    );
  }
}

function renderArm(label: string, arm: CascadeArmMetrics): string {
  const rate =
    arm.helpfulRate === null ? "—" : (arm.helpfulRate * 100).toFixed(2) + "%";
  return `${label}  retrievals=${arm.retrievals}  injections=${arm.injections}  helpful=${arm.helpfulRuns}/${arm.totalRuns}  rate=${rate}`;
}

function renderByDay(buckets: CascadeComparisonBucket[]): void {
  if (buckets.length === 0) return;
  process.stdout.write(`\nby day (UTC)\n`);
  for (const bucket of buckets) {
    const c = bucket.comparison;
    const lift =
      c.lift === null
        ? "lift=--"
        : `lift=${c.lift >= 0 ? "+" : ""}${(c.lift * 100).toFixed(2)}pp`;
    const cascadeRate = formatRate(c.cascade.helpfulRate);
    const syncRate = formatRate(c.sync.helpfulRate);
    const low = c.lowSample ? "  low-sample" : "";
    process.stdout.write(
      `  ${bucket.day}  cascade=${cascadeRate} (${c.cascade.helpfulRuns}/${c.cascade.totalRuns})` +
        `  sync=${syncRate} (${c.sync.helpfulRuns}/${c.sync.totalRuns})  ${lift}${low}\n`,
    );
  }
}

function formatRate(rate: number | null): string {
  return rate === null ? "--" : (rate * 100).toFixed(2) + "%";
}

function validateKind(input: string): CascadeRerankerKind | null {
  if ((KINDS as readonly string[]).includes(input)) {
    return input as CascadeRerankerKind;
  }
  fail(`--kind must be one of: ${KINDS.join(", ")}; got "${input}"`);
  return null;
}

/**
 * Parse `"7d" / "24h" / "90m"` into an absolute `afterTs` timestamp.
 * Returns `null` for malformed input so the caller can fail loudly.
 */
function parseDurationAgo(s: string): number | null {
  const m = /^(\d+)([dhm])$/.exec(s.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2]!;
  const ms =
    unit === "d" ? n * 24 * 60 * 60 * 1000 : unit === "h" ? n * 60 * 60 * 1000 : n * 60 * 1000;
  return Date.now() - ms;
}

/**
 * B1.6 explain — post-mortem on a single queryId.
 *
 * Reads every event tagged with `queryId` and renders:
 *   • the arm (cascade vs sync, decided by cascadePolicyId)
 *   • the slate the user actually saw (selectedTraceIds when stamped,
 *     otherwise the candidates list from the retrieval event)
 *   • reranker outcome — succeeded vs fellBack + reason
 *   • blocks the cascade decided to inject
 *   • whether outcome closed (resolved/not)
 *
 * The whole point is debugging "why did THIS query surface THESE
 * blocks". Without explain users would have to read raw event JSONL
 * and hand-correlate by queryId.
 */
interface ExplainReport {
  queryId: string;
  found: boolean;
  arm?: "cascade" | "sync";
  cascadePolicyId?: string;
  rerankerName?: string;
  rerankerFellBack?: boolean;
  rerankerFallbackReason?: string;
  mmrLambda?: number;
  shadow?: boolean;
  candidateCount?: number;
  injectedBlockIds: string[];
  injectedFactIds: string[];
  usedBlockIds: string[];
  usedFactIds: string[];
  outcome?: { resolved: boolean; durationMs?: number };
}

function runExplain(queryId: string, opts: BaseOpts): void {
  const basePath = resolveBasePath(opts.path);
  if (!basePath) {
    fail("project not initialised — run `npx tracebase-ai init` first");
    return;
  }
  const config = loadConfig(basePath);
  if (!existsSync(config.storagePath)) {
    emit(opts.json, { queryId, found: false }, () => {
      process.stdout.write(pc.dim(`no memory.db yet — nothing to explain.\n`));
    });
    return;
  }
  const db = new Database(config.storagePath, { readonly: true });
  try {
    const store = new BlockStore(db, { skipMigrate: true });
    const events = store.readEvents({ queryId, limit: 1000 });
    if (events.length === 0) {
      emit(opts.json, { queryId, found: false }, () => {
        process.stdout.write(pc.dim(`queryId not found in event log.\n`));
      });
      return;
    }
    const report = buildExplainReport(queryId, events);
    emit(opts.json, report, () => renderExplain(report));
  } finally {
    db.close();
  }
}

function buildExplainReport(
  queryId: string,
  events: ReadonlyArray<import("../../types.js").AnalyticsEvent>,
): ExplainReport {
  const report: ExplainReport = {
    queryId,
    found: true,
    injectedBlockIds: [],
    injectedFactIds: [],
    usedBlockIds: [],
    usedFactIds: [],
  };
  for (const ev of events) {
    if (ev.event === "retrieval") {
      const isCascade =
        typeof ev.cascadePolicyId === "string" && ev.cascadePolicyId.length > 0;
      report.arm = isCascade ? "cascade" : "sync";
      report.shadow = ev.shadow;
      report.candidateCount = ev.candidates.length;
      if (isCascade) {
        report.cascadePolicyId = ev.cascadePolicyId;
        report.rerankerName = ev.rerankerName;
        report.rerankerFellBack = ev.rerankerFellBack;
        report.rerankerFallbackReason = ev.rerankerFallbackReason;
        report.mmrLambda = ev.mmrLambda;
      }
    } else if (ev.event === "injection" && !report.injectedBlockIds.includes(ev.blockId)) {
      report.injectedBlockIds.push(ev.blockId);
    } else if (ev.event === "fact_injection" && !report.injectedFactIds.includes(ev.factId)) {
      report.injectedFactIds.push(ev.factId);
    } else if (ev.event === "agent_used" && !report.usedBlockIds.includes(ev.blockId)) {
      report.usedBlockIds.push(ev.blockId);
    } else if (ev.event === "fact_agent_used" && !report.usedFactIds.includes(ev.factId)) {
      report.usedFactIds.push(ev.factId);
    } else if (ev.event === "outcome") {
      report.outcome = {
        resolved: ev.resolved,
        ...(ev.durationMs !== undefined ? { durationMs: ev.durationMs } : {}),
      };
    }
  }
  return report;
}

function renderExplain(r: ExplainReport): void {
  process.stdout.write(`query ${r.queryId}\n`);
  if (r.arm === "cascade") {
    const policy = r.cascadePolicyId ?? "unknown";
    if (r.rerankerFellBack) {
      const reason = r.rerankerFallbackReason ? ` (${r.rerankerFallbackReason})` : "";
      process.stdout.write(
        `  arm:        ${pc.yellow("cascade — fell back")}${reason}\n`,
      );
    } else {
      process.stdout.write(
        `  arm:        ${pc.green("cascade")}  reranker=${r.rerankerName ?? "unknown"}\n`,
      );
    }
    process.stdout.write(`  policy:     ${policy}\n`);
    if (r.mmrLambda !== undefined) process.stdout.write(`  mmrLambda:  ${r.mmrLambda}\n`);
  } else if (r.arm === "sync") {
    process.stdout.write(`  arm:        ${pc.dim("sync")}  (cascade rollout did not route this query)\n`);
  } else {
    process.stdout.write(`  arm:        ${pc.dim("unknown — no retrieval event")}\n`);
  }
  if (r.shadow) {
    process.stdout.write(pc.dim(`  shadow:     true — no injection fired\n`));
  }
  if (r.candidateCount !== undefined) {
    process.stdout.write(`  candidates: ${r.candidateCount} scored\n`);
  }
  process.stdout.write(
    `  injected:   ${r.injectedBlockIds.length} block(s), ${r.injectedFactIds.length} fact(s)\n`,
  );
  if (r.injectedBlockIds.length > 0) {
    process.stdout.write(pc.dim(`    blocks: ${r.injectedBlockIds.join(", ")}\n`));
  }
  if (r.injectedFactIds.length > 0) {
    process.stdout.write(pc.dim(`    facts:  ${r.injectedFactIds.join(", ")}\n`));
  }
  process.stdout.write(
    `  used:       ${r.usedBlockIds.length} block(s), ${r.usedFactIds.length} fact(s)\n`,
  );
  if (r.outcome) {
    const resolved = r.outcome.resolved ? pc.green("resolved") : pc.red("not resolved");
    const ms = r.outcome.durationMs !== undefined ? `  durationMs=${r.outcome.durationMs}` : "";
    process.stdout.write(`  outcome:    ${resolved}${ms}\n`);
  } else {
    process.stdout.write(pc.dim(`  outcome:    not yet recorded\n`));
  }
}

function resolveBasePath(explicit: string): string | null {
  const root = findProjectRoot(explicit);
  return root ?? null;
}

function fail(message: string): void {
  process.stderr.write(pc.red(`✗ ${message}\n`));
  process.exitCode = 1;
}

function emit<T>(asJson: boolean | undefined, payload: T, renderText: () => void): void {
  if (asJson) {
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  } else {
    renderText();
  }
}
