/**
 * `tracebase memory` — local memory maintenance commands.
 *
 * Subcommand `prune` re-applies the 0.5.7 §A quality gate
 * (`isPatternShapedSituation` from `capture-turn.ts`) as a
 * classifier against existing active reasoning_blocks. The
 * trust boundary differs from capture: prune is destructive
 * (status retired), so it MUST have higher precision than the
 * capture gate. False retire is worse than false keep.
 *
 * 0.5.8 split — two confidence bands:
 *
 *   HIGH-confidence (default candidates):
 *     - `meta-wrap-lead`            — Claude Code session-
 *       continuation / `<command-name>` / etc. leaks
 *     - `project-management-lead`   — release/approval/scheduling
 *       leads ("Plan approved", "Start 0.5.x", "Yes, schedule",
 *       RU equivalents). These are operationally always noise.
 *
 *   LOW-confidence (omitted by default; `--include-low-confidence`
 *   adds them):
 *     - `no-problem-signal`         — situation has no `?` and
 *       no error/bug/regression vocabulary. Captures patterns
 *       like "Installer owns a multi-field entry…" or
 *       "Optional array parameter calls map/filter/reduce…"
 *       which ARE legitimate reusable patterns even though they
 *       never had a literal `?`. Only retired with explicit opt-in.
 *
 * Two modes:
 *
 *   * `--dry-run` (DEFAULT) — print candidates and exit. Nothing
 *     in the store changes. Safe everywhere.
 *
 *   * `--apply` — retire each HIGH-confidence candidate
 *     (status: active → retired). Reversible: status update,
 *     not delete. Combine with `--include-low-confidence` to
 *     also retire low-confidence blocks (still reversible).
 *
 * Never runs from runtime hooks. Manual / explicit only.
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
import { isPatternShapedSituation } from "./capture-turn.js";
import {
  computeMemoryHealth,
  DEFAULT_MEMORY_HEALTH_CONFIG,
  type MemoryHealthReport,
  type MemoryHealthScore,
} from "../../lifecycle/memory-health.js";

interface PruneOptions {
  path?: string;
  apply?: boolean;
  // `--dry-run` defaults true; explicit `--apply` toggles.
  dryRun?: boolean;
  /**
   * 0.5.8 — opt-in to retire `no-problem-signal` blocks too.
   * The capture gate rejects them at write time, but for
   * EXISTING active blocks they include legitimate reusable
   * patterns like "Installer owns a multi-field entry…" that
   * happen not to use a literal `?` or "error" word. Off by
   * default; users review the LOW-confidence list first.
   */
  includeLowConfidence?: boolean;
}

export const memoryCommand = new Command("memory")
  .description("Local memory maintenance (prune, inspect)")
  .addCommand(
    new Command("prune")
      .description(
        "Sweep active reasoning_blocks against the current quality gate. " +
          "--dry-run by default; pass --apply to retire HIGH-confidence " +
          "candidates. Low-confidence blocks (no problem signal but " +
          "potentially valid reusable patterns) are listed separately and " +
          "only retired with --include-low-confidence.",
      )
      .option("-p, --path <path>", "project root", process.cwd())
      .option(
        "--apply",
        "retire HIGH-confidence candidates (active → retired). Without this flag, prune is read-only.",
      )
      .option(
        "--dry-run",
        "(default) list candidates without changing anything",
      )
      .option(
        "--include-low-confidence",
        "ALSO consider blocks with no explicit problem signal as candidates. " +
          "Off by default — false retire of a real reusable pattern is worse than keeping noise.",
      )
      .action(async (opts: PruneOptions) => {
        const result = runMemoryPrune(opts);
        renderPruneReport(result);
        if (result.error) process.exitCode = 1;
      }),
  )
  .addCommand(
    new Command("health")
      .description(
        "Read-only C3 health scoring. Prints the lowest-scoring " +
          "active blocks with the component breakdown (wilson_lb, " +
          "counterproductive_rate, stale/duplication/genericness/" +
          "negative-ROI penalties) and the demotion reason codes. " +
          "No store mutations — C4 will wire the demotion pass.",
      )
      .option("-p, --path <path>", "project root", process.cwd())
      .option("--json", "emit the full report as JSON to stdout")
      .option(
        "--top <n>",
        "show the lowest-scoring N blocks (default 20). Pass 0 for all.",
        "20",
      )
      .option(
        "--threshold <value>",
        `composite-health threshold for wouldDemote classification (default ${DEFAULT_MEMORY_HEALTH_CONFIG.demotionThreshold})`,
      )
      .action(async (opts: HealthOptions) => {
        const result = runMemoryHealth(opts);
        if (opts.json) {
          process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        } else {
          renderHealthReport(result, opts);
        }
        if (result.error) process.exitCode = 1;
      }),
  );

