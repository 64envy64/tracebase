#!/usr/bin/env tsx
/**
 * 0.7.1 Contextual Runtime — pilot harness entry point
 *
 * Runs each fixture under each requested condition and emits a
 * `PilotReport` either as pretty-printed text (default) or JSON
 * (`--json`). The harness owns the wall clock — every run's
 * `durationMs` is measured here, not trusted from the agent.
 *
 * Two drivers:
 *
 *   anthropic — real Claude loop. Requires ANTHROPIC_API_KEY and
 *               the optional @anthropic-ai/sdk peer dep. Reuses the
 *               existing trajectory runner from eval/agentic.
 *
 *   stub      — deterministic simulator. Resolves a run iff the
 *               injection text contains a non-trivial token overlap
 *               with the fixture's expected unlock. Lets the
 *               plumbing (retrieval → injection → outcome ledger)
 *               be verified end-to-end without API credentials, and
 *               makes the unit test suite hermetic. The driver is
 *               always reported in the top-level `driver` field so
 *               readers don't conflate the two.
 *
 * CLI:
 *   tsx eval/contextual-runtime/runner.ts \
 *       [--conditions=off,naive-cache,tracebase,tracebase-holdout] \
 *       [--fixtures-dir=eval/agentic/fixtures] \
 *       [--limit=N] \
 *       [--simulated] \
 *       [--json]
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  buildNaiveCorpus,
  createPilotProvider,
  makeRunId,
  NaiveCacheRunner,
  OffRunner,
  TracebaseHoldoutRunner,
  TracebaseRunner,
  seedTracebaseFromFixtures,
  type BeforeRunOutput,
  type ConditionRunner,
} from "./providers.js";
import { buildPilotReport, formatPilotReport } from "./report.js";
import type { Condition, PilotFixture, RunMetric } from "./types.js";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliArgs {
  conditions: Condition[];
  fixturesDir: string;
  limit?: number;
  simulated: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    conditions: ["off", "naive-cache", "tracebase", "tracebase-holdout"],
    fixturesDir: "eval/agentic/fixtures",
    simulated: false,
    json: false,
  };
  for (const a of argv) {
    if (a === "--simulated") args.simulated = true;
    else if (a === "--json") args.json = true;
    else if (a.startsWith("--conditions=")) {
      args.conditions = a
        .slice("--conditions=".length)
        .split(",")
        .filter((c): c is Condition =>
          ["off", "naive-cache", "tracebase", "tracebase-holdout"].includes(c),
        );
    } else if (a.startsWith("--fixtures-dir=")) {
      args.fixturesDir = a.slice("--fixtures-dir=".length);
    } else if (a.startsWith("--limit=")) {
      args.limit = Number(a.slice("--limit=".length));
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

interface RawSeed {
  situation: string;
  unlock: string;
  deadEnds?: string[] | string;
}

interface RawMeta {
  id: string;
  language?: string;
  bugType?: string;
  description?: string;
}

export function loadPilotFixtures(fixturesDir: string): PilotFixture[] {
  const fixtures: PilotFixture[] = [];
  if (!existsSync(fixturesDir)) return fixtures;
  const entries = readdirSync(fixturesDir, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = join(fixturesDir, e.name);
    const metaPath = join(dir, "meta.json");
    const seedPath = join(dir, "seed.json");
    if (!existsSync(metaPath) || !existsSync(seedPath)) continue;
    const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as RawMeta;
    const seed = JSON.parse(readFileSync(seedPath, "utf-8")) as RawSeed;
    const deadEnds = Array.isArray(seed.deadEnds)
      ? seed.deadEnds
      : typeof seed.deadEnds === "string" && seed.deadEnds.length > 0
        ? [seed.deadEnds]
        : [];
    fixtures.push({
      id: meta.id,
      language: meta.language ?? "unknown",
      ...(meta.bugType ? { errorType: meta.bugType } : {}),
      description: meta.description ?? seed.situation,
      seed: {
        situation: seed.situation,
        unlock: seed.unlock,
        deadEnds,
      },
    });
  }
  return fixtures.sort((a, b) => a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Driver: stub
// ---------------------------------------------------------------------------

interface DriverOutput {
  resolved: boolean;
  durationMs: number;
  steps: number;
  tokens: number;
  usedIds: string[];
  stopReason: RunMetric["stopReason"];
}

/**
 * Deterministic stub driver. Resolves a run iff the injection text
 * has > 0.30 Jaccard overlap with the fixture's expected unlock —
 * which models the realistic case "the injection is good enough
 * that the agent shortcuts to the answer". Empty injection → never
 * resolves, mirroring `off` and forced-shadow runs.
 *
 * Step counts and token counts are simulated but bounded:
 *   - resolved runs: 1..3 steps, ~500 tokens/step
 *   - unresolved runs: hit a 5-step cap, ~500 tokens/step
 *
 * Wall-clock is faked but proportional to step count so the
 * `durationMs` field is non-zero and ordered consistently with the
 * agent loop a real LLM would take.
 */
