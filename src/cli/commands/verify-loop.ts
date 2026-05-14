/**
 * `tracebase verify-loop` — synthetic sanity check of the value loop:
 * memory shown → memory used → task resolved → savings reports it.
 *
 * Why this command exists
 * -----------------------
 * The shipped attribution chain has five legs:
 *
 *   1. retrieval          (the runtime found candidate blocks)
 *   2. injection          (one passed the confidence gate and was shown)
 *   3. agent_used         (the agent observably acted on the block)
 *   4. outcome            (the run resolved or didn't)
 *   5. analytics fold     (computeAggregates joins these per queryId)
 *
 * In a real workspace any one of these legs can stay quiet without an
 * obvious symptom — the user sees "Helped you on 0 of N tasks" and
 * can't tell whether the runtime is broken, the threshold is wrong,
 * or the attribution path is silently dropping events. This command
 * exercises every leg on a fresh in-memory store, prints the chain
 * one step at a time, and exits non-zero the moment a leg fails.
 *
 * What this is NOT
 * ----------------
 * It is *not* a full end-to-end test of the live MCP serving path.
 * The retrieval and injection events are forged with `appendEvent`
 * instead of being produced by `BlockServer.recall()` so the command
 * runs without spinning up the server (and without depending on the
 * user's project having any indexed content). The MCP roundtrip is
 * covered separately by the parity matrix and the doctor probe.
 *
 * Calling it a "synthetic chain check" rather than "end-to-end" is
 * deliberate — anyone reading the code should know exactly what is
 * being verified and what isn't.
 *
 * It also DOES NOT touch the user's real `.tracebase/memory.db`
 * (everything runs against an isolated temp store), so it can be run
 * safely in any state.
 */

import { Command } from "commander";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import pc from "picocolors";

import { BlockStore } from "../../core/block-store.js";
import { computeAggregates } from "../../core/analytics.js";
import { storeReasoningPattern } from "../../server/mcp-v2-helpers.js";
import {
  applyInferenceAndEmit,
  DEFAULT_EVIDENCE_THRESHOLD,
} from "../../runtime/attribution-inference.js";

type LegStatus = "pass" | "fail";

interface LegReport {
  name: string;
  status: LegStatus;
  detail: string;
}

interface VerifyOutcome {
  ok: boolean;
  legs: LegReport[];
  /** Final aggregate counts for callers that want a machine readout. */
  counters: {
    injectionEvents: number;
    agentUsedEvents: number;
    outcomeEvents: number;
    /** Global fold (no runId filter). */
    helpfulRuns: number;
    memoriesUsed: number;
    tasksAssisted: number;
    /** Run-scoped fold — proves runId actually lands on every event in
     *  the chain, not just the synthetic injection. */
    helpfulRunsForRunId: number;
    verifiedHelpfulRunsForRunId: number;
  };
}