// ---------------------------------------------------------------------------
// Pure helper — exported for tests.
// ---------------------------------------------------------------------------

export type PruneRejectReason =
  | "meta-wrap-lead"
  | "project-management-lead"
  | "no-problem-signal";

/**
 * 0.5.8 — confidence band a candidate falls into.
 *   HIGH: always-noise classes. Default-retired by `--apply`.
 *   LOW : "no-problem-signal" — may include legit reusable
 *         patterns; only retired with `--include-low-confidence`.
 */
export type PruneConfidence = "high" | "low";

export interface PruneCandidate {
  blockId: string;
  trigSituation: string;
  reason: PruneRejectReason;
  confidence: PruneConfidence;
}

export interface MemoryPruneOutcome {
  /** Total active blocks scanned. */
  scanned: number;
  /**
   * High-confidence candidates: meta-wrap-lead +
   * project-management-lead. Always retired by `--apply`.
   */
  candidates: PruneCandidate[];
  /**
   * Low-confidence candidates: `no-problem-signal`. Listed
   * for review; retired only when `--include-low-confidence`
   * is set.
   */
  lowConfidenceCandidates: PruneCandidate[];
  /** Block ids that were actually retired (only when `--apply`). */
  retired: string[];
  /** True iff this run wrote to the store. */
  applied: boolean;
  /** True iff `--include-low-confidence` was set on this run. */
  includedLowConfidence: boolean;
  /** Project root resolved from `--path` / cwd. */
  projectRoot: string | null;
  /** Set when the command failed before scanning could complete. */
  error?: string;
}

