#!/usr/bin/env tsx
/**
 * Probe the 3 hard test tasks against the captured-trace memory store,
 * apply the production tiered gate (eval/agentic/inject.ts), and build
 * OFF/ON sandboxes + prompts for sub-agent dispatch.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ReasoningLayer } from "../../src/core/engine.js";

// Corpus-calibrated equivalent of formatCompressedDirective from
// eval/agentic/inject.ts (production thresholds 0.85/0.72). Output
// format is BYTE-IDENTICAL to the production helper; only the
// threshold constants differ (0.60/0.40 for our N=10 captured corpus
// vs the production 0.85/0.72 calibrated for hundreds of patterns).
function formatCompressedDirectiveCalibrated(
  seed: { situation: string; deadEnds: string | string[]; unlock: string },
  score: number,
): string | null {
  if (score < GATE_HINT) return null;
  const confidence = (score * 100).toFixed(0);
  if (score >= GATE_FULL) {
    const deadEndText = Array.isArray(seed.deadEnds) ? seed.deadEnds.join(". ") : seed.deadEnds;
    const sentences = (deadEndText || "").split(/\.\s+/).filter(Boolean);
    const last = sentences.length > 0 ? sentences[sentences.length - 1]!.trim().replace(/\.$/, "") : "";
    const constraint = last.length > 120 ? last.slice(0, 117) + "..." : last;
    return (
      `<prior_fix confidence="${confidence}%" verified="true">\n` +
      `Bug: ${seed.situation.split(".")[0]?.trim() ?? seed.situation}.\n` +
      `Fix: ${seed.unlock}\n` +
      `Constraint: ${constraint}\n` +
      `</prior_fix>\n` +
      `Apply this fix directly. Skip diagnosis. Read source, edit, run tests.`
    );
  }
  return (
    `<hint confidence="${confidence}%">${seed.unlock}</hint>\n` +
    `Consider this approach. Read source first, then decide.`
  );
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..", "..");
const LIFT = join(ROOT, "bench-runs", "lift");
const TASKS = join(LIFT, "tasks");
const STORE_DB = join(LIFT, "store", ".tracebase", "memory.db");
const WS = join(LIFT, "workspaces");
const PROMPTS = join(LIFT, "test-prompts");
if (existsSync(WS)) rmSync(WS, { recursive: true, force: true });
if (existsSync(PROMPTS)) rmSync(PROMPTS, { recursive: true, force: true });
mkdirSync(WS, { recursive: true });
mkdirSync(PROMPTS, { recursive: true });

const N_PROBES = 5;

interface TaskMeta {
  id: string;
  symptom: string;
}
const TASKS_META: TaskMeta[] = [
  {
    id: "task-A-etl-pipeline",
    symptom: "ETL Pipeline.run() returns a report saying records were written, but the destination DB is empty when checked after run() resolves. The pipeline orchestrates ingester → transformer → loader → batchWriter. Investigate, fix the bug, and confirm all tests pass.",
  },
  {
    id: "task-B-auth-cache",
    symptom: "Under realistic auth load (intermixed session-creates and per-session permission checks), the application's hot session gets evicted from the session cache even though it is being actively used. Tests assert the hot session survives bursts of new sessions. Investigate, fix the bug, and confirm all tests pass.",
  },
  {
    id: "task-C-build-graph",
    symptom: "The build CLI hangs (or stack-overflows) when the input manifest contains modules with circular dependencies. The dependency resolver recurses into already-visited nodes. Tests assert the build completes and reports the cycle. Investigate, fix the bug, and confirm all tests pass.",
  },
];

// Corpus-calibrated thresholds: production 0.85/0.72 were chosen for a
// corpus of hundreds of organic patterns; on N=10 captured traces FTS5
// IDF is degenerate and scores cluster low. We re-calibrate to 0.60/0.40
// for this corpus size and disclose this in the writeup.
const GATE_FULL = 0.60;
const GATE_HINT = 0.40;
function tierOf(score: number): "full" | "hint" | "refused" {
  if (score >= GATE_FULL) return "full";
  if (score >= GATE_HINT) return "hint";
  return "refused";
}

const probe: any[] = [];
for (const t of TASKS_META) {
  const scores: number[] = [];
  const picks: string[] = [];
  let bestSeed: any = null;
  for (let i = 0; i < N_PROBES; i++) {
    const layer = new ReasoningLayer({ storagePath: STORE_DB });
    const r = layer.recall({
      problem: t.symptom,
      limit: 1,
      minScore: 0.05,
    });
    layer.close();
    if (r.length > 0) {
      scores.push(r[0].score);
      // The trace.solution.summary is the unlock; trace.problem.description is the situation.
      picks.push(r[0].trace.problem.description.slice(0, 40));
      if (!bestSeed || r[0].score > (bestSeed.score ?? 0)) {
        bestSeed = r[0];
      }
    }
  }
  const sorted = [...scores].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const min = sorted[0] ?? 0;
  const max = sorted[sorted.length - 1] ?? 0;
  const medianTier = tierOf(median);
  const maxTier = tierOf(max);

  // Build a DistillateSeed shape that formatCompressedDirective accepts.
  let injection: string | null = null;
  if (bestSeed) {
    const seed = {
      situation: bestSeed.trace.problem.description,
      unlock: bestSeed.trace.solution.summary,
      deadEnds: bestSeed.trace.solution.explanation ?? "",
    };
    injection = formatCompressedDirectiveCalibrated(seed, median);
  }
  probe.push({
    task_id: t.id,
    scores,
    median,
    min,
    max,
    tierAtMedian: medianTier,
    tierAtMax: maxTier,
    topPickSituationSnippets: picks,
    injection_text: injection,
    injection_chars: injection ? injection.length : 0,
  });

  // Build OFF/ON workspaces
  for (const variant of ["OFF", "ON"] as const) {
    const ws = join(WS, `${t.id}.${variant}`);
    mkdirSync(ws, { recursive: true });
    cpSync(join(TASKS, t.id), ws, { recursive: true });
  }

  // Build prompts
  const PREAMBLE = `You are a Claude Code agent running ONE controlled trajectory in an honest OFF/ON benchmark for the TraceBase memory layer. Treat this exactly like a fresh Claude Code session opened on the working directory below. Ignore any outer-project CLAUDE.md you may have auto-loaded.`;
  const RULES = `RULES:
- Work strictly inside the working directory.
- Do NOT run git, do NOT install packages, do NOT modify package.json or vitest.config.
- Run tests with: powershell -Command "& 'C:\\Users\\Wave\\Desktop\\tracebase\\.claude\\worktrees\\interesting-mcclintock-a69a77\\node_modules\\.bin\\vitest.cmd' run --root '<working-dir>' --no-color --reporter=basic"
- Do NOT edit anything matching *.test.ts. The acceptance tests are fixed.
- Keep your patch minimal.`;
  const REPORT = `REPORTING (LAST content of your reply MUST be exactly ONE fenced JSON block, no prose after it):

\`\`\`json
{
  "task_id": "${t.id}",
  "variant": "<OFF|ON>",
  "final_test_status": "pass|fail",
  "edit_paths": ["<files you changed>"],
  "edit_summary": "<one-line summary of the patch>",
  "notes": "<any honest observation>"
}
\`\`\``;

  for (const variant of ["OFF", "ON"] as const) {
    const head = variant === "ON" && injection ? injection + "\n\n" : "";
    const body = `${head}${PREAMBLE}

WORKING DIRECTORY (operate strictly inside):
${join(WS, `${t.id}.${variant}`)}

YOUR TASK (this is the user's bug report):
${t.symptom}

${RULES}

${REPORT.replace("<OFF|ON>", variant)}

Begin now.`;
    writeFileSync(join(PROMPTS, `${t.id}.${variant}.txt`), body);
  }
}

writeFileSync(join(LIFT, "probe.json"), JSON.stringify(probe, null, 2));
console.log("=== probe ===");
for (const p of probe) {
  console.log(`  ${p.task_id.padEnd(26)} median=${p.median.toFixed(3)} (${p.min.toFixed(2)}-${p.max.toFixed(2)})  tier(med)=${p.tierAtMedian} tier(max)=${p.tierAtMax}  inject=${p.injection_chars}b`);
}
console.log("\nWrote workspaces + prompts.");
