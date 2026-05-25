/**
 * `tracebase capture-turn` — Stop-hook attribution wire-up.
 *
 * This file pins the contract for the inference pass that
 * capture-turn runs after its existing pattern/fact extraction:
 *
 *   1. transcript + matching injection → `agent_used` (matchSignal
 *      "jaccard") AND, when a fresh pattern was extracted from the
 *      same turn, a soft `outcome` event with resolved=true.
 *
 *   2. existing explicit outcome → inference DOES emit agent_used
 *      (parallel signals are fine) but does NOT double-write an
 *      outcome. The explicit MCP path is authoritative.
 *
 *   3. shadow retrieval → inference SKIPS the queryId entirely. No
 *      agent_used, no outcome. Shadow arm credits would corrupt the
 *      lift signal.
 *
 *   4. no pattern extracted from the turn → inference STILL emits
 *      agent_used (the agent demonstrably used the block). It emits
 *      a soft outcome only when the assistant text carries a narrow
 *      completion / verification signal.
 *
 * Together with `tests/runtime/attribution-inference.test.ts` (which
 * pins the scorer) and `tests/cli/capture-turn.test.ts` (which pins
 * the envelope contract), this file closes the wire-up gap flagged
 * in review: the riskiest leg was previously not exercised at the
 * Stop-hook entry point.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { initConfig, loadConfig } from "../../src/core/config.js";
import { BlockStore } from "../../src/core/block-store.js";
import { runCaptureTurn } from "../../src/cli/commands/capture-turn.js";
import { storeReasoningPattern } from "../../src/server/mcp-v2-helpers.js";
import { computeAggregates, emitOutcome } from "../../src/core/analytics.js";
import type { AnalyticsEvent } from "../../src/types.js";

let projectDir: string;
let transcriptPath: string;
const origCaptureEnv = process.env.TRACEBASE_CAPTURE;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "tb-attr-"));
  transcriptPath = join(projectDir, "transcript.jsonl");
  delete process.env.TRACEBASE_CAPTURE;
});

afterEach(() => {
  if (origCaptureEnv === undefined) delete process.env.TRACEBASE_CAPTURE;
  else process.env.TRACEBASE_CAPTURE = origCaptureEnv;
  rmSync(projectDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * The standard "real" CORS pattern + matching transcript. Long enough
 * that capture-turn's extraction heuristics pass (substantive prompt
 * + substantive answer + mechanism + unlock), and the transcript
 * scores well above the inference threshold against the block's
 * unlock+verification.
 */
const CORS_PATTERN = {
  situation:
    "CORS error when calling the auth API from the dashboard frontend after a fresh deploy.",
  mechanism:
    "The browser preflight OPTIONS request to the auth API is rejected because the dashboard origin isn't in the whitelist.",
  unlock:
    "Add cors middleware to express and whitelist the auth_token origin. Call app.use(cors()) before the auth router.",
  verification:
    "Confirm preflight OPTIONS returns 204 and the browser console shows no CORS errors.",
} as const;

const CORS_USER_PROMPT =
  "I'm getting a CORS error when the dashboard frontend calls the auth API after a fresh deploy. " +
  "The browser preflight OPTIONS request is being rejected. " +
  "How do I fix this in our express app?";

const CORS_ASSISTANT_RESPONSE =
  "The symptom is that the preflight OPTIONS request to the auth API is rejected because the dashboard origin isn't in the whitelist " +
  "and the express app never wired cors middleware in front of the auth router.\n\n" +
  "I added the cors middleware to express, called app.use(cors()) before the auth router, " +
  "whitelisted the auth_token origin, and confirmed preflight OPTIONS returns 204. " +
  "The browser console is clean now and the dashboard can complete the auth handshake.\n\n" +
  "Verify by reloading the dashboard and watching the network tab: OPTIONS should return 204, " +
  "the actual GET/POST should succeed, and no CORS errors should appear in the browser console.";

function writeTranscript(user: string, assistant: string): void {
  const lines = [
    {
      type: "user",
      message: { role: "user", content: user },
      timestamp: new Date().toISOString(),
    },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: assistant }],
      },
      timestamp: new Date().toISOString(),
    },
  ];
  writeFileSync(transcriptPath, lines.map((l) => JSON.stringify(l)).join("\n"));
}

