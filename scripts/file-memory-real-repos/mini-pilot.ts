#!/usr/bin/env tsx
/**
 * Box-6 shortened mini-pilot (NOT the N=25 pilot).
 *
 * Phase A (OFF nav-surface scan): run the OFF arm for selected tasks in
 * selected-tasks order, tightly capped. A task "qualifies" if its OFF arm
 * has navigation surface: Glob+Grep >= 1 OR Read >= 3. Early-stop once 8
 * qualifiers are found.
 *
 * Phase B (ON): run the ON arm for the qualifying tasks with the fixed
 * minimal UserPromptSubmit-only hook + TRACEBASE_SKIP_HOOK_SELF_HEAL=1.
 * Assert hook isolation after EVERY ON run (only UserPromptSubmit allowed);
 * STOP immediately if hook_isolation.ok is false.
 *
 * Budget: hard total cap (default $8). Each trajectory is capped, and a run
 * is skipped if it would exceed the total. NO retries (except never — model
 * behaviour is never retried; only infra failures would be, manually).
 *
 * PLATFORM CONSTRAINT (documented, not worked around): the child `claude`
 * CLI runs on Windows only, and only repos whose Windows clone has installed
 * deps are runnable. At run time only josdejong/mathjs has Windows
 * node_modules; zod (pnpm/corepack fails on Windows Node 20.17), black + rich
 * (Python venvs created in WSL) are NOT runnable here. Those tasks are
 * recorded as infra-skipped (not model behaviour). This makes the mini-pilot
 * single-repo / JS-only — a real limitation surfaced in the report.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runTrajectory } from "../path-a-harness/run-trajectory.js";
import {
  REPO_DIR_MAP, RESULTS,
  materializeWorkspace, buildPrompt, parseTranscript, extractRecalledFiles,
  verifyPass, num, totalTokens,
} from "./smoke.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..", "..");
const BENCH = join(ROOT, "bench-runs", "file-memory-real-repos");
const REPOS = join(BENCH, "repos");

// CRITICAL bench-isolation guard (propagates to the child claude + its
// hooks): stop inject-context self-heal from contaminating the ON arm.
process.env.TRACEBASE_SKIP_HOOK_SELF_HEAL = "1";

const TOTAL_CAP = 8.0;
const PER_TRAJ_CAP = 0.5;
const SAFETY_STOP = TOTAL_CAP - 0.1; // never start a run past here
const TARGET_QUALIFIERS = 8;
const TIMEOUT_MS = 480_000;

let spend = 0;

function runnable(task: any): boolean {
  const dir = REPO_DIR_MAP[task.repo];
  if (!dir) return false;
  // JS/TS repos need node_modules; Python repos need a Windows venv. Only
  // node_modules-present clones are runnable on this (Windows) host.
  return existsSync(join(REPOS, dir, "node_modules"));
}

interface RunResult {
  task_id: string; repo: string; pr_commit: string; variant: "OFF" | "ON";
  pass: boolean | null; test_exit: number | null;
  glob: number; grep: number; read: number; edit: number; bash: number;
  tool_counts: Record<string, number>; bytes_read: number;
  tokens: number | null; wall_sec: number; cost_usd: number | null; turns: number | null;
  terminal_reason: any; recalled_files: string[] | null;
  hook_isolation: { ok: boolean; events: string[] } | null;
  exit_code: number | null;
}

function checkHookIsolation(ws: string): { ok: boolean; events: string[] } {
  try {
    const sj = JSON.parse(readFileSync(join(ws, ".claude", "settings.json"), "utf-8"));
    const events = Object.keys(sj.hooks ?? {});
    return { ok: events.length === 1 && events[0] === "UserPromptSubmit", events };
  } catch (e: any) {
    return { ok: false, events: [`read-failed: ${e.message}`] };
  }
}

function runOne(task: any, variant: "OFF" | "ON"): RunResult {
  const repoDir = REPO_DIR_MAP[task.repo];
  const taskId = `${repoDir}-${task.pr_commit.slice(0, 8)}`;
  const { ws } = materializeWorkspace(task, variant);
  const prompt = buildPrompt(task, ws);
  const sessionId = randomUUID();
  const cap = Math.max(0.05, Math.min(PER_TRAJ_CAP, TOTAL_CAP - spend));

  const t0 = Date.now();
  const traj = runTrajectory({
    workspace: ws, prompt, sessionId,
    model: "claude-haiku-4-5",
    maxBudgetUsd: cap,
    allowedTools: "Read,Edit,Bash,Grep,Glob",
    timeoutMs: TIMEOUT_MS,
  });
  const wallSec = Math.round((Date.now() - t0) / 100) / 10;
  const cost = num(traj.parsed as any, "total_cost_usd");
  const tm = parseTranscript(traj.transcriptPath);
  const verify = verifyPass(task, ws);
  const recalled = variant === "ON" ? extractRecalledFiles(traj.transcriptPath) : null;
  const hookIso = variant === "ON" ? checkHookIsolation(ws) : null;

  if (typeof cost === "number") spend += cost;

  return {
    task_id: taskId, repo: task.repo, pr_commit: task.pr_commit, variant,
    pass: verify.exit === 0, test_exit: verify.exit,
    glob: tm.toolCounts["Glob"] ?? 0, grep: tm.toolCounts["Grep"] ?? 0,
    read: tm.toolCounts["Read"] ?? 0, edit: tm.toolCounts["Edit"] ?? 0, bash: tm.toolCounts["Bash"] ?? 0,
    tool_counts: tm.toolCounts, bytes_read: tm.bytesRead,
    tokens: totalTokens((traj.parsed as any)?.usage), wall_sec: wallSec,
    cost_usd: cost, turns: num(traj.parsed as any, "num_turns"),
    terminal_reason: (traj.parsed as any)?.subtype ?? null,
    recalled_files: recalled,
    hook_isolation: hookIso,
    exit_code: traj.exitCode,
  };
}

function navSurface(r: RunResult): boolean {
  return (r.glob + r.grep) >= 1 || r.read >= 3;
}

async function main() {
  mkdirSync(RESULTS, { recursive: true });
  const sel = JSON.parse(readFileSync(join(BENCH, "selected-tasks.json"), "utf-8"));
  const tasks: any[] = sel.tasks;

  const skippedInfra: Array<{ task_id: string; repo: string; reason: string }> = [];
  const offResults: RunResult[] = [];
  const qualifiers: any[] = [];

  console.log(`=== MINI-PILOT: OFF nav-surface scan (cap $${TOTAL_CAP}, target ${TARGET_QUALIFIERS} qualifiers) ===`);
  for (const task of tasks) {
    if (qualifiers.length >= TARGET_QUALIFIERS) { console.log(`reached ${TARGET_QUALIFIERS} qualifiers — stopping scan`); break; }
    if (spend >= SAFETY_STOP) { console.log(`spend $${spend.toFixed(2)} >= safety stop — halting scan`); break; }
    const repoDir = REPO_DIR_MAP[task.repo];
    const taskId = `${repoDir}-${task.pr_commit.slice(0, 8)}`;
    if (!runnable(task)) {
      skippedInfra.push({ task_id: taskId, repo: task.repo, reason: "no Windows deps (node_modules/venv absent on claude-capable host)" });
      console.log(`  SKIP(infra) ${taskId} — ${task.repo} not runnable on Windows`);
      continue;
    }
    const r = runOne(task, "OFF");
    offResults.push(r);
    const q = navSurface(r);
    if (q) qualifiers.push(task);
    console.log(`  OFF ${taskId}  pass=${r.pass} Glob+Grep=${r.glob + r.grep} Read=${r.read} tok=${r.tokens} ${r.wall_sec}s $${r.cost_usd?.toFixed(3)} ${q ? "→ QUALIFIES" : "→ no nav surface"}  [spend $${spend.toFixed(3)}]`);
  }

  console.log(`\n=== ON arm for ${qualifiers.length} qualifier(s) (isolation-guarded) ===`);
  const onResults: RunResult[] = [];
  let contaminationStop = false;
  for (const task of qualifiers) {
    if (spend >= SAFETY_STOP) { console.log(`spend $${spend.toFixed(2)} >= safety stop — halting ON`); break; }
    const r = runOne(task, "ON");
    onResults.push(r);
    console.log(`  ON  ${r.task_id}  pass=${r.pass} Glob+Grep=${r.glob + r.grep} Read=${r.read} tok=${r.tokens} ${r.wall_sec}s $${r.cost_usd?.toFixed(3)} iso=${r.hook_isolation?.ok} recalled=${JSON.stringify(r.recalled_files)}  [spend $${spend.toFixed(3)}]`);
    if (r.hook_isolation && !r.hook_isolation.ok) {
      console.log(`  !! HOOK ISOLATION FAILED (${r.hook_isolation.events.join(",")}) — STOPPING IMMEDIATELY`);
      contaminationStop = true;
      break;
    }
  }

  // Pair OFF/ON by task_id for the report.
  const onById = new Map(onResults.map((r) => [r.task_id, r]));
  const pairs = offResults
    .filter((o) => onById.has(o.task_id))
    .map((o) => ({ off: o, on: onById.get(o.task_id)! }));

  const out = {
    phase: "box-6 shortened mini-pilot (NOT N=25)",
    ran_isolation_guard: "TRACEBASE_SKIP_HOOK_SELF_HEAL=1",
    budget_cap_usd: TOTAL_CAP, per_traj_cap_usd: PER_TRAJ_CAP,
    platform_note: "child claude is Windows-only; only repos with Windows deps are runnable. At run time: mathjs only. zod/black/rich skipped (deps WSL-only / pnpm fails on Win Node 20.17). Single-repo, JS-only signal.",
    off_scanned: offResults.length,
    skipped_infra: skippedInfra,
    qualifiers: qualifiers.map((t) => `${REPO_DIR_MAP[t.repo]}-${t.pr_commit.slice(0, 8)}`),
    contamination_stop: contaminationStop,
    off_results: offResults,
    on_results: onResults,
    pairs: pairs.map(({ off, on }) => ({
      task_id: off.task_id, repo: off.repo,
      off_pass: off.pass, on_pass: on.pass,
      off_glob_grep: off.glob + off.grep, on_glob_grep: on.glob + on.grep,
      off_read: off.read, on_read: on.read,
      off_bytes_read: off.bytes_read, on_bytes_read: on.bytes_read,
      off_tokens: off.tokens, on_tokens: on.tokens,
      off_wall_sec: off.wall_sec, on_wall_sec: on.wall_sec,
      off_cost: off.cost_usd, on_cost: on.cost_usd,
      off_turns: off.turns, on_turns: on.turns,
      on_recalled_files: on.recalled_files,
      on_hook_isolation_ok: on.hook_isolation?.ok,
      glob_grep_delta: (on.glob + on.grep) - (off.glob + off.grep),
      read_delta: on.read - off.read,
      tokens_delta_pct: off.tokens ? Math.round(((on.tokens! - off.tokens) / off.tokens) * 1000) / 10 : null,
      duration_delta_pct: off.wall_sec ? Math.round(((on.wall_sec - off.wall_sec) / off.wall_sec) * 1000) / 10 : null,
    })),
    total_spend_usd: Math.round(spend * 10000) / 10000,
  };
  const outPath = join(RESULTS, "box-6-mini-pilot.json");
  writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");

  console.log(`\n=== SUMMARY ===`);
  console.log(`OFF scanned: ${offResults.length}, infra-skipped: ${skippedInfra.length}, qualifiers: ${qualifiers.length}, pairs: ${pairs.length}`);
  console.log(`hook isolation all OK: ${onResults.every((r) => r.hook_isolation?.ok) && !contaminationStop}`);
  console.log(`TOTAL SPEND: $${spend.toFixed(4)} / $${TOTAL_CAP}`);
  console.log(`Wrote ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
