#!/usr/bin/env tsx
/**
 * N=25 file-memory real-repo pilot (locked PRE-REGISTRATION-REAL-REPOS.md).
 * Runs ALL 25 selected tasks, OFF then ON, in WSL (claude + deps live there).
 *
 * ON = file_memory only (indexed_files + indexed_symbols + UserPromptSubmit→
 * inject-context). TRACEBASE_SKIP_HOOK_SELF_HEAL=1 keeps it isolated.
 *
 * Guarantees:
 *  - hook isolation asserted after every ON (exactly UserPromptSubmit) — STOP on fail.
 *  - dependency-env junk asserted absent from ON-recalled paths (.venv/node_modules/
 *    site-packages/etc.) — recorded as junk_fp; the walker excludes these so it must be 0.
 *  - incremental JSONL written after EVERY trajectory (crash recovery / resume).
 *  - no retries (infra failures surface as exit_code/terminal_reason and are documented).
 *  - STOP on isolation failure or spend cap.
 *
 * Budget: $12 for this run (per operator). Paths env-configurable (smoke.ts).
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, fsyncSync, openSync, closeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { runTrajectory } from "../path-a-harness/run-trajectory.js";
import {
  REPO_DIR_MAP, RESULTS, BENCH,
  materializeWorkspace, buildPrompt, parseTranscript, extractRecalledFiles,
  verifyPass, num, totalTokens,
} from "./smoke.js";

process.env.TRACEBASE_SKIP_HOOK_SELF_HEAL = "1";

const TOTAL_CAP = 12.0;
const SAFETY_STOP = 11.5;
const PER_TRAJ_CAP = 0.5;
const TIMEOUT_MS = 600_000;
const K = 5;
const PROGRESS = join(RESULTS, "pilot-n25-progress.jsonl");
const AGG = join(RESULTS, "pilot-n25.json");

const DEP_JUNK = /(^|\/)(\.venv|venv|\.env|env|site-packages|dist-packages|__pycache__|node_modules|\.tox|\.nox|\.pytest_cache|\.mypy_cache|\.ruff_cache)\//i;
const isJunk = (p: string): boolean => DEP_JUNK.test(p.replace(/\\/g, "/"));

let spend = 0;

function checkHookIsolation(ws: string): { ok: boolean; events: string[] } {
  try {
    const sj = JSON.parse(readFileSync(join(ws, ".claude", "settings.json"), "utf-8"));
    const events = Object.keys(sj.hooks ?? {});
    return { ok: events.length === 1 && events[0] === "UserPromptSubmit", events };
  } catch (e: any) {
    return { ok: false, events: [`read-failed: ${e.message}`] };
  }
}

function appendProgress(obj: unknown): void {
  const fd = openSync(PROGRESS, "a");
  try { appendFileSync(fd, JSON.stringify(obj) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
}

function runOne(task: any, variant: "OFF" | "ON"): any {
  const repoDir = REPO_DIR_MAP[task.repo];
  const taskId = `${repoDir}-${task.pr_commit.slice(0, 8)}`;
  const { ws } = materializeWorkspace(task, variant);
  const prompt = buildPrompt(task, ws);
  const sessionId = randomUUID();
  const cap = Math.max(0.05, Math.min(PER_TRAJ_CAP, TOTAL_CAP - spend));
  const t0 = Date.now();
  const traj = runTrajectory({
    workspace: ws, prompt, sessionId, model: "claude-haiku-4-5",
    maxBudgetUsd: cap, allowedTools: "Read,Edit,Bash,Grep,Glob", timeoutMs: TIMEOUT_MS,
  });
  const wallSec = Math.round((Date.now() - t0) / 100) / 10;
  const cost = num(traj.parsed as any, "total_cost_usd");
  if (typeof cost === "number") spend += cost;
  const tm = parseTranscript(traj.transcriptPath);
  const verify = verifyPass(task, ws);
  const recalled = variant === "ON" ? extractRecalledFiles(traj.transcriptPath) : null;
  const srcSet = new Set<string>(task.source_files_touched ?? []);
  const junk = (recalled ?? []).filter(isJunk);
  return {
    task_id: taskId, repo: task.repo, pr_commit: task.pr_commit, variant,
    pass: verify.exit === 0, test_exit: verify.exit,
    glob: tm.toolCounts["Glob"] ?? 0, grep: tm.toolCounts["Grep"] ?? 0,
    read: tm.toolCounts["Read"] ?? 0, edit: tm.toolCounts["Edit"] ?? 0, bash: tm.toolCounts["Bash"] ?? 0,
    powershell: tm.toolCounts["PowerShell"] ?? 0, tool_counts: tm.toolCounts, bytes_read: tm.bytesRead,
    tokens: totalTokens((traj.parsed as any)?.usage), duration_ms: num(traj.parsed as any, "duration_ms"),
    wall_sec: wallSec, cost_usd: cost, turns: num(traj.parsed as any, "num_turns"),
    terminal_reason: (traj.parsed as any)?.subtype ?? null,
    recalled_files: recalled,
    expected_source_in_topk: variant === "ON" ? (recalled ?? []).some((p) => srcSet.has(p)) : null,
    hook_isolation: variant === "ON" ? checkHookIsolation(ws) : null,
    dep_junk_recalled: variant === "ON" ? junk : null,
    exit_code: traj.exitCode,
  };
}

function main() {
  mkdirSync(RESULTS, { recursive: true });
  const sel = JSON.parse(readFileSync(join(BENCH, "selected-tasks.json"), "utf-8"));
  const tasks: any[] = sel.tasks;

  // Resume: load completed (task_id+variant) from prior JSONL.
  const done = new Map<string, any>();
  if (existsSync(PROGRESS)) {
    for (const line of readFileSync(PROGRESS, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); done.set(`${r.task_id}.${r.variant}`, r); } catch { /* skip */ }
      try { const r = JSON.parse(line); if (typeof r.cost_usd === "number") spend += r.cost_usd; } catch { /* skip */ }
    }
    if (done.size > 0) console.log(`Resuming: ${done.size} trajectories already in progress log (spend so far $${spend.toFixed(3)})`);
  }

  const results: any[] = [...done.values()];
  let stopReason: string | null = null;

  outer:
  for (const task of tasks) {
    const repoDir = REPO_DIR_MAP[task.repo];
    const taskId = `${repoDir}-${task.pr_commit.slice(0, 8)}`;
    for (const variant of ["OFF", "ON"] as const) {
      const key = `${taskId}.${variant}`;
      if (done.has(key)) continue;
      if (spend >= SAFETY_STOP) { stopReason = `spend $${spend.toFixed(2)} >= safety stop`; break outer; }
      const r = runOne(task, variant);
      results.push(r); done.set(key, r); appendProgress(r);
      const tag = variant === "ON"
        ? `iso=${r.hook_isolation?.ok} junk=${(r.dep_junk_recalled ?? []).length} srcK=${r.expected_source_in_topk}`
        : "";
      console.log(`  ${variant} ${taskId}  pass=${r.pass} G+G=${r.glob + r.grep} Read=${r.read} tok=${r.tokens} ${r.wall_sec}s $${r.cost_usd?.toFixed(3)} ${tag} [spend $${spend.toFixed(3)}]`);
      if (variant === "ON" && r.hook_isolation && !r.hook_isolation.ok) {
        stopReason = `HOOK ISOLATION FAILED on ${taskId}: ${r.hook_isolation.events.join(",")}`; break outer;
      }
    }
  }

  // Pair OFF/ON by task_id.
  const byId: Record<string, { off?: any; on?: any }> = {};
  for (const r of results) (byId[r.task_id] ??= {})[r.variant.toLowerCase() as "off" | "on"] = r;
  const pairs = Object.entries(byId).filter(([, p]) => p.off && p.on).map(([id, p]) => ({ id, off: p.off!, on: p.on! }));

  // Paired-outcome cells (§A.1).
  const cell = (o: boolean, n: boolean) => pairs.filter((p) => p.off.pass === o && p.on.pass === n).length;
  const cells = {
    off_pass_on_pass: cell(true, true),
    off_pass_on_fail: cell(true, false),   // <- load-bearing: must be 0
    off_fail_on_pass: cell(false, true),   // <- ON wins
    off_fail_on_fail: cell(false, false),
  };
  const sum = (arr: any[], k: string) => arr.reduce((a, x) => a + (x[k] ?? 0), 0);
  const offGG = sum(pairs.map((p) => p.off), "glob") + sum(pairs.map((p) => p.off), "grep");
  const onGG = sum(pairs.map((p) => p.on), "glob") + sum(pairs.map((p) => p.on), "grep");
  const offTok = sum(pairs.map((p) => p.off), "tokens"), onTok = sum(pairs.map((p) => p.on), "tokens");
  const offDur = sum(pairs.map((p) => p.off), "wall_sec"), onDur = sum(pairs.map((p) => p.on), "wall_sec");

  // Per-repo breakdown.
  const repos = [...new Set(pairs.map((p) => p.off.repo))];
  const perRepo = Object.fromEntries(repos.map((repo) => {
    const ps = pairs.filter((p) => p.off.repo === repo);
    return [repo, {
      n: ps.length,
      off_pass: ps.filter((p) => p.off.pass).length, on_pass: ps.filter((p) => p.on.pass).length,
      off_gg: sum(ps.map((p) => p.off), "glob") + sum(ps.map((p) => p.off), "grep"),
      on_gg: sum(ps.map((p) => p.on), "glob") + sum(ps.map((p) => p.on), "grep"),
      src_in_topk: ps.filter((p) => p.on.expected_source_in_topk).length,
    }];
  }));

  const A1 = cells.off_pass_on_fail === 0;
  const A2 = offGG > 0 ? onGG <= offGG * 0.80 : false;
  const A3 = offTok > 0 ? onTok <= offTok * 1.05 : false;
  const A4 = offDur > 0 ? onDur <= offDur * 1.10 : false;
  const publishable = A1 && A2 && A3 && A4;
  const junkTotal = pairs.reduce((a, p) => a + (p.on.dep_junk_recalled?.length ?? 0), 0);
  const isoAllOk = pairs.every((p) => p.on.hook_isolation?.ok);

  const out = {
    phase: "N=25 file-memory real-repo pilot",
    pre_registration: "bench-runs/file-memory/PRE-REGISTRATION-REAL-REPOS.md",
    pairs_complete: pairs.length, total_selected: tasks.length, stop_reason: stopReason,
    paired_cells: cells,
    aggregate: {
      off_glob_grep: offGG, on_glob_grep: onGG,
      glob_grep_ratio: offGG ? Math.round((onGG / offGG) * 1000) / 1000 : null,
      off_tokens: offTok, on_tokens: onTok, tokens_ratio: offTok ? Math.round((onTok / offTok) * 1000) / 1000 : null,
      off_wall_sec: Math.round(offDur * 10) / 10, on_wall_sec: Math.round(onDur * 10) / 10,
      duration_ratio: offDur ? Math.round((onDur / offDur) * 1000) / 1000 : null,
      off_read: sum(pairs.map((p) => p.off), "read"), on_read: sum(pairs.map((p) => p.on), "read"),
      off_bytes_read: sum(pairs.map((p) => p.off), "bytes_read"), on_bytes_read: sum(pairs.map((p) => p.on), "bytes_read"),
      off_turns: sum(pairs.map((p) => p.off), "turns"), on_turns: sum(pairs.map((p) => p.on), "turns"),
      src_in_topk: pairs.filter((p) => p.on.expected_source_in_topk).length,
      hook_isolation_all_ok: isoAllOk, dep_junk_fp_total: junkTotal, powershell_on_total: sum(pairs.map((p) => p.on), "powershell"),
    },
    per_repo: perRepo,
    criteria: {
      "A1_zero_on_regression": A1, "A2_gg_cut_>=20pct": A2,
      "A3_tokens_<=+5pct": A3, "A4_duration_<=+10pct": A4, publishable,
    },
    cost_off: Math.round(sum(pairs.map((p) => p.off), "cost_usd") * 10000) / 10000,
    cost_on: Math.round(sum(pairs.map((p) => p.on), "cost_usd") * 10000) / 10000,
    total_spend_usd: Math.round(spend * 10000) / 10000,
    pairs,
  };
  writeFileSync(AGG, JSON.stringify(out, null, 2) + "\n");

  console.log(`\n=== N=25 PILOT SUMMARY ===`);
  console.log(`pairs ${pairs.length}/${tasks.length}  cells: PP=${cells.off_pass_on_pass} PF=${cells.off_pass_on_fail} FP=${cells.off_fail_on_pass} FF=${cells.off_fail_on_fail}`);
  console.log(`Glob+Grep ${offGG}->${onGG} (ratio ${out.aggregate.glob_grep_ratio}) | tokens ratio ${out.aggregate.tokens_ratio} | duration ratio ${out.aggregate.duration_ratio}`);
  console.log(`src-in-topK ${out.aggregate.src_in_topk}/${pairs.length} | iso_all_ok ${isoAllOk} | dep_junk_fp ${junkTotal} | PowerShell ${out.aggregate.powershell_on_total}`);
  console.log(`CRITERIA A1=${A1} A2=${A2} A3=${A3} A4=${A4} => ${publishable ? "PUBLISHABLE (§A)" : "NOT publishable (§B/§C)"}`);
  console.log(`SPEND $${spend.toFixed(4)} / $${TOTAL_CAP}  stop=${stopReason ?? "none"}`);
  console.log(`Wrote ${AGG}`);
}

main();