/** Seed a block + the retrieval/injection event pair that the Stop-
 * hook inference will pick up. Returns blockId and queryId so the
 * caller can assert. `shadow` flips the retrieval event to control. */
function seedInjection(opts: { shadow?: boolean; runId?: string } = {}): {
  blockId: string;
  queryId: string;
} {
  const cfg = loadConfig(projectDir);
  const db = new Database(cfg.storagePath);
  const store = new BlockStore(db);
  try {
    const seeded = storeReasoningPattern(store, CORS_PATTERN);
    const queryId = `q-attr-${Math.random().toString(36).slice(2, 10)}`;
    const ts = Date.now() - 5_000;
    store.appendEvent(
      {
        ts,
        queryId,
        event: "retrieval",
        candidates: [{ blockId: seeded.blockId, score: 0.85 }],
        shadow: opts.shadow === true,
      },
      opts.runId ? { runId: opts.runId } : undefined,
    );
    store.appendEvent(
      {
        ts: ts + 1,
        queryId,
        event: "injection",
        blockId: seeded.blockId,
        score: 0.85,
      },
      opts.runId ? { runId: opts.runId } : undefined,
    );
    return { blockId: seeded.blockId, queryId };
  } finally {
    store.close();
  }
}

function readEvents(eventType?: AnalyticsEvent["event"]): AnalyticsEvent[] {
  const cfg = loadConfig(projectDir);
  if (!existsSync(cfg.storagePath)) return [];
  const db = new Database(cfg.storagePath, { readonly: true });
  const store = new BlockStore(db, { skipMigrate: true });
  try {
    return store.readEvents({
      ...(eventType ? { eventType } : {}),
      limit: 100,
    });
  } finally {
    store.close();
  }
}

/** Pull events filtered to a runId column value. Used by the
 * run-scoped tests to assert that runId actually lands in the
 * analytics_events SQL row (not just the JSON payload). */
function readEventsWithRunId(
  eventType: AnalyticsEvent["event"],
  runId: string,
): AnalyticsEvent[] {
  const cfg = loadConfig(projectDir);
  if (!existsSync(cfg.storagePath)) return [];
  const db = new Database(cfg.storagePath, { readonly: true });
  const store = new BlockStore(db, { skipMigrate: true });
  try {
    return store.readEvents({ eventType, runId, limit: 100 });
  } finally {
    store.close();
  }
}

function computeRunScopedAggregate(runId: string): {
  helpfulRuns: number;
  verifiedHelpfulRuns: number;
} {
  const cfg = loadConfig(projectDir);
  if (!existsSync(cfg.storagePath)) {
    return { helpfulRuns: 0, verifiedHelpfulRuns: 0 };
  }
  const db = new Database(cfg.storagePath, { readonly: true });
  const store = new BlockStore(db, { skipMigrate: true });
  try {
    const agg = computeAggregates(store, { runId });
    return {
      helpfulRuns: agg.funnel.helpfulRuns,
      verifiedHelpfulRuns: agg.funnel.verifiedHelpfulRuns,
    };
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// 1) Positive: full chain — agent_used (jaccard) AND outcome (resolved)
// ---------------------------------------------------------------------------
describe("capture-turn attribution wire-up — positive path", () => {
  it("emits agent_used (matchSignal=jaccard) and a soft outcome when a fresh pattern was also extracted", () => {
    initConfig(projectDir);
    const { queryId } = seedInjection();

    writeTranscript(CORS_USER_PROMPT, CORS_ASSISTANT_RESPONSE);

    const out = runCaptureTurn(
      { path: projectDir },
      { transcript_path: transcriptPath, cwd: projectDir },
    );
    // Existing extraction path must still report a successful capture
    // — that's what gates the soft outcome emission.
    expect(out.captured).toBe(true);

    const agentUsed = readEvents("agent_used").filter((e) => e.queryId === queryId);
    expect(agentUsed).toHaveLength(1);
    // matchSignal "jaccard" is the wire-level marker that this came
    // from Stop-hook inference, not from explicit MCP record_outcome
    // (which always uses "explicit"). The contract is documented in
    // src/runtime/attribution-inference.ts.
    expect(agentUsed[0]).toMatchObject({ matchSignal: "jaccard" });

    const outcomes = readEvents("outcome").filter((e) => e.queryId === queryId);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ resolved: true, control: false });
  });
});

