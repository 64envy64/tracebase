#!/usr/bin/env tsx
/**
 * Re-probe with MODAL-PICK selection (production-realistic single shot
 * equivalent), then build oracle-ablation workspaces & prompts for 4
 * variants per task:
 *   OFF                    — no injection
 *   ON-correct  (oracle)   — forced injection with the canonical-correct distillate
 *   ON-wrong    (oracle)   — forced injection with a known-incorrect distillate
 *   ON-tracebase           — production retrieval + gate (modal-pick fix)
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ReasoningLayer } from "../../src/core/engine.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..", "..");
const LIFT = join(ROOT, "bench-runs", "lift");
const TASKS = join(LIFT, "tasks");
const STORE_DB = join(LIFT, "store", ".tracebase", "memory.db");
const WS = join(LIFT, "ablation-workspaces");
const PROMPTS = join(LIFT, "ablation-prompts");
if (existsSync(WS)) rmSync(WS, { recursive: true, force: true });
if (existsSync(PROMPTS)) rmSync(PROMPTS, { recursive: true, force: true });
mkdirSync(WS, { recursive: true });
mkdirSync(PROMPTS, { recursive: true });

// Corpus-calibrated gate thresholds (documented).
const GATE_FULL = 0.60;
const GATE_HINT = 0.40;

function tierOf(score: number): "full" | "hint" | "refused" {
  if (score >= GATE_FULL) return "full";
  if (score >= GATE_HINT) return "hint";
  return "refused";
}

function formatHint(seed: { situation: string; unlock: string; deadEnds: string | string[] }, score: number, tier: "hint" | "full"): string {
  const confidence = (score * 100).toFixed(0);
  if (tier === "full") {
    const deadEndText = Array.isArray(seed.deadEnds) ? seed.deadEnds.join(". ") : seed.deadEnds;
    const sentences = (deadEndText || "").split(/\.\s+/).filter(Boolean);
    const last = sentences.length > 0 ? sentences[sentences.length - 1]!.trim().replace(/\.$/, "") : "";
    const constraint = last.length > 120 ? last.slice(0, 117) + "..." : last;
    return (
      `<prior_fix confidence="${confidence}%" verified="true">\n` +
      `Bug: ${seed.situation.split(".")[0]?.trim() ?? seed.situation}.\n` +
      `Fix: ${seed.unlock}\n` +
      `Constraint: ${constraint}\n` +
      `</prior_fix>\nApply this fix directly. Skip diagnosis. Read source, edit, run tests.`
    );
  }
  return `<hint confidence="${confidence}%">${seed.unlock}</hint>\nConsider this approach. Read source first, then decide.`;
}

// Load all captured distillates for oracle injections
const distillates: any[] = readFileSync(join(LIFT, "distillates", "captured.jsonl"), "utf-8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));
const distMap = new Map<string, any>();
for (const d of distillates) distMap.set(d.fixture_id, d);

interface TaskSpec {
  id: string;
  symptom: string;
  oracleCorrect: string;   // fixture_id of correct distillate
  oracleWrong: string;     // fixture_id of known-irrelevant distillate
}

const TASKS_SPEC: TaskSpec[] = [
  {
    id: "task-A-etl-pipeline",
    symptom: "ETL Pipeline.run() returns a report saying records were written, but the destination DB is empty when checked after run() resolves. The pipeline orchestrates ingester → transformer → loader → batchWriter. Investigate, fix the bug, and confirm all tests pass.",
    oracleCorrect: "fix-async-race",
    oracleWrong: "fix-tree-depth",
  },
  {
    id: "task-B-auth-cache",
    symptom: "Under realistic auth load (intermixed session-creates and per-session permission checks), the application's hot session gets evicted from the session cache even though it is being actively used. Tests assert the hot session survives bursts of new sessions. Investigate, fix the bug, and confirm all tests pass.",
    oracleCorrect: "fix-cache-invalidation",
    oracleWrong: "fix-event-leak",
  },
  {
    id: "task-C-build-graph",
    symptom: "The build CLI hangs (or stack-overflows) when the input manifest contains modules with circular dependencies. The dependency resolver recurses into already-visited nodes. Tests assert the build completes and reports the cycle. Investigate, fix the bug, and confirm all tests pass.",
    oracleCorrect: "fix-deep-clone",
    oracleWrong: "fix-null-coalesce",
  },
];

// Probe TraceBase with MODAL selection
const N_PROBES = 5;
const probe: any[] = [];
for (const t of TASKS_SPEC) {
  const picks: Array<{ id: string; score: number; situation: string; unlock: string; deadEnds: string }> = [];
  for (let i = 0; i < N_PROBES; i++) {
    const layer = new ReasoningLayer({ storagePath: STORE_DB });
    const r = layer.recall({ problem: t.symptom, limit: 1, minScore: 0.05 });
    layer.close();
    if (r.length > 0) {
      // Map back to fixture_id by matching situation against distillates
      let matchedId = "?";
      for (const d of distillates) {
        if (d.situation === r[0].trace.problem.description) {
          matchedId = d.fixture_id;
          break;
        }
      }
      picks.push({
        id: matchedId,
        score: r[0].score,
        situation: r[0].trace.problem.description,
        unlock: r[0].trace.solution.summary,
        deadEnds: r[0].trace.solution.explanation ?? "",
      });
    }
  }

  // Modal pick: most common id across probes (tie-break by highest median score within group)
  const byId = new Map<string, typeof picks>();
  for (const p of picks) {
    if (!byId.has(p.id)) byId.set(p.id, []);
    byId.get(p.id)!.push(p);
  }
  const groups = Array.from(byId.entries()).sort((a, b) => b[1].length - a[1].length);
  const modalGroup = groups[0]?.[1] ?? [];
  const modalId = groups[0]?.[0] ?? "?";
  const modalScores = modalGroup.map((p) => p.score).sort((a, b) => a - b);
  const modalMedian = modalScores[Math.floor(modalScores.length / 2)] ?? 0;
  const modalTier = tierOf(modalMedian);

  let traceBaseInjection: string | null = null;
  if (modalGroup.length > 0 && modalTier !== "refused") {
    const seed = modalGroup[0]!; // representative
    traceBaseInjection = formatHint({ situation: seed.situation, unlock: seed.unlock, deadEnds: seed.deadEnds }, modalMedian, modalTier);
  }

  probe.push({
    task_id: t.id,
    n_probes: N_PROBES,
    modal_pick_id: modalId,
    modal_pick_count: `${modalGroup.length}/${N_PROBES}`,
    modal_median_score: modalMedian,
    modal_tier: modalTier,
    per_probe_picks: picks.map((p) => ({ id: p.id, score: round3(p.score) })),
    tracebase_injection: traceBaseInjection,
    oracle_correct_id: t.oracleCorrect,
    oracle_correct_pick_count: `${(byId.get(t.oracleCorrect) ?? []).length}/${N_PROBES}`,
    gate_picked_correct: modalId === t.oracleCorrect,
  });

  // Build 4 workspaces + prompts per task
  for (const variant of ["OFF", "ON-tracebase", "ON-oracle-correct", "ON-oracle-wrong"] as const) {
    const wsDir = join(WS, `${t.id}.${variant}`);
    mkdirSync(wsDir, { recursive: true });
    cpSync(join(TASKS, t.id), wsDir, { recursive: true });

    let injection: string | null = null;
    if (variant === "ON-tracebase") injection = traceBaseInjection;
    if (variant === "ON-oracle-correct") {
      const d = distMap.get(t.oracleCorrect)!;
      injection = formatHint({ situation: d.situation, unlock: d.unlock, deadEnds: d.deadEnds }, 0.78, "hint");
    }
    if (variant === "ON-oracle-wrong") {
      const d = distMap.get(t.oracleWrong)!;
      injection = formatHint({ situation: d.situation, unlock: d.unlock, deadEnds: d.deadEnds }, 0.78, "hint");
    }

    const PREAMBLE = `You are a Claude Code agent running ONE controlled trajectory in an honest TraceBase oracle ablation. Treat this exactly like a fresh Claude Code session opened on the working directory below. Ignore any outer-project CLAUDE.md.`;
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
  "variant": "${variant}",
  "final_test_status": "pass|fail",
  "edit_paths": ["<files you changed>"],
  "edit_summary": "<one-line summary of the patch>",
  "notes": "<any honest observation>"
}
\`\`\``;

    const head = injection ? injection + "\n\n" : "";
    const body = `${head}${PREAMBLE}

WORKING DIRECTORY (operate strictly inside):
${wsDir}

YOUR TASK (this is the user's bug report):
${t.symptom}

${RULES}

${REPORT}

Begin now.`;
    writeFileSync(join(PROMPTS, `${t.id}.${variant}.txt`), body);
  }
}

writeFileSync(join(LIFT, "probe-ablation.json"), JSON.stringify(probe, null, 2));
console.log("=== probe (modal selection) + ablation ===");
for (const p of probe) {
  console.log(`  ${p.task_id.padEnd(26)} modal=${p.modal_pick_id.padEnd(28)} (${p.modal_pick_count})  median=${p.modal_median_score.toFixed(3)}  tier=${p.modal_tier}  correct?=${p.gate_picked_correct}`);
}
console.log("\nWrote ablation workspaces + prompts (12 trajectories: 3 tasks × 4 variants).");

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