export function runMemoryPrune(opts: PruneOptions): MemoryPruneOutcome {
  const apply = opts.apply === true;
  const explicitDryRun = opts.dryRun === true;
  // `--apply` and `--dry-run` are mutually exclusive — if both
  // were passed the user is confused; prefer the safer dry-run.
  const effectiveApply = apply && !explicitDryRun;
  const includedLowConfidence = opts.includeLowConfidence === true;

  const projectRoot = resolveBasePath(opts.path);
  if (!projectRoot) {
    return {
      scanned: 0,
      candidates: [],
      lowConfidenceCandidates: [],
      retired: [],
      applied: false,
      includedLowConfidence,
      projectRoot: null,
      error: "not initialized — run `npx tracebase-ai init` first",
    };
  }

  if (!isInitialized(projectRoot)) {
    return {
      scanned: 0,
      candidates: [],
      lowConfidenceCandidates: [],
      retired: [],
      applied: false,
      includedLowConfidence,
      projectRoot,
      error: "not initialized — run `npx tracebase-ai init` first",
    };
  }

  const config = loadConfig(projectRoot);
  if (!existsSync(config.storagePath)) {
    return {
      scanned: 0,
      candidates: [],
      lowConfidenceCandidates: [],
      retired: [],
      applied: false,
      includedLowConfidence,
      projectRoot,
    };
  }

  const db = new Database(config.storagePath);
  const store = new BlockStore(db);
  try {
    const active = store.listBlocks({ status: "active", limit: 100_000 });
    const candidates: PruneCandidate[] = [];
    const lowConfidenceCandidates: PruneCandidate[] = [];
    for (const block of active) {
      const reason = classifyReject(block.trigger.situation);
      if (reason === null) continue;
      const confidence: PruneConfidence =
        reason === "no-problem-signal" ? "low" : "high";
      const candidate: PruneCandidate = {
        blockId: block.id,
        trigSituation: block.trigger.situation,
        reason,
        confidence,
      };
      if (confidence === "high") {
        candidates.push(candidate);
      } else {
        lowConfidenceCandidates.push(candidate);
      }
    }

    if (!effectiveApply) {
      return {
        scanned: active.length,
        candidates,
        lowConfidenceCandidates,
        retired: [],
        applied: false,
        includedLowConfidence,
        projectRoot,
      };
    }

    // Apply path. Always retires HIGH candidates; ALSO retires
    // LOW candidates only when `--include-low-confidence` is
    // explicitly set. False retire of a real reusable pattern
    // is the failure mode we're guarding against — keep this
    // gate explicit at every call site.
    const toRetire = includedLowConfidence
      ? candidates.concat(lowConfidenceCandidates)
      : candidates;

    const retired: string[] = [];
    for (const candidate of toRetire) {
      try {
        const updated = store.updateBlockStatus(candidate.blockId, "retired");
        if (updated) retired.push(candidate.blockId);
      } catch (err) {
        // Per-block failure isn't fatal — the rest of the batch
        // still applies. Continue and surface the block id in the
        // error trail by leaving it out of `retired`.
        process.stderr.write(
          `tracebase memory prune: skip ${candidate.blockId}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }

    return {
      scanned: active.length,
      candidates,
      lowConfidenceCandidates,
      retired,
      applied: true,
      includedLowConfidence,
      projectRoot,
    };
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// Internal — classifier + path resolution
// ---------------------------------------------------------------------------

/**
 * Mirror of `isPatternShapedUserText` in capture-turn.ts but
 * returns a discriminated rejection reason so the prune report
 * can label each candidate. The shared `isPatternShapedSituation`
 * collapses all three predicates into a single boolean — we
 * re-evaluate them here to surface the cause.
 */
function classifyReject(situation: string): PruneCandidate["reason"] | null {
  if (isPatternShapedSituation(situation)) return null;
  // Re-run the predicates in the same order as the gate so the
  // reported `reason` matches the gate's actual rejection cause.
  if (META_WRAP_LEADS.some((re) => re.test(situation))) {
    return "meta-wrap-lead";
  }
  if (PROJECT_MANAGEMENT_LEADS.some((re) => re.test(situation))) {
    return "project-management-lead";
  }
  return "no-problem-signal";
}

// Mirror of the regex sets in `capture-turn.ts`. Kept here so a
// single regression bisects to the predicate definitions in the
// gate module — but `classifyReject` only consults them when
// `isPatternShapedSituation` already returned false.
const META_WRAP_LEADS: readonly RegExp[] = [
  /^This session is being continued from a previous conversation/i,
  /^This conversation is being continued/i,
  /^Continuing from where (we|I) left off/i,
  /^<(command-name|local-command-(caveat|stdout|output)|system-reminder|tracebase)\b/i,
  /^Login successful\s*$/i,
] as const;

const PROJECT_MANAGEMENT_LEADS: readonly RegExp[] = [
  /^plan approved\b/i,
  /^approved\s*(with\b|\.|$)/i,
  /^lgtm\b/i,
  /^ship it\b/i,
  /^start\b.*\b(0\.\d|candidate|implementation|the\s+work|release|0\.5\.|0\.6\.)/i,
  /^bump (to )?\d+\.\d+\b/i,
  /^cut (a |the )?release\b/i,
  /^build (one|a|the)\s+(unified|combined)\b/i,
  /^do(es)? .*later\b/i,
  /^yes,?\s+(schedule|do|continue|proceed|publish|push|ship)\b/i,
  /^schedule (a |the )?follow[- ]?up\b/i,
  /^run (a |the )?smoke\b/i,
  /^(окей|ок|давай|сделай|сделать|запускай|пиши|посмотри|глянь|погляди|продолжи)\b/iu,
  /^(всё|все)\s+(гуд|ок|норм)\b/iu,
] as const;

function resolveBasePath(explicit: string | undefined): string | null {
  if (explicit) return explicit;
  return findProjectRoot(process.cwd()) ?? process.cwd();
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

function renderPruneReport(result: MemoryPruneOutcome): void {
  console.log();
  console.log(pc.bold("TraceBase memory prune"));
  if (result.projectRoot) {
    console.log(pc.dim(`  project   ${result.projectRoot}`));
  }
  console.log(
    pc.dim(`  mode      ${result.applied ? "apply (retiring candidates)" : "dry-run (read-only)"}`),
  );
  if (result.includedLowConfidence) {
    console.log(pc.dim(`            --include-low-confidence (low-confidence candidates ALSO retired)`));
  }
  console.log();

  if (result.error) {
    console.error(pc.red(`  Error: ${result.error}`));
    console.log();
    return;
  }

  if (result.scanned === 0) {
    console.log(pc.dim("  no active blocks in the store yet — nothing to scan"));
    console.log();
    return;
  }

  const high = result.candidates.length;
  const low = result.lowConfidenceCandidates.length;

  console.log(pc.dim(`  scanned   ${result.scanned} active block(s)`));
  console.log(
    pc.dim(`  matches   ${high} high-confidence candidate(s) for retirement`),
  );
  if (low > 0) {
    const lowSuffix = result.includedLowConfidence
      ? " (--include-low-confidence: also retired)"
      : " (not selected by default)";
    console.log(pc.dim(`            ${low} low-confidence candidate(s)${lowSuffix}`));
  }
  console.log();

  if (high === 0 && low === 0) {
    console.log(pc.green("  ✓ store is clean — no candidates match the current quality gate"));
    console.log();
    return;
  }

  if (high > 0) {
    console.log(pc.bold("  HIGH-confidence candidates (always-noise classes):"));
    for (const candidate of result.candidates) {
      const wasRetired = result.retired.includes(candidate.blockId);
      const marker = result.applied ? (wasRetired ? pc.yellow("retired") : pc.red("skipped")) : pc.cyan("would retire");
      const reason = pc.dim(`(${candidate.reason})`);
      const id = pc.dim(candidate.blockId.slice(0, 8) + "…");
      const line = candidate.trigSituation.slice(0, 100);
      console.log(`    ${marker} ${reason} ${id} ${line}`);
    }
    console.log();
  }

  if (low > 0) {
    console.log(
      pc.bold("  LOW-confidence (no-problem-signal — review before retiring):"),
    );
    for (const candidate of result.lowConfidenceCandidates) {
      const wasRetired = result.retired.includes(candidate.blockId);
      let marker: string;
      if (!result.applied) {
        marker = result.includedLowConfidence
          ? pc.cyan("would retire")
          : pc.dim("not selected");
      } else if (result.includedLowConfidence) {
        marker = wasRetired ? pc.yellow("retired") : pc.red("skipped");
      } else {
        marker = pc.dim("not selected");
      }
      const reason = pc.dim(`(${candidate.reason})`);
      const id = pc.dim(candidate.blockId.slice(0, 8) + "…");
      const line = candidate.trigSituation.slice(0, 100);
      console.log(`    ${marker} ${reason} ${id} ${line}`);
    }
    console.log();
  }

  if (!result.applied) {
    console.log(
      pc.dim(
        "  Pass " +
          pc.cyan("--apply") +
          " to retire HIGH-confidence candidates (status active → retired; reversible).",
      ),
    );
    if (low > 0 && !result.includedLowConfidence) {
      console.log(
        pc.dim(
          "  Add " +
            pc.cyan("--include-low-confidence") +
            " to ALSO consider low-confidence blocks. Review the list above first — false retire of a real reusable pattern is worse than keeping noise.",
        ),
      );
    }
    console.log();
  } else {
    console.log(pc.dim(`  ${result.retired.length} block(s) retired.`));
    console.log();
  }
}

// ---------------------------------------------------------------------------
// `tracebase memory health` — read-only C3 health scoring.
//
// Surface contract for this commit:
//   • Reads `BlockStore` + `analytics_events` only.
//   • Writes nothing. No `updateBlockStatus`, no event emission.
//   • Commander parses --top / --threshold as strings; coerce here.
//   • JSON output is the full `MemoryHealthReport` so machine
//     consumers can diff component breakdowns turn-over-turn.
// ---------------------------------------------------------------------------

interface HealthOptions {
  path?: string;
  json?: boolean;
  top?: string;
  threshold?: string;
}

export interface MemoryHealthOutcome extends MemoryHealthReport {
  /** Project root that was scanned, for display in the CLI banner. */
  projectRoot: string | null;
  /** Set when the command failed before scoring could complete. */
  error?: string;
}

export function runMemoryHealth(opts: HealthOptions): MemoryHealthOutcome {
  const projectRoot = resolveBasePath(opts.path);
  const empty = (error?: string): MemoryHealthOutcome => ({
    scanned: 0,
    scored: [],
    wouldDemote: [],
    demotionThreshold: DEFAULT_MEMORY_HEALTH_CONFIG.demotionThreshold,
    window: {},
    generatedAt: Date.now(),
    config: DEFAULT_MEMORY_HEALTH_CONFIG,
    projectRoot,
    ...(error ? { error } : {}),
  });

  if (!projectRoot) return empty("not initialized — run `npx tracebase-ai init` first");
  if (!isInitialized(projectRoot)) return empty("not initialized — run `npx tracebase-ai init` first");
  const config = loadConfig(projectRoot);
  if (!existsSync(config.storagePath)) return empty();

  const threshold = parseOptionalNumber(opts.threshold);

  const db = new Database(config.storagePath);
  const store = new BlockStore(db);
  try {
    const report = computeMemoryHealth(store, {
      ...(threshold !== null ? { config: { demotionThreshold: threshold } } : {}),
    });
    return { ...report, projectRoot };
  } finally {
    store.close();
  }
}

function parseOptionalNumber(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function renderHealthReport(result: MemoryHealthOutcome, opts: HealthOptions): void {
  console.log();
  console.log(pc.bold("TraceBase memory health"));
  if (result.projectRoot) {
    console.log(pc.dim(`  project   ${result.projectRoot}`));
  }
  console.log(pc.dim(`  mode      dry-run (read-only — C4 wires the demotion pass)`));
  console.log(pc.dim(`  threshold ${result.demotionThreshold.toFixed(3)} (blocks with health ≤ threshold listed below)`));
  console.log();

  if (result.error) {
    console.error(pc.red(`  Error: ${result.error}`));
    console.log();
    return;
  }

  if (result.scanned === 0) {
    console.log(pc.dim("  no active blocks in the store yet — nothing to score"));
    console.log();
    return;
  }

  console.log(pc.dim(`  scanned   ${result.scanned} active block(s)`));
  console.log(pc.dim(`  wouldDemote ${result.wouldDemote.length} block(s) at threshold ${result.demotionThreshold.toFixed(3)}`));
  console.log();

  const topRaw = opts.top ?? "20";
  const topN = Math.max(0, Number.parseInt(topRaw, 10) || 0);
  const showAll = topN === 0;
  const slice = showAll ? result.scored : result.scored.slice(0, topN);

  if (slice.length === 0) {
    console.log(pc.green("  ✓ all active blocks score above the threshold"));
    console.log();
    return;
  }

  console.log(
    pc.bold(
      `  Lowest-scoring ${showAll ? "all" : slice.length} block(s) (worst first):`,
    ),
  );
  console.log(
    pc.dim(
      `    health  wilson_lb  counter  stale   dup    gen    -ROI   reasons                              id`,
    ),
  );
  for (const s of slice) {
    console.log(`    ${formatHealthRow(s)}`);
  }
  console.log();

  if (!showAll && result.scored.length > slice.length) {
    console.log(
      pc.dim(
        `  ${result.scored.length - slice.length} more block(s) above this slice — pass --top 0 to list all, or --json for machine-readable.`,
      ),
    );
    console.log();
  }
}

function formatHealthRow(s: MemoryHealthScore): string {
  const fmt = (n: number) => n.toFixed(3).padStart(6, " ");
  const reasons = s.reasons.length > 0 ? s.reasons.join(",") : pc.dim("—");
  const reasonField = reasons.padEnd(36, " ");
  const id = pc.dim(s.blockId.slice(0, 12) + "…");
  const healthColor = s.health <= 0 ? pc.red : s.health <= 0.2 ? pc.yellow : pc.green;
  return [
    healthColor(fmt(s.health)),
    fmt(s.components.wilsonLb),
    fmt(s.components.counterproductiveRate),
    fmt(s.components.stalePenalty),
    fmt(s.components.duplicationPenalty),
    fmt(s.components.genericnessPenalty),
    fmt(s.components.negativeRoiPenalty),
    " " + reasonField,
    id,
  ].join("  ");
}
