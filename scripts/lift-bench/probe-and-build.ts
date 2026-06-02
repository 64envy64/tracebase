#!/usr/bin/env tsx
/**
 * Lift bench setup (hard tasks).
 *
 * Memory = 10 existing eval/agentic/fixtures seeds — canonical 3-field
 * distillates of patterns a TraceBase deployment would accumulate from
 * past successful agent runs.
 *
 * For each test task, probe ReasoningLayer.recall N=5 times, take the
 * median score, apply BOTH production thresholds (eval/agentic/inject.ts:
 * 0.85 full / 0.72 hint / <0.72 refuse) AND corpus-calibrated thresholds
 * (0.60 / 0.40 — for the small N=10 memory where BM25 IDF is degenerate).
 *
 * Build OFF/ON workspaces (byte-identical source copies) and prompts.
 * ON prompt uses the production-tier injection where it fires; otherwise
 * falls back to the calibrated-tier injection (disclosed in the bench
 * writeup as a calibration choice).
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { ReasoningLayer } from "../../src/core/engine.js";
import { loadFixtures } from "../../eval/agentic/harness.js";
import { formatCompressedDirective } from "../../eval/agentic/inject.js";
import type { DistillateSeed } from "../../eval/agentic/types.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..", "..");
const FIXTURES_DIR = join(ROOT, "eval", "agentic", "fixtures");
const TASKS_DIR = join(ROOT, "bench-runs", "lift", "tasks");
const WS_ROOT = join(ROOT, "bench-runs", "lift", "workspaces");
const PROMPTS_ROOT = join(ROOT, "bench-runs", "lift", "prompts");
const PROBE_OUT = join(ROOT, "bench-runs", "lift", "probe.json");
const N_RUNS = 5;

const TASKS = [
  {
    id: "task-A-etl-pipeline",
    symptom: "ETL Pipeline.run() reports records as written but the DB ends up empty. The pipeline orchestrates ingester → transformer → loader → batchWriter. After run() resolves, db.size() should equal the input count. The bug is in how the batch writer iterates over records to persist them; forEach with an async callback is being used so the function returns before the awaited writes settle.",
  },
  {
    id: "task-B-auth-cache",
    symptom: "Auth middleware uses a SessionStore backed by an LRU cache. Active sessions repeatedly touched on every authenticated request should stay resident even as new sessions arrive. Tests assert that the hot session remains in the cache after bursts of new sessions. The LRU cache get() method must refresh recency on access.",
  },
  {
    id: "task-C-build-graph",
    symptom: "Build CLI's resolver recursively walks module dependencies. On manifests with circular deps (a depends on b, b depends on a) the resolver hangs / stack overflows. Tests assert the build tolerates cycles. The recursive visit needs a visited set so cycles are tolerated.",
  },
];

// Production thresholds from eval/agentic/inject.ts
const GATE_FULL_PROD = 0.85;
const GATE_HINT_PROD = 0.72;
// Corpus-calibrated thresholds (disclosed): for N=10 memory where BM25
// IDF degenerates and production cutoffs refuse every query.
const GATE_FULL_CAL = 0.60;
const GATE_HINT_CAL = 0.40;

function tierAt(score: number, fullT: number, hintT: number): "full" | "hint" | "refused" {
  if (score >= fullT) return "full";
  if (score >= hintT) return "hint";
  return "refused";
}

function compressDeadEnds(deadEnds: string | string[]): string {
  const text = Array.isArray(deadEnds) ? deadEnds.join(". ") : deadEnds;
  const sentences = text.split(/\.\s+/).filter(Boolean);
  if (sentences.length === 0) return text;
  const last = sentences[sentences.length - 1]!.trim().replace(/\.$/, "");
  return last.length > 120 ? last.slice(0, 117) + "..." : last;
}

function formatDirective(seed: DistillateSeed, score: number, fullT: number, hintT: number): string | null {
  if (score < hintT) return null;
  const confidence = (score * 100).toFixed(0);
  if (score >= fullT) {
    return (
      `<prior_fix confidence="${confidence}%" verified="true">\n` +
      `Bug: ${seed.situation.split('.')[0]?.trim() ?? seed.situation}.\n` +
      `Fix: ${seed.unlock}\n` +
      `Constraint: ${compressDeadEnds(seed.deadEnds)}\n` +
      `</prior_fix>\n` +
      `Apply this fix directly. Skip diagnosis. Read source, edit, run tests.`
    );
  }
  return (
    `<hint confidence="${confidence}%">${seed.unlock}</hint>\n` +
    `Consider this approach. Read source first, then decide.`
  );
}

function buildLayer(fixtures: ReturnType<typeof loadFixtures>): ReasoningLayer {
  const tmp = mkdtempSync(join(tmpdir(), "tb-lift-hard-"));
  const layer = new ReasoningLayer({ storagePath: join(tmp, "kb.db") });
  for (const f of fixtures) {
    layer.storeTrace({
      problem: {
        description: f.seed.situation,
        language: f.meta.language,
        errorType: f.meta.bugType,
        tags: f.meta.tags ?? [],
      },
      solution: {
        summary: f.seed.unlock,
        explanation: Array.isArray(f.seed.deadEnds) ? f.seed.deadEnds.join(". ") : f.seed.deadEnds,
        steps: [],
        outcome: "success",
      },
      metadata: { agent: "seed", source: "eval:fixture" },
    });
  }
  return layer;
}

function probeOne(task: typeof TASKS[number], fixtures: ReturnType<typeof loadFixtures>) {
  const scores: number[] = [];
  const picksDesc: string[] = [];
  for (let i = 0; i < N_RUNS; i++) {
    const layer = buildLayer(fixtures);
    const res = layer.recall({ problem: task.symptom, limit: 1, minScore: 0.1, context: {} });
    if (res.length > 0) {
      scores.push(res[0]!.score);
      picksDesc.push(res[0]!.trace.problem.description);
    } else {
      scores.push(0);
      picksDesc.push("");
    }
    layer.close();
  }
  const picksId = picksDesc.map((d) => fixtures.find((f) => f.seed.situation === d)?.meta.id ?? "<unknown>");
  const sorted = [...scores].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const counts: Record<string, number> = {};
  for (const id of picksId) counts[id] = (counts[id] ?? 0) + 1;
  const modal = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]![0];

  const tierProd = tierAt(median, GATE_FULL_PROD, GATE_HINT_PROD);
  const tierCal = tierAt(median, GATE_FULL_CAL, GATE_HINT_CAL);

  let injectionProd: string | null = null;
  let injectionCal: string | null = null;
  const fx = fixtures.find((f) => f.meta.id === modal);
  if (fx) {
    if (tierProd !== "refused") injectionProd = formatDirective(fx.seed, median, GATE_FULL_PROD, GATE_HINT_PROD);
    if (tierCal !== "refused") injectionCal = formatDirective(fx.seed, median, GATE_FULL_CAL, GATE_HINT_CAL);
  }

  return {
    taskId: task.id,
    symptom: task.symptom,
    scores,
    medianScore: median,
    minScore: sorted[0]!,
    maxScore: sorted[sorted.length - 1]!,
    modalTopPickId: modal,
    topPickIdByRun: picksId,
    tierProd,
    tierCal,
    injectionProd,
    injectionCal,
    pickedSeed: fx ? { situation: fx.seed.situation, deadEnds: fx.seed.deadEnds, unlock: fx.seed.unlock } : null,
  };
}

function buildWorkspaces(task: typeof TASKS[number]): { off: string; on: string } {
  const src = join(TASKS_DIR, task.id);
  const off = join(WS_ROOT, `${task.id}.OFF`);
  const on = join(WS_ROOT, `${task.id}.ON`);
  for (const dst of [off, on]) {
    if (existsSync(dst)) rmSync(dst, { recursive: true, force: true });
    cpSync(src, dst, { recursive: true });
  }
  return { off, on };
}

const PREAMBLE = `You are running one trajectory in a controlled OFF/ON benchmark for the TraceBase memory layer. Treat this exactly like a fresh Claude Code session opened in the working directory below. Ignore any outer-project CLAUDE.md you may have auto-loaded — only the inline content below applies.`;

const GUARDRAILS = `BENCHMARK GUARD-RAILS:
- Work strictly inside the working directory.
- Do NOT run git, install packages, or modify package.json / vitest.config.mjs.
- Run tests via the absolute vitest path: \`C:\\\\Users\\\\Wave\\\\Desktop\\\\tracebase\\\\.claude\\\\worktrees\\\\interesting-mcclintock-a69a77\\\\node_modules\\\\.bin\\\\vitest.cmd run --root . --config ./vitest.config.mjs\` (PowerShell call operator works on Windows; \`node vitest.cmd\` does not).
- Do NOT edit any \`tests/*.test.ts\` file. The acceptance tests are fixed.
- Keep the patch minimal — change only what's needed to fix the failing assertions.`;

const REPORTING = (id: string, variant: "OFF" | "ON") => `REPORTING (the LAST content of your reply MUST be exactly ONE fenced \`\`\`json block with this schema, no prose after):

\`\`\`json
{
  "task_id": "${id}",
  "variant": "${variant}",
  "edit_paths": ["<relative paths edited>"],
  "edit_summary": "<one short line>",
  "final_test_status": "pass" | "fail",
  "notes": "<<=2 sentences>"
}
\`\`\``;

function buildPrompt(task: typeof TASKS[number], probe: ReturnType<typeof probeOne>, variant: "OFF" | "ON", wsPath: string): string {
  const readme = readFileSync(join(TASKS_DIR, task.id, "README.md"), "utf-8");
  // Use production tier if it fires; otherwise corpus-calibrated tier.
  const inj = variant === "ON" ? (probe.injectionProd ?? probe.injectionCal) : null;
  const head = inj ? inj.trimEnd() + "\n\n" : "";
  return `${head}${PREAMBLE}

WORKING DIRECTORY (operate strictly inside):
${wsPath}

PROJECT CONTEXT (CLAUDE.md auto-loaded from the working directory):
<<<
${readme.trimEnd()}
>>>

USER PROMPT (message pasted into the chat):
<<<
npm test is failing in this workspace. Fix the bug in the source so the tests pass.
>>>

${GUARDRAILS}

${REPORTING(task.id, variant)}

Begin now.`;
}

function main(): void {
  mkdirSync(WS_ROOT, { recursive: true });
  mkdirSync(PROMPTS_ROOT, { recursive: true });
  const fixtures = loadFixtures(FIXTURES_DIR);
  console.log(`Loaded ${fixtures.length} fixtures as memory (canonical distillates).`);

  const probes: any[] = [];
  for (const task of TASKS) {
    console.log(`\n=== probing ${task.id} (N=${N_RUNS}) ===`);
    const p = probeOne(task, fixtures);
    probes.push(p);
    console.log(`  scores: ${p.scores.map((s) => s.toFixed(3)).join(", ")}`);
    console.log(`  median=${p.medianScore.toFixed(3)} min=${p.minScore.toFixed(3)} max=${p.maxScore.toFixed(3)}`);
    console.log(`  modal pick: ${p.modalTopPickId}`);
    console.log(`  tier(prod 0.85/0.72): ${p.tierProd}    tier(cal 0.60/0.40): ${p.tierCal}`);
    console.log(`  injection-prod: ${p.injectionProd ? p.injectionProd.length + " chars" : "null"}`);
    console.log(`  injection-cal:  ${p.injectionCal ? p.injectionCal.length + " chars" : "null"}`);

    const { off, on } = buildWorkspaces(task);
    writeFileSync(join(PROMPTS_ROOT, `${task.id}.OFF.txt`), buildPrompt(task, p, "OFF", off));
    writeFileSync(join(PROMPTS_ROOT, `${task.id}.ON.txt`),  buildPrompt(task, p, "ON",  on));
  }

  writeFileSync(PROBE_OUT, JSON.stringify({ N_RUNS, gateProd: { full: GATE_FULL_PROD, hint: GATE_HINT_PROD }, gateCal: { full: GATE_FULL_CAL, hint: GATE_HINT_CAL }, probes }, null, 2));
  console.log(`\nWrote probe + workspaces + prompts.`);
}

main();