function stubDrive(
  fixture: PilotFixture,
  before: BeforeRunOutput,
): DriverOutput {
  // The stub resolves if the injected text overlaps any of the
  // fixture's reference fields (problem description, unlock, or
  // situation). The threshold (0.08) is calibrated so:
  //   - empty injection (off / forced-shadow) never resolves
  //   - random unrelated patterns (low FTS score) rarely resolve
  //   - patterns that share problem-space vocabulary with the
  //     current fixture do resolve, modelling "the agent shortcut
  //     to the answer because injection pointed it at the right
  //     class of fix".
  // This is not an LLM substitute — the privacy + plumbing tests
  // care about correctness of attribution, not lift. The real
  // headline numbers come from the anthropic driver. The stub
  // exists so the runner exercises every code path hermetically.
  const overlap = Math.max(
    jaccardOverlap(before.injection, fixture.description),
    jaccardOverlap(before.injection, fixture.seed.unlock),
    jaccardOverlap(before.injection, fixture.seed.situation),
  );
  const resolved = before.injection.length > 0 && overlap > 0.08;
  const steps = resolved ? Math.max(1, Math.round(3 - overlap * 2)) : 5;
  const tokensPerStep = 500;
  const msPerStep = 320;
  const usedIds = resolved ? before.injectedIds : [];
  return {
    resolved,
    durationMs: steps * msPerStep,
    steps,
    tokens: steps * tokensPerStep,
    usedIds,
    stopReason: resolved
      ? "resolved"
      : before.injection.length === 0
        ? "no_injection"
        : "step_limit",
  };
}

function jaccardOverlap(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 4),
  );
}

// ---------------------------------------------------------------------------
// Driver: anthropic (lazy peer-dep import)
// ---------------------------------------------------------------------------

/**
 * Detect whether the real-LLM driver can run. Requires:
 *   - process.env.ANTHROPIC_API_KEY set
 *   - the @anthropic-ai/sdk peer dep installed
 *
 * Returns null when either precondition is missing; the caller falls
 * back to the stub driver and surfaces `driver: "stub"` in the
 * report so the difference is visible at the top.
 */
async function tryLoadAnthropicDriver(): Promise<
  null | ((fixture: PilotFixture, before: BeforeRunOutput) => Promise<DriverOutput>)
