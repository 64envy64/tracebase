#!/usr/bin/env tsx
/**
 * Path A harness: smoke gate.
 *
 * Per PRE-REGISTRATION-PATH-A.md §"Smoke gate": runs ONE trajectory
 * (task=read-then-test-then-reread, variant=ON) and verifies four
 * conditions before the pilot may dispatch:
 *
 *   1. Each non-blocked Read produces a PreToolUse + PostToolUse pair,
 *      all exitCode 0. (Blocked tool calls do not produce PostToolUse
 *      observations in real Claude Code.)
 *   2. Workspace `.tracebase/memory.db` has tool_observations rows > 0.
 *   3. Workspace DB has >=1 tool_supervision.warned OR
 *      tool_supervision.cache_hit event.
 *   4. Transcript shows >=1 Read tool_use AFTER a previous Bash
 *      tool_result returned (sequencing confirmed, not parallel).
 *
 * Writes the result + verdict to
 * `bench-runs/tool-supervision-path-a/results/smoke.json`. Exits 0 iff
 * all four gates pass.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setupWorkspace } from "./setup-workspace.js";
import { runTrajectory } from "./run-trajectory.js";
import { extractEvents } from "./extract-events.js";
import { verifyPass } from "./verify-pass.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..", "..");
const PATH_A = join(ROOT, "bench-runs", "tool-supervision-path-a");
const RESULTS_DIR = join(PATH_A, "results");

const SMOKE_TASK = "read-then-test-then-reread";
const SMOKE_VARIANT = "ON" as const;
// Claude Code rejects session-id reuse ("Session ID X is already in use").
// Each smoke run gets a fresh UUID; correlation goes via the smoke.json
// `sessionId` field we write below.
const SMOKE_SESSION_ID = randomUUID();

console.log("=== Path A smoke gate ===");
console.log(`  task:    ${SMOKE_TASK}`);
console.log(`  variant: ${SMOKE_VARIANT}`);
console.log(`  session: ${SMOKE_SESSION_ID}`);
console.log("");

// 1. Build workspace
const info = setupWorkspace(SMOKE_TASK, SMOKE_VARIANT);
console.log(`Workspace: ${info.workspace}`);

// 2. Run trajectory
const prompt = readFileSync(info.promptPath, "utf-8");
console.log(`Prompt bytes: ${prompt.length}`);
console.log("");
console.log("Spawning claude...");
const t0 = Date.now();
const result = runTrajectory({
  workspace: info.workspace,
  prompt,
  sessionId: SMOKE_SESSION_ID,
});
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`Trajectory exit ${result.exitCode} in ${elapsed}s`);
console.log(`Transcript: ${result.transcriptPath ?? "(missing)"}`);
console.log("");

if (result.exitCode !== 0 || !result.transcriptPath) {
  console.log("STDERR (first 30 lines):");
  console.log(result.stderr.split("\n").slice(0, 30).join("\n"));
  console.log("");
}

// 3. Extract events
const events = extractEvents({
  workspace: info.workspace,
  transcriptPath: result.transcriptPath,
  taskId: SMOKE_TASK,
  variant: SMOKE_VARIANT,
});
console.log("Events:");
console.log("  tool_observations by tool:", events.toolObservationsByTool);
console.log("  tool_supervision events  :", events.toolSupervisionEvents);
console.log("  transcript tool_use_count:", events.toolUseCountsByTool);
console.log("  parallel batches by tool :", events.parallelBatchesByTool);
console.log("  hook attachments         :", events.hookAttachments);
console.log("  seq Read-after-Bash count:", events.sequentialReadAfterBash);
console.log("");

// 4. Post-hoc pass verification
const pass = verifyPass(info.workspace);
console.log(`Vitest in post-trajectory workspace: ${pass.summary}`);
console.log("");

// 5. Smoke gate checks (PRE-REGISTRATION-PATH-A.md §"Smoke gate")
const readToolUses = events.toolUseCountsByTool["Read"] ?? 0;
const readObservations = events.toolObservationsByTool["Read"] ?? 0;
const warnedOrCacheHit =
  (events.toolSupervisionEvents["warned"] ?? 0) +
  (events.toolSupervisionEvents["cache_hit"] ?? 0);

const gate = {
  // Each non-blocked Read produces a Pre + Post pair, all exitCode 0.
  // Approximation: hooks fired >=1 of each AND no non-zero exits.
  // (Strict per-Read pairing requires more transcript walking; this catches
  // the production bug class — hook command syntax error → exitCode 127 —
  // which is the load-bearing failure mode.)
  // Load-bearing check: no hook crashed (exitCode != 0 would indicate the
  // Windows backslash-escaping class of failure or similar). Pre/Post counts
  // are sanity-only; Claude Code may log multiple attachment records per
  // hook event so strict pairing isn't reliable across versions.
  gate1_hooks_fired_clean: {
    preCount: events.hookAttachments.preCount,
    postCount: events.hookAttachments.postCount,
    nonZeroExit: events.hookAttachments.nonZeroExit,
    pass:
      events.hookAttachments.preCount > 0 &&
      events.hookAttachments.postCount > 0 &&
      events.hookAttachments.nonZeroExit === 0,
  },
  gate2_tool_observations_present: {
    rows: events.toolObservationsTotal,
    pass: events.toolObservationsTotal > 0,
  },
  gate3_supervision_event_fired: {
    warnedPlusCacheHit: warnedOrCacheHit,
    pass: warnedOrCacheHit >= 1,
  },
  gate4_sequencing_read_after_bash: {
    occurrences: events.sequentialReadAfterBash,
    pass: events.sequentialReadAfterBash >= 1,
  },
};

const allPass = Object.values(gate).every((g) => g.pass);
console.log("=== Smoke gate verdict ===");
for (const [name, g] of Object.entries(gate)) {
  console.log(`  ${g.pass ? "PASS" : "FAIL"}  ${name}`);
}
console.log("");
console.log(`overall: ${allPass ? "SMOKE PASS — pilot may dispatch" : "SMOKE FAIL — DO NOT dispatch pilot"}`);

// Write smoke.json
mkdirSync(RESULTS_DIR, { recursive: true });
writeFileSync(
  join(RESULTS_DIR, "smoke.json"),
  JSON.stringify(
    {
      pre_registration: "bench-runs/tool-supervision/PRE-REGISTRATION-PATH-A.md",
      task: SMOKE_TASK,
      variant: SMOKE_VARIANT,
      sessionId: SMOKE_SESSION_ID,
      workspace: info.workspace.replace(/\\/g, "/"),
      transcriptCopiedTo: events.transcriptCopiedTo,
      trajectory: {
        exitCode: result.exitCode,
        elapsedSec: Number(elapsed),
        parsedTopKeys: result.parsed ? Object.keys(result.parsed) : [],
        usage: (result.parsed as any)?.usage ?? null,
        totalCostUsd: (result.parsed as any)?.total_cost_usd ?? null,
        durationMs: (result.parsed as any)?.duration_ms ?? null,
        numTurns: (result.parsed as any)?.num_turns ?? null,
        terminalReason: (result.parsed as any)?.terminal_reason ?? null,
      },
      events,
      vitest: { pass: pass.pass, summary: pass.summary, exitCode: pass.exitCode },
      gate,
      allPass,
    },
    null,
    2,
  ) + "\n",
);
console.log(`Wrote ${join(RESULTS_DIR, "smoke.json")}`);

process.exit(allPass ? 0 : 1);