// ---------------------------------------------------------------------------
// 2) Negative: existing explicit outcome — agent_used yes, no duplicate outcome
// ---------------------------------------------------------------------------
describe("capture-turn attribution wire-up — existing explicit outcome wins", () => {
  it("does NOT emit a second outcome when one already exists for the queryId", () => {
    initConfig(projectDir);
    const { queryId } = seedInjection();

    // Pre-write the authoritative explicit outcome. The Stop-hook
    // inference pass must respect this and not double-write.
    const cfg = loadConfig(projectDir);
    {
      const db = new Database(cfg.storagePath);
      const store = new BlockStore(db);
      try {
        emitOutcome(store, { queryId, resolved: false, control: false });
      } finally {
        store.close();
      }
    }

    writeTranscript(CORS_USER_PROMPT, CORS_ASSISTANT_RESPONSE);
    runCaptureTurn(
      { path: projectDir },
      { transcript_path: transcriptPath, cwd: projectDir },
    );

    const agentUsed = readEvents("agent_used").filter((e) => e.queryId === queryId);
    // Inference still fires — agent_used is observed regardless of
    // outcome ownership.
    expect(agentUsed).toHaveLength(1);

    const outcomes = readEvents("outcome").filter((e) => e.queryId === queryId);
    expect(outcomes).toHaveLength(1);
    // And the explicit one (resolved=false) is preserved, not
    // overwritten by a Stop-hook soft outcome.
    expect(outcomes[0]).toMatchObject({ resolved: false });
  });
});