> {
  if (!process.env["ANTHROPIC_API_KEY"]) return null;
  try {
    // The agentic harness already wires Anthropic; we re-use its
    // trajectory runner so the pilot's token / step accounting is
    // identical to the existing agentic benchmark. If that module
    // can't be imported (peer dep missing in this env), we silently
    // fall back to stub.
    const { runAgenticTrajectory } = await import("../agentic/agent.js");
    const { Sandbox } = await import("../agentic/sandbox.js");
    const fixturesRoot = process.env["TB_PILOT_FIXTURES_ROOT"] ?? "eval/agentic/fixtures";

    return async (
      fixture: PilotFixture,
      before: BeforeRunOutput,
    ): Promise<DriverOutput> => {
      const fixDir = join(fixturesRoot, fixture.id);
      const sandbox = new Sandbox(fixDir, `${fixture.id}-pilot-${Date.now()}`);
      try {
        // The agentic harness expects a `"typescript" | "python"`
        // literal; pilot fixtures may carry arbitrary language
        // strings, so we narrow at the boundary. Anything unknown
        // becomes "typescript" (the larger sandbox surface).
        const lang: "typescript" | "python" =
          fixture.language === "python" ? "python" : "typescript";
        const r = await runAgenticTrajectory(
          process.env["TB_PILOT_MODEL"] ?? "claude-sonnet-4-6",
          sandbox,
          lang,
          before.injection,
          5,
          before.injection || null,
        );
        const tokens = r.steps.reduce(
          (s: number, st: { inputTokens: number; outputTokens: number }) =>
            s + st.inputTokens + st.outputTokens,
          0,
        );
        const ms = r.steps.reduce(
          (s: number, st: { durationMs: number }) => s + st.durationMs,
          0,
        );
        return {
          resolved: r.success,
          durationMs: ms,
          steps: r.steps.length,
          tokens,
          usedIds: r.success ? before.injectedIds : [],
          stopReason: r.success
            ? "resolved"
            : r.stopReason === "step_limit"
              ? "step_limit"
              : "error",
        };
      } finally {
        sandbox.cleanup();
      }
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

export interface RunPilotOptions {
  conditions: Condition[];
  fixtures: PilotFixture[];
  drive: (
    fixture: PilotFixture,
    before: BeforeRunOutput,
  ) => Promise<DriverOutput>;
  driverLabel: "anthropic" | "stub";
}

/**
 * The harness entry point. Exported so tests can drive it
 * end-to-end with a mock driver (no LLM) and assert on the report.
 */
export async function runPilot(opts: RunPilotOptions) {
  const conditions = opts.conditions;
  const fixtures = opts.fixtures;

  // Build per-condition runners. Each runner owns its own
  // resources; the loop closes them at the end. The TraceBase
  // arms share NO state across conditions — they're literally
  // separate provider instances over separate temp DBs — so a
  // pattern captured into the `tracebase` arm cannot accidentally
  // leak into the `tracebase-holdout` arm via shared in-memory
  // caches.
  let captureAttempted = 0;
  let captureAccepted = 0;
  let captureRejected = 0;

  const naiveCorpus = buildNaiveCorpus(fixtures, new Set());
  const runners = new Map<Condition, ConditionRunner>();
  const cleanupFns: Array<() => void> = [];

  for (const c of conditions) {
    if (c === "off") {
      runners.set(c, new OffRunner());
    } else if (c === "naive-cache") {
      runners.set(c, new NaiveCacheRunner(naiveCorpus));
    } else if (c === "tracebase" || c === "tracebase-holdout") {
      const { provider, cleanup } = createPilotProvider();
      cleanupFns.push(cleanup);
      // Pre-seed: every other fixture's pattern is captured so the
      // fixture-under-test isn't its own oracle. The same exclusion
      // applies to the naive corpus for fairness.
      const seedReport = await seedTracebaseFromFixtures(
        provider,
        fixtures,
        new Set(),
      );
      captureAttempted += seedReport.attempted;
      captureAccepted += seedReport.accepted;
      captureRejected += seedReport.rejected;
      const runner =
        c === "tracebase"
          ? new TracebaseRunner({ provider })
          : new TracebaseHoldoutRunner({ provider });
      runners.set(c, runner);
    }
  }

  // Per-fixture × per-condition loop.
  const runs: RunMetric[] = [];
  for (const fix of fixtures) {
    for (const c of conditions) {
      const runner = runners.get(c)!;
      const runId = makeRunId();
      const before = await runner.beforeRun({ fixture: fix, runId });
      const t0 = Date.now();
      const drv = await opts.drive(fix, before);
      const tElapsed = Date.now() - t0;
      // Harness owns the wall clock. If the driver reported a time,
      // we pass that through as the auditable value (it might
      // include sandbox setup); otherwise we use the elapsed time
      // from above. Either way, a single source of truth per run.
      const durationMs = drv.durationMs > 0 ? drv.durationMs : tElapsed;
      await runner.afterRun({
        ...(before.queryId ? { queryId: before.queryId } : {}),
        resolved: drv.resolved,
        durationMs,
        steps: drv.steps,
        tokens: drv.tokens,
        usedIds: drv.usedIds,
        runId,
      });
      runs.push({
        runId,
        fixtureId: fix.id,
        failureClass: fix.id,
        condition: c,
        ...(before.queryId ? { queryId: before.queryId } : {}),
        resolved: drv.resolved,
        durationMs,
        steps: drv.steps,
        tokens: drv.tokens,
        injectedIds: before.injectedIds,
        usedIds: drv.usedIds,
        simulated: opts.driverLabel === "stub",
        hadInjection: before.injection.length > 0,
        ...(before.shadow ? { shadow: true } : {}),
        stopReason: drv.stopReason,
      });
    }
  }

  // Close runners (releases SQLite handles for the TraceBase arms).
  for (const r of runners.values()) await r.close();
  for (const fn of cleanupFns) fn();

  return {
    runs,
    capture: {
      patternsCapturedPreSeed: captureAccepted,
      capturesAttempted: captureAttempted,
      capturesAccepted: captureAccepted,
      capturesRejected: captureRejected,
      captureRejectRate:
        captureAttempted === 0 ? 0 : captureRejected / captureAttempted,
    },
  };
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let fixtures = loadPilotFixtures(args.fixturesDir);
  if (fixtures.length === 0) {
    process.stderr.write(
      `pilot: no fixtures found in ${args.fixturesDir}\n`,
    );
    process.exit(2);
  }
  if (args.limit !== undefined) fixtures = fixtures.slice(0, args.limit);

  const drive = args.simulated ? null : await tryLoadAnthropicDriver();
  const driverLabel: "anthropic" | "stub" = drive ? "anthropic" : "stub";
  const driveFn = drive ?? (async (f, b) => stubDrive(f, b));

  const { runs, capture } = await runPilot({
    conditions: args.conditions,
    fixtures,
    drive: driveFn,
    driverLabel,
  });

  const report = buildPilotReport({
    runs,
    conditions: args.conditions,
    fixtureCount: fixtures.length,
    capture,
    driver: driverLabel,
  });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatPilotReport(report)}\n`);
  }
}

// Run when invoked as a script (the tsx entry point). When imported
// from a test, `main` is a no-op until called explicitly.
const invokedAsScript =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /contextual-runtime[\\/]+runner\.ts$/.test(process.argv[1]);
if (invokedAsScript) {
  main().catch((err) => {
    process.stderr.write(`pilot runner failed: ${String(err)}\n`);
    process.exit(1);
  });
}

// Re-export the stub driver so tests and the runner share a single
// implementation.
export { stubDrive };
