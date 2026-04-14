#!/usr/bin/env node
/**
 * Smoke test — runs 1 task per model to verify everything works
 * before committing to a full (expensive) benchmark run.
 */
import { LLMAgent } from "./agents/llm-agent.js";
import { runBenchmark } from "./harness.js";
import type { EvalTask } from "./types.js";

const TEST_TASK: EvalTask = {
  id: "smoke-cors",
  description: "CORS error: Access-Control-Allow-Origin header missing when calling Express API from React frontend",
  language: "typescript",
  framework: "express",
  errorType: "CORS",
  difficulty: "easy",
  solutionKeywords: ["cors", "middleware", "Access-Control", "app.use"],
  expectedSolution: "Install and configure cors middleware: app.use(cors())",
  tags: ["api", "cors"],
};

const MODELS = [
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.3-chat",
];

async function main() {
  console.log("Smoke test — 1 task × 6 models\n");

  for (const model of MODELS) {
    process.stdout.write(`  ${model.padEnd(30)}`);
    try {
      const agent = new LLMAgent(model);
      const result = await runBenchmark(agent, [TEST_TASK]);
      const b = result.baseline;
      const a = result.augmented;
      console.log(
        `baseline: ${b.successRate === 1 ? "PASS" : "FAIL"} (${b.avgTokens.toFixed(0)} tok) → ` +
        `augmented: ${a.successRate === 1 ? "PASS" : "FAIL"} (${a.avgTokens.toFixed(0)} tok) ` +
        `[Δ tokens: ${result.delta.tokenSavingsPercent > 0 ? "-" : "+"}${Math.abs(result.delta.tokenSavingsPercent).toFixed(1)}%]`
      );
    } catch (err) {
      console.log(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

main().catch(console.error);