// ---------------------------------------------------------------------------
// 3) Negative: shadow retrieval — inference SKIPS the queryId
// ---------------------------------------------------------------------------
describe("capture-turn attribution wire-up — shadow arm is never credited", () => {
  it("emits neither agent_used nor outcome for a queryId whose retrieval was a shadow control", () => {
    initConfig(projectDir);
    const { queryId } = seedInjection({ shadow: true });

    writeTranscript(CORS_USER_PROMPT, CORS_ASSISTANT_RESPONSE);
    runCaptureTurn(
      { path: projectDir },
      { transcript_path: transcriptPath, cwd: projectDir },
    );

    const agentUsed = readEvents("agent_used").filter((e) => e.queryId === queryId);
    expect(agentUsed).toHaveLength(0);

    const outcomes = readEvents("outcome").filter((e) => e.queryId === queryId);
    expect(outcomes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4b) Run-scoped: runCaptureTurn receives session_id, all events are
//     stamped with run_id = session_id, and computeAggregates({ runId })
//     credits the helpful run on the scoped fold.
//
//     This is the test the review specifically asked for: the production
//     value-loop path relies on Stop-hook receiving session_id from
//     Claude Code, inject-context having stamped retrieval/injection
//     events with the SAME runId, and the analytics fold being able to
//     see all four legs under that runId. Without this assertion a
//     parallel-session installation could silently report 0 helpful
//     runs even after inference works.
// ---------------------------------------------------------------------------
describe("capture-turn attribution wire-up — run-scoped chain", () => {
  it("propagates runId from stdin.session_id through agent_used + outcome and the scoped fold credits the helpful run", () => {
    initConfig(projectDir);
    const sessionId = `session-${Math.random().toString(36).slice(2, 10)}`;
    // Seed under the same runId that runCaptureTurn will receive via
    // stdin — mirrors what inject-context now writes after the runId
    // plumbing patch.
    const { queryId } = seedInjection({ runId: sessionId });

    writeTranscript(CORS_USER_PROMPT, CORS_ASSISTANT_RESPONSE);
    runCaptureTurn(
      { path: projectDir },
      {
        transcript_path: transcriptPath,
        cwd: projectDir,
        session_id: sessionId,
      },
    );

    // Each emitted attribution leg carries runId so a future
    // `events --run`, `report --run`, or `computeAggregates(store,
    // {runId})` can see them. The runId travels in the analytics_events
    // row's `run_id` column (not just the JSON payload) so the SQL
    // filter in readEvents finds them.
    const agentUsedScoped = readEventsWithRunId("agent_used", sessionId);
    expect(agentUsedScoped).toHaveLength(1);
    expect(agentUsedScoped[0]).toMatchObject({
      queryId,
      matchSignal: "jaccard",
      runId: sessionId,
    });

    const outcomeScoped = readEventsWithRunId("outcome", sessionId);
    expect(outcomeScoped).toHaveLength(1);
    expect(outcomeScoped[0]).toMatchObject({
      queryId,
      resolved: true,
      control: false,
      // The provenance marker: this came from Stop-hook inference,
      // not from explicit MCP record_outcome.
      attribution: "inferred",
      runId: sessionId,
    });

    // The scoped fold sees the helpful run via the runId index. This
    // is the production-shape assertion: without runId plumbing this
    // would be 0.
    const scoped = computeRunScopedAggregate(sessionId);
    expect(scoped.helpfulRuns).toBe(1);
    // And it stays honest about provenance: verifiedHelpfulRuns
    // excludes the soft inferred outcome.
    expect(scoped.verifiedHelpfulRuns).toBe(0);
  });

  it("does not credit a parallel session — runId mismatch keeps the fold at 0", () => {
    initConfig(projectDir);
    // Inject under one runId; capture-turn arrives with a different
    // session_id. The transcript matches the block text byte-for-byte;
    // only the runId scope keeps the attribution from leaking.
    const injectionRunId = `session-A-${Math.random().toString(36).slice(2, 8)}`;
    seedInjection({ runId: injectionRunId });

    writeTranscript(CORS_USER_PROMPT, CORS_ASSISTANT_RESPONSE);
    const otherSession = `session-B-${Math.random().toString(36).slice(2, 8)}`;
    runCaptureTurn(
      { path: projectDir },
      { transcript_path: transcriptPath, cwd: projectDir, session_id: otherSession },
    );

    expect(readEventsWithRunId("agent_used", otherSession)).toHaveLength(0);
    expect(readEventsWithRunId("agent_used", injectionRunId)).toHaveLength(0);
    expect(computeRunScopedAggregate(otherSession).helpfulRuns).toBe(0);
    expect(computeRunScopedAggregate(injectionRunId).helpfulRuns).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4) no pattern extracted — completion signal controls soft outcome
// ---------------------------------------------------------------------------
describe("capture-turn attribution wire-up — outcome can close without a new pattern", () => {
  it("emits agent_used and a soft outcome when no pattern is extracted but the assistant claims verified completion", () => {
    initConfig(projectDir);
    const { queryId } = seedInjection();

    // Short trivial turn — fails the pattern-extraction heuristics
    // (no substantive prompt, no mechanism paragraph) so blockResult
    // stays null. The inference scorer still has the seeded block to
    // compare against; the transcript echoes enough of the unlock to
    // cross the Jaccard threshold.
    writeTranscript(
      "hi",
      "Added cors middleware to express and called app.use(cors()) before the auth router. " +
        "Whitelisted the auth_token origin and confirmed preflight OPTIONS returns 204. Browser console is clean.",
    );
    const out = runCaptureTurn(
      { path: projectDir },
      { transcript_path: transcriptPath, cwd: projectDir },
    );
    // capture-turn's extraction path declines to capture (trivial turn).
    expect(out.captured).toBe(false);

    const agentUsed = readEvents("agent_used").filter((e) => e.queryId === queryId);
    expect(agentUsed).toHaveLength(1);
    expect(agentUsed[0]).toMatchObject({ matchSignal: "jaccard" });

    const outcomes = readEvents("outcome").filter((e) => e.queryId === queryId);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      resolved: true,
      control: false,
      attribution: "inferred",
    });
  });

  it("emits agent_used but not outcome when the transcript only describes the fix as a plan", () => {
    initConfig(projectDir);
    const { queryId } = seedInjection();

    writeTranscript(
      "hi",
      "The relevant prior memory says to add cors middleware to express, call app.use(cors()) before the auth router, " +
        "whitelist the auth_token origin, and verify OPTIONS returns 204 before trying again.",
    );
    const out = runCaptureTurn(
      { path: projectDir },
      { transcript_path: transcriptPath, cwd: projectDir },
    );
    expect(out.captured).toBe(false);

    const agentUsed = readEvents("agent_used").filter((e) => e.queryId === queryId);
    expect(agentUsed).toHaveLength(1);

    const outcomes = readEvents("outcome").filter((e) => e.queryId === queryId);
    expect(outcomes).toHaveLength(0);
  });
});
