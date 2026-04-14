import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { ReasoningLayer } from "../src/core/engine.js";
import { computeMetrics, computeDelta } from "./metrics.js";
import type { EvalAgent, EvalTask, TaskRun, BenchmarkResults } from "./types.js";

/**
 * Eval Harness — Two-phase benchmark like ReasonBlocks.
 *
 * Phase 1 (Seed): Pre-load KB with curated prior solutions.
 *   These represent "institutional knowledge" — problems your team
 *   solved before that are RELATED to the eval tasks.
 *
 * Phase 2 (Evaluate): Run each eval task twice:
 *   - Baseline: Agent solves with empty KB (cold start)
 *   - Augmented: Agent solves with KB pre-loaded from Phase 1
 *
 * Key design:
 *   - Reduced max_tokens (512) forces efficiency — dead-end exploration
 *     wastes the budget and causes failures.
 *   - Prior traces steer the model past failure modes, reducing both
 *     wasted tokens and incorrect outputs.
 *   - Verification: output must contain enough solution keywords.
 *   - Reports on ALL tasks (not just high-confidence matches) for transparency.
 */

/** A seed trace — prior knowledge to pre-load. */
export interface SeedTrace {
  problem: string;
  solution: string;
  language: string;
  framework?: string;
  errorType?: string;
  tags: string[];
}

