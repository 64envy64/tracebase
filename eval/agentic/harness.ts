import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ReasoningLayer } from "../../src/core/engine.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { Sandbox } from "./sandbox.js";
import { runAgenticTrajectory, buildSystemPrompt } from "./agent.js";
import { formatDistillate } from "./inject.js";
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
    const baselineSystem = buildSystemPrompt();
    let baseline: Trajectory;
    try {
      const result = await runAgenticTrajectory(
        model, baselineSandbox, fixture.meta.language, baselineSystem, MAX_STEPS,
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

    // Store the seed as a trace
    layer.storeTrace({
      problem: {
        description: fixture.seed.situation,
        language: fixture.meta.language,
        tags: fixture.meta.tags ?? [],
      },
      solution: {
        summary: `DEAD ENDS: ${fixture.seed.deadEnds}\nUNLOCK: ${fixture.seed.unlock}`,
        steps: [],
        outcome: "success",
      },
      metadata: { agent: "seed", source: "eval:seed" },
    });

    // Recall
    const recallResults = layer.recall({
      problem: fixture.meta.description,
      limit: 1,
      minScore: 0.1,
      context: { language: fixture.meta.language },
    });

    let injection: string | undefined;
    let injectionScore: number | undefined;
    if (recallResults.length > 0 && recallResults[0]!.score >= 0.3) {
      injectionScore = recallResults[0]!.score;
      injection = formatDistillate(fixture.seed, injectionScore);
    }
    layer.close();

    const augSystem = buildSystemPrompt(injection);
    let augmented: Trajectory;
    try {
      const result = await runAgenticTrajectory(
        model, augSandbox, fixture.meta.language, augSystem, MAX_STEPS,
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