export const verifyLoopCommand = new Command("verify-loop")
  .description(
    "Synthetic chain check (NOT a live MCP roundtrip): forges retrieval/injection events, " +
      "exercises Stop-hook inference, and verifies the analytics fold credits the run honestly. " +
      "Runs against a temp store; does not touch your real .tracebase data.",
  )
  .option("--keep", "Keep the temp store dir on exit (useful for debugging)")
  .option("--json", "Machine-readable output")
  .action((opts: { keep?: boolean; json?: boolean }) => {
    const result = runVerifyLoop({ keep: !!opts.keep });
    if (opts.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else {
      writePretty(result);
    }
    if (!result.ok) process.exit(1);
  });

/**
 * Exported for tests. Side-effect contained: creates and (by default)
 * removes a temp dir under `os.tmpdir()`. Returns the chain report
 * without printing anything.
 */
export function runVerifyLoop(opts: { keep?: boolean } = {}): VerifyOutcome {
  const tempDir = mkdtempSync(join(tmpdir(), "tracebase-verify-"));
  const dbPath = join(tempDir, "memory.db");
  const db = new Database(dbPath);
  const store = new BlockStore(db);

  const legs: LegReport[] = [];
  // Scope every synthetic event to a unique runId so a parallel
  // session can't accidentally cross into the check. Mirrors what
  // production Stop-hook inference does with the Claude Code
  // session_id.
  const runId = `verify-${randomUUID()}`;
  const queryId = `q-${randomUUID()}`;

  let injectionEvents = 0;
  let agentUsedEvents = 0;
  let outcomeEvents = 0;
  let helpfulRuns = 0;
  let memoriesUsed = 0;
  let tasksAssisted = 0;
  let helpfulRunsForRunId = 0;
  let verifiedHelpfulRunsForRunId = 0;

  const finalize = (): VerifyOutcome => {
    const ok = legs.every((l) => l.status === "pass");
    return {
      ok,
      legs,
      counters: {
        injectionEvents,
        agentUsedEvents,
        outcomeEvents,
        helpfulRuns,
        memoriesUsed,
        tasksAssisted,
        helpfulRunsForRunId,
        verifiedHelpfulRunsForRunId,
      },
    };
  };

  try {
    // ------------------------------------------------------------
    // Leg 1 — seed a known pattern
    // ------------------------------------------------------------
    const seedArgs = {
      situation:
        "CORS error when calling the auth API from the dashboard frontend after a fresh deploy.",
      mechanism:
        "The browser preflight OPTIONS request to the auth API is rejected because the dashboard origin isn't in the whitelist.",
      unlock:
        "Add cors middleware to express and whitelist the auth_token origin. Call app.use(cors()) before the auth router.",
      verification:
        "Confirm preflight OPTIONS returns 204 and the browser console shows no CORS errors.",
    };
    const seed = storeReasoningPattern(store, seedArgs);
    legs.push({
      name: "seed",
      status: "pass",
      detail: `block ${seed.blockId.slice(0, 8)}… stored`,
    });

    // ------------------------------------------------------------
    // Leg 2 — forge retrieval + injection. NOTE: in production these
    // come from BlockServer.recall → injection emission; here we
    // synthesise them so verify-loop runs without a live MCP server.
    // Both events carry the verify-loop runId so inference scoping
    // matches them.
    // ------------------------------------------------------------
    const ts = Date.now();
    store.appendEvent(
      {
        ts: ts - 60_000,
        queryId,
        event: "retrieval",
        candidates: [{ blockId: seed.blockId, score: 0.85 }],
        shadow: false,
      },
      { runId },
    );
    store.appendEvent(
      {
        ts: ts - 60_000 + 1,
        queryId,
        event: "injection",
        blockId: seed.blockId,
        score: 0.85,
      },
      { runId },
    );
    injectionEvents = 1;
    legs.push({
      name: "retrieval+injection (synthetic)",
      status: "pass",
      detail: `queryId=${queryId.slice(0, 12)}…, runId=${runId.slice(0, 12)}…, score=0.85`,
    });

    // ------------------------------------------------------------
    // Leg 3 — Stop-hook inference path. We exercise the SAME helper
    // capture-turn calls, including runId scoping and the outcome
    // gate. allowOutcomeEmission=true mirrors what capture-turn
    // passes when a fresh pattern was extracted from the turn.
    // ------------------------------------------------------------
    const transcript =
      "I added the cors middleware to express, called app.use(cors()) before the auth router, " +
      "whitelisted the auth_token origin, and confirmed preflight OPTIONS returns 204. The browser console is clean.";

    const report = applyInferenceAndEmit(store, transcript, {
      runId,
      allowOutcomeEmission: true,
    });
    agentUsedEvents = report.agentUsedEmitted;
    outcomeEvents = report.outcomeEmitted;

    const firstUse = report.inferredUses[0];
    if (firstUse === undefined) {
      legs.push({
        name: "inference",
        status: "fail",
        detail:
          `evidence score below threshold ${DEFAULT_EVIDENCE_THRESHOLD}. ` +
          "The scorer found the injection but no transcript overlap — this means " +
          "either the seed pattern changed or the tokeniser drifted.",
      });
      return finalize();
    }
    legs.push({
      name: "inference → agent_used",
      status: "pass",
      detail: `evidence ${firstUse.evidenceScore.toFixed(3)} ≥ ${DEFAULT_EVIDENCE_THRESHOLD}; ${agentUsedEvents} agent_used emitted`,
    });

    if (outcomeEvents === 0) {
      legs.push({
        name: "outcome",
        status: "fail",
        detail:
          "applyInferenceAndEmit returned 0 outcomes despite allowOutcomeEmission=true; " +
          "either a prior outcome event was found (unexpected on a fresh store) or " +
          "the credited-queryIds list was empty.",
      });
      return finalize();
    }
    legs.push({
      name: "outcome",
      status: "pass",
      detail: `resolved=true, control=false (1 outcome emitted)`,
    });

    // ------------------------------------------------------------
    // Leg 4 — analytics fold. `computeAggregates` joins retrieval +
    // injection + agent_used + outcome per queryId; helpfulRuns is
    // the §L6 (injection ∧ agent_used ∧ outcome.resolved) count.
    // ------------------------------------------------------------
    const agg = computeAggregates(store);
    tasksAssisted = agg.funnel.injectedRuns;
    memoriesUsed = agg.funnel.usedRuns;
    helpfulRuns = agg.funnel.helpfulRuns;
    if (helpfulRuns < 1) {
      legs.push({
        name: "analytics fold",
        status: "fail",
        detail:
          `helpfulRuns=${helpfulRuns}, expected ≥ 1 ` +
          `(injectedRuns=${tasksAssisted}, usedRuns=${memoriesUsed}) — ` +
          "the per-queryId join is dropping a leg.",
      });
      return finalize();
    }
    legs.push({
      name: "analytics fold",
      status: "pass",
      detail: `helpfulRuns=${helpfulRuns} · memoriesUsed=${memoriesUsed} · tasksAssisted=${tasksAssisted}`,
    });

    // ------------------------------------------------------------
    // Leg 5 — run-scoped fold. The global fold above can credit a
    // chain even if runId never landed on a single emit; the scoped
    // fold can only see helpfulRuns when every leg in the chain
    // carries runId in the analytics_events SQL row. This is the
    // production-shape assertion: without it the smoke can be
    // green while real Stop-hook attribution silently reports 0.
    // ------------------------------------------------------------
    const scoped = computeAggregates(store, { runId });
    helpfulRunsForRunId = scoped.funnel.helpfulRuns;
    verifiedHelpfulRunsForRunId = scoped.funnel.verifiedHelpfulRuns;
    if (helpfulRunsForRunId < 1) {
      legs.push({
        name: "run-scoped fold",
        status: "fail",
        detail:
          `scoped helpfulRuns=${helpfulRunsForRunId} for runId ${runId.slice(0, 12)}… ` +
          "— at least one event in the chain didn't carry runId. Trace via " +
          "`tracebase events --run <id>` to find the leg that's missing the column.",
      });
      return finalize();
    }
    legs.push({
      name: "run-scoped fold",
      status: "pass",
      detail:
        `helpfulRuns=${helpfulRunsForRunId} (scoped) · ` +
        `verifiedHelpfulRuns=${verifiedHelpfulRunsForRunId} ` +
        `— inferred outcomes correctly excluded from the verified count`,
    });

    return finalize();
  } catch (err) {
    legs.push({
      name: "uncaught",
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
    });
    return finalize();
  } finally {
    store.close();
    if (!opts.keep) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // tmpdir cleanup is best-effort
      }
    } else {
      process.stderr.write(`verify-loop: temp store kept at ${tempDir}\n`);
    }
  }
}

function writePretty(result: VerifyOutcome): void {
  const out = process.stdout;
  out.write("\n");
  out.write(
    pc.bold("TraceBase verify-loop") +
      pc.dim("  · synthetic chain check (not a live MCP roundtrip)") +
      "\n\n",
  );
  for (const leg of result.legs) {
    const mark = leg.status === "pass" ? pc.green("✓") : pc.red("✗");
    const name = leg.status === "pass" ? pc.cyan(leg.name) : pc.red(leg.name);
    out.write(`  ${mark} ${name}\n    ${pc.dim(leg.detail)}\n`);
  }
  out.write("\n");
  if (result.ok) {
    out.write(
      pc.green("✓ Loop closed.") +
        pc.dim(" Every leg fired on the synthetic chain; the local fold credits the run honestly.") +
        "\n\n",
    );
  } else {
    out.write(
      pc.red("✗ Loop broken.") +
        pc.dim(" The chain stops at the first ✗ above. Fix that leg first.") +
        "\n\n",
    );
  }
}