export async function runBenchmark(
  agent: EvalAgent,
  tasks: EvalTask[],
  opts?: {
    verbose?: boolean;
    seeds?: SeedTrace[];
    maxTokens?: number;
    concurrency?: number;
  },
): Promise<BenchmarkResults> {
  const verbose = opts?.verbose ?? false;
  const seeds = opts?.seeds;
  const baselineRuns: TaskRun[] = [];
  const augmentedRuns: TaskRun[] = [];

  // Phase 1: Baseline — solve all tasks without prior knowledge
  if (verbose) console.log(`\n--- Phase 1: Baseline (${tasks.length} tasks, no prior knowledge) ---`);

  for (const task of tasks) {
    const start = Date.now();
    try {
      const { output, tokensUsed } = await agent.solve(task);
      const durationMs = Date.now() - start;
      const success = verifySolution(output, task);

      baselineRuns.push({
        taskId: task.id,
        success,
        tokensUsed,
        durationMs,
        agentOutput: output.slice(0, 1000),
        recallHit: false,
      });

      if (verbose) {
        console.log(`  [${success ? "PASS" : "FAIL"}] ${task.id} — ${tokensUsed} tok, ${durationMs}ms`);
      }
    } catch (err) {
      if (verbose) console.log(`  [ERR]  ${task.id} — ${err instanceof Error ? err.message : err}`);
      baselineRuns.push({
        taskId: task.id, success: false, tokensUsed: 0,
        durationMs: Date.now() - start, agentOutput: "", recallHit: false,
      });
    }

    // Small delay to respect rate limits
    await sleep(200);
  }

  // Phase 2: Build knowledge base
  if (verbose) console.log(`\n--- Phase 2: Building knowledge base ---`);

  const augDir = mkdtempSync(join(tmpdir(), "tb-eval-aug-"));
  const layer = new ReasoningLayer({ storagePath: join(augDir, "eval.db") });

  // If seeds provided, use them. Otherwise, use successful baseline runs.
  if (seeds && seeds.length > 0) {
    for (const seed of seeds) {
      layer.storeTrace({
        problem: {
          description: seed.problem,
          language: seed.language,
          framework: seed.framework,
          errorType: seed.errorType,
          tags: seed.tags,
        },
        solution: {
          summary: seed.solution,
          steps: [],
          outcome: "success",
        },
        metadata: { agent: "seed", source: "eval:seed" },
      });
    }
    if (verbose) console.log(`  Loaded ${seeds.length} seed traces`);
  } else {
    // Use baseline successes as knowledge (simulates compounding over time)
    for (let i = 0; i < tasks.length; i++) {
      const run = baselineRuns[i]!;
      if (!run.success) continue;
      const task = tasks[i]!;
      layer.storeTrace({
        problem: {
          description: task.description,
          language: task.language,
          framework: task.framework,
          errorType: task.errorType,
          tags: task.tags,
        },
        solution: {
          summary: run.agentOutput.slice(0, 500),
          steps: [],
          outcome: "success",
        },
        metadata: { agent: agent.name, model: agent.model, source: "eval:baseline" },
      });
    }
    if (verbose) console.log(`  Built KB from ${baselineRuns.filter(r => r.success).length} baseline successes`);
  }

  // Phase 3: Augmented — solve tasks WITH prior knowledge
  if (verbose) console.log(`\n--- Phase 3: Augmented (with TraceBase recall) ---`);

  for (const task of tasks) {
    const recallResults = layer.recall({
      problem: task.description,
      limit: 2,
      minScore: 0.1,
      context: {
        language: task.language,
        framework: task.framework,
        errorType: task.errorType,
      },
    });

    // Filter out exact self-matches (same description)
    // High-confidence gate: only inject when match is strong (>0.5 score)
    // This mirrors ReasonBlocks' confidence gate — avoid injecting noise
    const filtered = recallResults.filter(
      (r) => r.matchType !== "exact" && r.score >= 0.5
    );

    const recallHit = filtered.length > 0;
    let priorContext: string | undefined;
    if (recallHit) {
      const top = filtered[0]!;
      // Research-grade injection format combining:
      // - Imperative framing (Technique 2, Nano Surge paper)
      // - Dead-end avoidance (Technique 3, Context Awareness)
      // - Compressed payload (Technique 6, CompactPrompt)
      // Ref: "Token-Budget-Aware LLM Reasoning" (arxiv 2412.18547)
      // Ref: "Optimizing Token Consumption in LLM Code Reasoning" (arxiv 2504.15989)
      priorContext =
        `<known_fix confidence="${(top.score * 100).toFixed(0)}%" verified="true">\n` +
        `${top.trace.solution.summary}\n` +
        `</known_fix>\n` +
        `APPLY the known fix above directly. Do not re-derive or explore alternatives. Respond only with the implementation.`;
    }

    const start = Date.now();
    try {
      const { output, tokensUsed } = await agent.solve(task, priorContext);
      const durationMs = Date.now() - start;
      const success = verifySolution(output, task);

      augmentedRuns.push({
        taskId: task.id,
        success,
        tokensUsed,
        durationMs,
        agentOutput: output.slice(0, 1000),
        recallHit,
        injectedScore: filtered[0]?.score,
      });

      if (verbose) {
        const recall = recallHit ? `recall:${(filtered[0]!.score * 100).toFixed(0)}%` : "no-recall";
        console.log(`  [${success ? "PASS" : "FAIL"}] ${task.id} — ${tokensUsed} tok, ${durationMs}ms (${recall})`);
      }
    } catch (err) {
      if (verbose) console.log(`  [ERR]  ${task.id} — ${err instanceof Error ? err.message : err}`);
      augmentedRuns.push({
        taskId: task.id, success: false, tokensUsed: 0,
        durationMs: Date.now() - start, agentOutput: "", recallHit,
      });
    }

    await sleep(200);
  }

  layer.close();

  // Phase 4: Compute metrics
  const baseline = computeMetrics(baselineRuns);
  const augmented = computeMetrics(augmentedRuns);
  const delta = computeDelta(baseline, augmented, augmentedRuns);

  return {
    timestamp: Date.now(),
    agentName: agent.name,
    model: agent.model,
    taskCount: tasks.length,
    baseline,
    augmented,
    delta,
    perTask: tasks.map((task, i) => ({
      taskId: task.id,
      baseline: baselineRuns[i]!,
      augmented: augmentedRuns[i]!,
    })),
  };
}

/**
 * Verify if agent output is a correct solution.
 * Must contain at least half of the solution keywords.
 */
function verifySolution(output: string, task: EvalTask): boolean {
  const lower = output.toLowerCase();
  const matches = task.solutionKeywords.filter((kw) => lower.includes(kw.toLowerCase()));
  // Strict: require 2/3 of keywords (not half) — ensures the model gave a specific fix, not a vague answer
  return matches.length >= Math.ceil(task.solutionKeywords.length * 2 / 3);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
