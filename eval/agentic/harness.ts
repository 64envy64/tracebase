import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ReasoningLayer } from "../../src/core/engine.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { Sandbox } from "./sandbox.js";
import { runAgenticTrajectory } from "./agent.js";
import { formatCompressedDirective } from "./inject.js";
import { computeAggregate, computeDelta } from "./metrics.js";
import type {
  Trajectory, FixtureResult, FixtureMeta, DistillateSeed,
  AgenticBenchmarkResults,
} from "./types.js";

const MAX_STEPS = 10;

/** Load all fixtures from the fixtures directory. */
export function loadFixtures(fixturesDir: string): Array<{
  meta: FixtureMeta;
  seed: DistillateSeed;
  dir: string;
}> {
  const fixtures: Array<{ meta: FixtureMeta; seed: DistillateSeed; dir: string }> = [];
  const entries = readdirSync(fixturesDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(fixturesDir, entry.name);
    const metaPath = join(dir, "meta.json");
    const seedPath = join(dir, "seed.json");

    if (!existsSync(metaPath) || !existsSync(seedPath)) continue;

    const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as FixtureMeta;
    const seed = JSON.parse(readFileSync(seedPath, "utf-8")) as DistillateSeed;
    fixtures.push({ meta, seed, dir });
  }

  return fixtures.sort((a, b) => a.meta.id.localeCompare(b.meta.id));
}

/**
 * Run the full agentic benchmark for one model.
 *
 * For each fixture:
 *   1. Baseline: Agent solves with no prior knowledge
 *   2. Augmented: Agent solves with 3-field distillate injected
 *
 * Metrics computed at trajectory level (steps, tokens, accuracy).
 */
