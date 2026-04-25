/**
 * `tracebase memory` — local memory maintenance commands.
 *
 * Subcommand `prune` re-applies the 0.5.7 §A quality gate
 * (`isPatternShapedSituation` from `capture-turn.ts`) as a
 * classifier against existing active reasoning_blocks. Blocks
 * whose `trig_situation` no longer passes the gate are
 * candidates — they were stored under the older length-only
 * gate before 0.5.7 tightened the heuristic.
 *
 * Two modes:
 *
 *   * `--dry-run` (DEFAULT) — print the candidates and exit.
 *     Nothing in the store changes. Safe to run anywhere.
 *
 *   * `--apply` — retire each candidate (status: active →
 *     retired). Reversible: `retired` is a status, not a delete;
 *     re-promotion via `BlockStore.updateBlockStatus` is
 *     possible if a block was retired in error.
 *
 * Never runs from runtime hooks. Manual / explicit only — the
 * destructive path needs a human eyeball on the candidate list.
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

interface PruneOptions {
  path?: string;
  apply?: boolean;
  // `--dry-run` defaults true; explicit `--apply` toggles.
  dryRun?: boolean;
}

export const memoryCommand = new Command("memory")
  .description("Local memory maintenance (prune, inspect)")
  .addCommand(
    new Command("prune")
      .description(
        "Sweep active reasoning_blocks against the current quality gate. " +
          "--dry-run by default; pass --apply to retire candidates.",
      )
      .option("-p, --path <path>", "project root", process.cwd())
      .option(
        "--apply",
        "retire candidates (active → retired). Without this flag, prune is read-only.",
      )
      .option(
        "--dry-run",
        "(default) list candidates without changing anything",
      )
      .action(async (opts: PruneOptions) => {
        const result = runMemoryPrune(opts);
        renderPruneReport(result);
        if (result.error) process.exitCode = 1;
      }),
  );

// ---------------------------------------------------------------------------
// Pure helper — exported for tests.
// ---------------------------------------------------------------------------

export interface PruneCandidate {
  blockId: string;
  trigSituation: string;
  /** Best-guess reason why the gate rejects this block. */
  reason: "meta-wrap-lead" | "project-management-lead" | "no-problem-signal";
}

export interface MemoryPruneOutcome {
  /** Total active blocks scanned. */
  scanned: number;
  candidates: PruneCandidate[];
  /** Block ids that were actually retired (only when `--apply`). */
  retired: string[];
  /** True iff this run wrote to the store. */
  applied: boolean;
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

  const projectRoot = resolveBasePath(opts.path);
  if (!projectRoot) {
    return {
      scanned: 0,
      candidates: [],
      retired: [],
      applied: false,
      projectRoot: null,
      error: "not initialized — run `npx tracebase init` first",
    };
  }

  if (!isInitialized(projectRoot)) {
    return {
      scanned: 0,
      candidates: [],
      retired: [],
      applied: false,
      projectRoot,
      error: "not initialized — run `npx tracebase init` first",
    };
  }

  const config = loadConfig(projectRoot);
  if (!existsSync(config.storagePath)) {
    return {
      scanned: 0,
      candidates: [],
      retired: [],
      applied: false,
      projectRoot,
    };
  }

  const db = new Database(config.storagePath);
  const store = new BlockStore(db);
  try {
    // Walk all active blocks. The 0.5.7 quality gate operates on
    // the user-text (trig_situation) — we re-classify each
    // existing situation using the SAME predicate the live
    // capture-turn path uses. New tweaks to the gate land in
    // exactly one place; this command picks them up automatically.
    const active = store.listBlocks({ status: "active", limit: 100_000 });
    const candidates: PruneCandidate[] = [];
    for (const block of active) {
      const reason = classifyReject(block.trigger.situation);
      if (reason !== null) {
        candidates.push({
          blockId: block.id,
          trigSituation: block.trigger.situation,
          reason,
        });
      }
    }

    if (!effectiveApply) {
      return {
        scanned: active.length,
        candidates,
        retired: [],
        applied: false,
        projectRoot,
      };
    }

    const retired: string[] = [];
    for (const candidate of candidates) {
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
      retired,
      applied: true,
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

  console.log(pc.dim(`  scanned   ${result.scanned} active block(s)`));
  console.log(pc.dim(`  matches   ${result.candidates.length} candidate(s) for retirement`));
  console.log();

  if (result.candidates.length === 0) {
    console.log(pc.green("  ✓ store is clean — no candidates match the current quality gate"));
    console.log();
    return;
  }

  for (const candidate of result.candidates) {
    const wasRetired = result.retired.includes(candidate.blockId);
    const marker = result.applied ? (wasRetired ? pc.yellow("retired") : pc.red("skipped")) : pc.cyan("would retire");
    const reason = pc.dim(`(${candidate.reason})`);
    const id = pc.dim(candidate.blockId.slice(0, 8) + "…");
    const line = candidate.trigSituation.slice(0, 100);
    console.log(`  ${marker} ${reason} ${id} ${line}`);
  }
  console.log();

  if (!result.applied) {
    console.log(
      pc.dim(
        "  Pass " + pc.cyan("--apply") + " to retire candidates (status active → retired; reversible).",
      ),
    );
    console.log();
  } else {
    console.log(pc.dim(`  ${result.retired.length} block(s) retired.`));
    console.log();
  }
}
