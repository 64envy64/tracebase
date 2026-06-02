#!/usr/bin/env tsx
/**
 * Box-6 paid mini-pilot (NOT N=25). 8 tasks, fixed distribution, chosen by
 * OFFLINE recall-hit (so this tests whether CORRECT file_memory helps agents,
 * not whether known-miss retrieval fails). Runs cross-platform; for this round
 * it runs under WSL (claude + all repo deps live there).
 *
 * Per task: OFF (no .tracebase) then ON (indexed_files + symbols +
 * UserPromptSubmit→inject-context only). Asserts hook isolation on every ON
 * run; STOPS immediately if isolation fails or ON pass-rate drops vs OFF.
 * TRACEBASE_SKIP_HOOK_SELF_HEAL=1 keeps ON file_memory-only.
 *
 * Paths are env-configurable (see smoke.ts): TB_FM_REPOS (clones w/ deps),
 * TB_FM_WORKSPACES (WSL FS), TB_FM_BENCH (manifests on /mnt/c), TB_FM_RESULTS.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { runTrajectory } from "../path-a-harness/run-trajectory.js";
import {
  REPO_DIR_MAP, RESULTS, REPOS, BENCH,
  materializeWorkspace, buildPrompt, parseTranscript, extractRecalledFiles,
  verifyPass, num, totalTokens,
} from "./smoke.js";

process.env.TRACEBASE_SKIP_HOOK_SELF_HEAL = "1";

const PRIOR_SPEND = 0.012;          // WSL auth probe already charged
const TOTAL_CAP = 8.0;
const SAFETY_STOP = 7.6;            // never start a run past here
const PER_TRAJ_CAP = 0.45;
const TIMEOUT_MS = 480_000;
const K = 5;
const DIST: Record<string, number> = { "josdejong/mathjs": 2, "Textualize/rich": 2, "colinhacks/zod": 3, "psf/black": 1 };

let spend = PRIOR_SPEND;

function checkHookIsolation(ws: string): { ok: boolean; events: string[] } {
  try {
    const sj = JSON.parse(readFileSync(join(ws, ".claude", "settings.json"), "utf-8"));
    const events = Object.keys(sj.hooks ?? {});
    return { ok: events.length === 1 && events[0] === "UserPromptSubmit", events };
  } catch (e: any) {
    return { ok: false, events: [`read-failed: ${e.message}`] };
  }
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
  return {
    task_id: taskId, repo: task.repo, variant,
    pass: verify.exit === 0, test_exit: verify.exit,
    glob: tm.toolCounts["Glob"] ?? 0, grep: tm.toolCounts["Grep"] ?? 0,
    read: tm.toolCounts["Read"] ?? 0, edit: tm.toolCounts["Edit"] ?? 0, bash: tm.toolCounts["Bash"] ?? 0,
    powershell: tm.toolCounts["PowerShell"] ?? 0, tool_counts: tm.toolCounts, bytes_read: tm.bytesRead,
    tokens: totalTokens((traj.parsed as any)?.usage), wall_sec: wallSec,
    cost_usd: cost, turns: num(traj.parsed as any, "num_turns"),
    terminal_reason: (traj.parsed as any)?.subtype ?? null,
    recalled_files: recalled,
    expected_source_in_topk: variant === "ON" ? (recalled ?? []).some((p) => srcSet.has(p)) : null,
    hook_isolation: variant === "ON" ? checkHookIsolation(ws) : null,
    exit_code: traj.exitCode, workspace: ws,
  };
}

function main() {
  mkdirSync(RESULTS, { recursive: true });
  const sel = JSON.parse(readFileSync(join(BENCH, "selected-tasks.json"), "utf-8"));
  const tasks: any[] = sel.tasks;

  // Offline recall-hit set (the gate for "this task tests correct memory").
  const offlinePath = join(RESULTS, "offline-recall-final-symbols.json");
  const offline = JSON.parse(readFileSync(offlinePath, "utf-8"));
  const hit = new Set<string>(
    offline.evals.filter((e: any) => e.source_rank != null && e.source_rank <= K).map((e: any) => e.task_id),
  );
  const tid = (t: any) => `${REPO_DIR_MAP[t.repo]}-${t.pr_commit.slice(0, 8)}`;

  // Earliest selected tasks per repo that are offline-hits, up to DIST.
  const picked: any[] = [];
  const perRepoCount: Record<string, number> = {};
  for (const t of tasks) {
    const need = DIST[t.repo] ?? 0;
    if ((perRepoCount[t.repo] ?? 0) >= need) continue;
    if (!hit.has(tid(t))) continue;
    picked.push(t);
    perRepoCount[t.repo] = (perRepoCount[t.repo] ?? 0) + 1;
  }
  console.log(`Selected ${picked.length} tasks (offline-hit, distribution ${JSON.stringify(DIST)}):`);
  for (const t of picked) console.log(`  ${tid(t)}  (${t.repo})`);
  console.log("");

  const pairs: any[] = [];
  let stopReason: string | null = null;
  for (const task of picked) {
    if (spend >= SAFETY_STOP) { stopReason = `spend $${spend.toFixed(2)} >= safety stop`; break; }
    const off = runOne(task, "OFF");
    console.log(`  OFF ${off.task_id}  pass=${off.pass} G+G=${off.glob + off.grep} Read=${off.read} tok=${off.tokens} ${off.wall_sec}s $${off.cost_usd?.toFixed(3)} [spend $${spend.toFixed(3)}]`);
    if (spend >= SAFETY_STOP) { stopReason = `spend $${spend.toFixed(2)} >= safety stop (after OFF)`; pairs.push({ off, on: null }); break; }
    const on = runOne(task, "ON");
    console.log(`  ON  ${on.task_id}  pass=${on.pass} G+G=${on.glob + on.grep} Read=${on.read} tok=${on.tokens} ${on.wall_sec}s $${on.cost_usd?.toFixed(3)} iso=${on.hook_isolation?.ok} srcInTopK=${on.expected_source_in_topk} recalled=${JSON.stringify(on.recalled_files)} [spend $${spend.toFixed(3)}]`);
    pairs.push({ off, on });
    if (on.hook_isolation && !on.hook_isolation.ok) { stopReason = `HOOK ISOLATION FAILED on ${on.task_id}: ${on.hook_isolation.events.join(",")}`; break; }
    if (off.pass && !on.pass) { stopReason = `ON pass-rate DROP on ${on.task_id} (OFF pass, ON fail)`; break; }
  }

  const complete = pairs.filter((p) => p.on);
  const sum = (k: string, v: "off" | "on") => complete.reduce((a, p) => a + (p[v]?.[k] ?? 0), 0);
  const aggregate = {
    pairs_complete: complete.length,
    off_pass: complete.filter((p) => p.off.pass).length,
    on_pass: complete.filter((p) => p.on.pass).length,
    off_glob_grep: sum("glob", "off") + sum("grep", "off"),
    on_glob_grep: sum("glob", "on") + sum("grep", "on"),
    off_read: sum("read", "off"), on_read: sum("read", "on"),
    off_bytes_read: sum("bytes_read", "off"), on_bytes_read: sum("bytes_read", "on"),
    off_tokens: sum("tokens", "off"), on_tokens: sum("tokens", "on"),
    off_wall_sec: Math.round(sum("wall_sec", "off") * 10) / 10, on_wall_sec: Math.round(sum("wall_sec", "on") * 10) / 10,
    off_cost: Math.round(sum("cost_usd", "off") * 10000) / 10000, on_cost: Math.round(sum("cost_usd", "on") * 10000) / 10000,
    off_turns: sum("turns", "off"), on_turns: sum("turns", "on"),
    on_expected_source_in_topk: complete.filter((p) => p.on.expected_source_in_topk).length,
    on_hook_isolation_all_ok: complete.every((p) => p.on.hook_isolation?.ok),
    on_powershell_total: sum("powershell", "on"),
  };
  const out = {
    phase: "box-6 paid mini-pilot (8 tasks, WSL, symbol-recall harness)",
    distribution: DIST, selected: picked.map(tid), stop_reason: stopReason,
    pairs, aggregate, total_spend_usd: Math.round(spend * 10000) / 10000,
  };
  writeFileSync(join(RESULTS, "box-6-mini-pilot-wsl.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(`\n=== SUMMARY ===`);
  console.log(`pairs: ${complete.length}  OFF pass ${aggregate.off_pass}/${complete.length}  ON pass ${aggregate.on_pass}/${complete.length}  iso_all_ok=${aggregate.on_hook_isolation_all_ok}`);
  console.log(`Glob+Grep OFF ${aggregate.off_glob_grep} -> ON ${aggregate.on_glob_grep} | Read OFF ${aggregate.off_read} -> ON ${aggregate.on_read} | tokens OFF ${aggregate.off_tokens} -> ON ${aggregate.on_tokens}`);
  console.log(`src-in-topK (ON): ${aggregate.on_expected_source_in_topk}/${complete.length} | PowerShell(ON): ${aggregate.on_powershell_total} | stop=${stopReason ?? "none"}`);
  console.log(`TOTAL SPEND: $${spend.toFixed(4)} / $${TOTAL_CAP}`);
  console.log(`Wrote ${join(RESULTS, "box-6-mini-pilot-wsl.json")}`);
}

main();