export async function runAgenticBenchmark(
  model: string,
  fixtures: Array<{ meta: FixtureMeta; seed: DistillateSeed; dir: string }>,
  opts?: { verbose?: boolean },
): Promise<AgenticBenchmarkResults> {
  const verbose = opts?.verbose ?? false;
  const results: FixtureResult[] = [];

  for (const fixture of fixtures) {
    if (verbose) console.log(`\n--- Fixture: ${fixture.meta.id} (${fixture.meta.difficulty}) ---`);

    // Baseline: no injection
    if (verbose) process.stdout.write("  Baseline: ");
    const baselineSandbox = new Sandbox(fixture.dir, `${fixture.meta.id}-bl`);
    let baseline: Trajectory;
    try {
      // Baseline: no injection, agent explores from scratch
      const result = await runAgenticTrajectory(
        model, baselineSandbox, fixture.meta.language, "", MAX_STEPS, null,
      );
      baseline = toTrajectory(fixture.meta.id, result, false);
      if (verbose) console.log(`${result.success ? "PASS" : "FAIL"} (${result.steps.length} steps, ${baseline.totalTokens} tok) [${result.stopReason}]`);
    } catch (err) {
      baseline = errorTrajectory(fixture.meta.id, false);
      if (verbose) console.log(`ERROR: ${err instanceof Error ? err.message.slice(0, 80) : err}`);
    } finally {
      baselineSandbox.cleanup();
    }

    // Augmented: with distillate injection
    if (verbose) process.stdout.write("  Augmented: ");
    const augSandbox = new Sandbox(fixture.dir, `${fixture.meta.id}-aug`);

    // Use TraceBase recall to find matching seed (like real usage)
    const tmpDb = mkdtempSync(join(tmpdir(), "tb-eval-kb-"));
    const layer = new ReasoningLayer({ storagePath: join(tmpDb, "kb.db") });

    // Store ALL seeds (not just this fixture's seed) — simulates a real KB
    // with traces from many previously solved problems.
    // This is how it works in production: the KB contains traces from
    // various solved bugs, and recall finds the most relevant one.
    for (const other of fixtures) {
      if (other.meta.id === fixture.meta.id) continue; // exclude current fixture
      layer.storeTrace({
        problem: {
          description: other.seed.situation,
          language: other.meta.language,
          errorType: other.meta.bugType,
          tags: other.meta.tags ?? [],
        },
        solution: {
          summary: other.seed.unlock,
          explanation: Array.isArray(other.seed.deadEnds) ? other.seed.deadEnds.join(". ") : other.seed.deadEnds,
          steps: [],
          outcome: "success",
        },
        metadata: { agent: "seed", source: "eval:seed" },
      });
    }

    // Recall using the SAME production recall engine — no bypass, no cheating.
    // The confidence gate applies exactly as it would for a real user.
    const recallResults = layer.recall({
      problem: fixture.meta.description,
      limit: 1,
      minScore: 0.1,
      context: {
        language: fixture.meta.language,
        errorType: fixture.meta.bugType,
      },
    });

    // Use the real confidence gate — same as production SDK.
    // Injection is built from the RECALLED trace, not the fixture's own seed.
    let injection: string | null = null;
    let injectionScore: number | undefined;
    if (recallResults.length > 0) {
      injectionScore = recallResults[0]!.score;
      // Build seed from recalled trace (not fixture-specific)
      const recalledTrace = recallResults[0]!.trace;
      const recalledSeed: DistillateSeed = {
        situation: recalledTrace.problem.description,
        deadEnds: recalledTrace.solution.explanation ?? "",
        unlock: recalledTrace.solution.summary,
      };
      // formatCompressedDirective enforces the confidence gate:
      // >= 0.85: full directive, >= 0.72: hint only, < 0.72: null (no injection)
      injection = formatCompressedDirective(recalledSeed, injectionScore);
    }
    layer.close();

    let augmented: Trajectory;
    try {
      const result = await runAgenticTrajectory(
        model, augSandbox, fixture.meta.language, "", MAX_STEPS, injection,
      );
      augmented = toTrajectory(fixture.meta.id, result, true, injectionScore);
      if (verbose) console.log(`${result.success ? "PASS" : "FAIL"} (${result.steps.length} steps, ${augmented.totalTokens} tok) [${result.stopReason}]`);
    } catch (err) {
      augmented = errorTrajectory(fixture.meta.id, true, injectionScore);
      if (verbose) console.log(`ERROR: ${err instanceof Error ? err.message.slice(0, 80) : err}`);
    } finally {
      augSandbox.cleanup();
    }

    // Compute per-fixture metrics
    const stepSave = (baseline.success && augmented.success && baseline.totalSteps > 0)
      ? (baseline.totalSteps - augmented.totalSteps) / baseline.totalSteps
      : null;
    const tokenSave = (baseline.success && augmented.success && baseline.totalTokens > 0)
      ? (baseline.totalTokens - augmented.totalTokens) / baseline.totalTokens
      : null;

    results.push({ fixtureId: fixture.meta.id, baseline, augmented, stepSave, tokenSave });

    // Rate limit between fixtures
    await new Promise((r) => setTimeout(r, 500));
  }

  // Aggregate
  const baselineTrajectories = results.map((r) => r.baseline);
  const augmentedTrajectories = results.map((r) => r.augmented);

  return {
    timestamp: Date.now(),
    model,
    fixtureCount: fixtures.length,
    maxSteps: MAX_STEPS,
    baseline: computeAggregate(baselineTrajectories),
    augmented: computeAggregate(augmentedTrajectories),
    delta: computeDelta(results),
    perFixture: results,
  };
}

function toTrajectory(
  fixtureId: string, result: Awaited<ReturnType<typeof runAgenticTrajectory>>,
  injected: boolean, injectionScore?: number,
): Trajectory {
  return {
    fixtureId,
    steps: result.steps,
    totalSteps: result.steps.length,
    totalInputTokens: result.steps.reduce((s, st) => s + st.inputTokens, 0),
    totalOutputTokens: result.steps.reduce((s, st) => s + st.outputTokens, 0),
    totalTokens: result.steps.reduce((s, st) => s + st.inputTokens + st.outputTokens, 0),
    totalDurationMs: result.steps.reduce((s, st) => s + st.durationMs, 0),
    success: result.success,
    testOutput: result.testOutput,
    stopReason: result.stopReason as Trajectory["stopReason"],
    injected,
    injectionScore,
  };
}

function errorTrajectory(fixtureId: string, injected: boolean, injectionScore?: number): Trajectory {
  return {
    fixtureId, steps: [], totalSteps: 0,
    totalInputTokens: 0, totalOutputTokens: 0, totalTokens: 0, totalDurationMs: 0,
    success: false, testOutput: "", stopReason: "error",
    injected, injectionScore,
  };
}
