#!/usr/bin/env tsx
/**
 * Crash-safe capture/recall runner around the committed safety envelope
 * (capture-run.ts). Phase A drives the runtime Stop-hook capture path; Phase B
 * runs recall against the captured BlockStore and lets the Stop-hook inference
 * attribute outcomes. All hooks target ONE shared `--path` store; the agent
 * works in a per-task workspace materialized from the repo at base SHA (no .git,
 * PR test file overlaid). Telemetry is the store itself; orchestration state is
 * a JSONL appended after every trajectory (resume-safe).
 *
 *   manifest → materialize → runTrajectory → (Stop capture | recall+inference)
 *            → read store by runId → TrajRecord → runState → JSONL → halt/health
 *
 * Rules (operator + pre-registration):
 *  - haiku only, hard cap $30 (HARD_CAP_USD); stop at cap.
 *  - resume: a task with a valid (non-empty) record is never re-run.
 *  - retry ONLY documented infra failures (empty: tok=0,cost=0,exit≠0); never a
 *    valid model outcome.
 *  - halt on: privacy regression | manifest leak | ≥3 pipeline failures |
 *    3 consecutive empties | hard cap | organic target.
 *  - early health checkpoint after 10 capture + 10 recall (auto-continue if healthy).
 *
 * Modes:
 *   --preflight   $0 self-check: manifest loads, store inits, halt logic fires.
 *   (default)     paid run over the frozen manifest.
 *
 * Env (WSL overrides): TB_MANIFEST, TB_SHARED_DIR, TB_REPOS, TB_WORKSPACES,
 *   TB_RESULTS, TB_RUN_TAG, TB_MAX_TRAJ_USD, TB_HARD_CAP_USD, CLAUDE_CLI.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync,
  symlinkSync, lstatSync, rmdirSync, openSync, fsyncSync, closeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { runTrajectory } from "../path-a-harness/run-trajectory.js";
import {
  runState, HARD_CAP_USD, ORGANIC_TARGET, HEALTH_CHECKPOINT,
  type TrajRecord,
} from "./capture-run.js";
import { initConfig, isInitialized } from "../../src/core/config.js";
import { BlockStore } from "../../src/core/block-store.js";
import { buildDogfoodManifest } from "../../src/eval/dogfood-manifest.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..", "..");
const REPO_TSX = join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
const BIN_CLI = join(ROOT, "bin", "cli.ts");
const toPosix = (p: string) => p.replace(/\\/g, "/");

const SHARED_DIR = process.env.TB_SHARED_DIR ?? join(process.env.HOME ?? ROOT, "reasoning-capture");
const REPOS = process.env.TB_REPOS ?? join(process.env.HOME ?? ROOT, "file-memory-real-repos", "repos");
const WS_DIR = process.env.TB_WORKSPACES ?? join(process.env.HOME ?? ROOT, "reasoning-capture", "workspaces");
const RESULTS = process.env.TB_RESULTS ?? join(ROOT, "bench-runs", "reasoning-reuse", "results");
const RUN_TAG = process.env.TB_RUN_TAG ?? "capture-run";
const MANIFEST_PATH = process.env.TB_MANIFEST ?? join(ROOT, "bench-runs", "reasoning-reuse", "capture-manifest.frozen.json");
const PROGRESS = join(RESULTS, `${RUN_TAG}-progress.jsonl`);
const AGG = join(RESULTS, `${RUN_TAG}-aggregate.json`);
const RETRY_AUDIT = join(RESULTS, `${RUN_TAG}-retry-audit.json`);
const MAX_TRAJ_USD = parseFloat(process.env.TB_MAX_TRAJ_USD ?? "0.50");
const CAP_USD = parseFloat(process.env.TB_HARD_CAP_USD ?? String(HARD_CAP_USD));
const MAX_INFRA_RETRIES = 2;
const MODEL = "claude-haiku-4-5";

const REPO_DIR_MAP: Record<string, string> = {
  "josdejong/mathjs": "josdejong-mathjs",
  "psf/black": "psf-black",
  "Textualize/rich": "Textualize-rich",
  "colinhacks/zod": "colinhacks-zod",
  "axios/axios": "axios-axios",
  "pytest-dev/pytest": "pytest-dev-pytest",
};

interface ManifestRow {
  taskId: string; repo: string; baseSHA: string; fixSHA: string;
  sourceFamily: string; expectedFailingTest: string;
  testFilesTouched: string[]; sourceFilesTouched: string[];
  verificationCommand: string; arm: "capture" | "recall";
  relatedFamilyIds: string[]; leakageExclusions: string[]; provenance: string;
}
interface FrozenManifest { frozenAt: number; manifestHash: string; model: string; tasks: ManifestRow[]; }

// ---- workspace materialization (git archive at base, overlay PR test, link deps)
function removeWorkspace(ws: string): void {
  if (!existsSync(ws)) return;
  if (process.platform === "win32") {
    for (const dep of ["node_modules", ".venv"]) {
      const p = join(ws, dep);
      try { if (existsSync(p) && lstatSync(p).isSymbolicLink()) rmdirSync(p); } catch { /* */ }
    }
  }
  rmSync(ws, { recursive: true, force: true, maxRetries: 6, retryDelay: 400 });
}

function materialize(task: ManifestRow): string {
  const clone = join(REPOS, REPO_DIR_MAP[task.repo]!);
  const ws = join(WS_DIR, task.taskId);
  removeWorkspace(ws);
  mkdirSync(ws, { recursive: true });
  // 1. parent working tree, NO .git (agent can't use history as an oracle).
  const arch = spawnSync("bash", ["-lc", `git -C '${toPosix(clone)}' archive ${task.baseSHA} | tar -x -C '${toPosix(ws)}'`], { encoding: "utf-8" });
  if (arch.status !== 0) throw new Error(`git archive ${task.baseSHA}: ${(arch.stderr || "").slice(0, 300)}`);
  // 2. overlay the PR's version of each touched test file (= apply test diff only).
  for (const tf of task.testFilesTouched) {
    const show = spawnSync("git", ["-C", clone, "show", `${task.fixSHA}:${tf}`], { encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 });
    if (show.status !== 0) throw new Error(`git show ${tf}: ${(show.stderr || "").slice(0, 200)}`);
    const dest = join(ws, tf);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, show.stdout);
  }
  // 3. link installed deps from the canonical clone.
  const linkType = process.platform === "win32" ? "junction" : "dir";
  for (const dep of ["node_modules", ".venv"]) {
    const src = join(clone, dep);
    if (existsSync(src)) { try { symlinkSync(src, join(ws, dep), linkType); } catch (e: any) { console.error(`  WARN link ${dep}: ${e.message}`); } }
  }
  return ws;
}

function writeHookConfig(ws: string, arm: "capture" | "recall"): void {
  mkdirSync(join(ws, ".claude"), { recursive: true });
  const cli = (cmd: string, extra: string) =>
    `'${toPosix(REPO_TSX)}' '${toPosix(BIN_CLI)}' ${cmd} --host claude-code ${extra} --path '${toPosix(SHARED_DIR)}'`;
  // Stop → capture-turn (Phase A: capture; Phase B: also runs attribution inference).
  const stop = { hooks: [{ type: "command", command: cli("capture-turn", "--capture compact"), timeout: 20, statusMessage: "TB capture" }] };
  const hooks: Record<string, unknown> = { Stop: [stop] };
  if (arm === "recall") {
    // UserPromptSubmit → inject-context (reasoning recall against the shared store).
    hooks.UserPromptSubmit = [{ hooks: [{ type: "command", command: cli("inject-context", "--status compact"), timeout: 30, statusMessage: "TB recall" }] }];
  }
  writeFileSync(join(ws, ".claude", "settings.json"), JSON.stringify({ hooks }, null, 2) + "\n");
}

function buildPrompt(task: ManifestRow, ws: string): string {
  const srcTop = task.sourceFilesTouched[0]?.split("/").slice(0, -1).join("/") || "the source";
  return [
    "Working directory (operate strictly inside):", toPosix(ws), "",
    `Task: a unit test is failing in [${task.expectedFailingTest}]. Find and fix the bug`,
    `(it is somewhere under [${srcTop}]). Context: ${task.sourceFamily} — "${task.expectedFailingTest}".`,
    "", "Rules:",
    "- Work only inside the working directory.",
    `- Run the test with exactly: ${task.verificationCommand}`,
    "- Do NOT install or update packages. Do NOT modify the test file. Keep the patch minimal.",
    "- When you have a fix, briefly state the root cause and what you changed, then run the test to confirm it passes.",
    "", "End your response with the literal text 'DONE'.",
  ].join("\n");
}

// ---- store inspection (sequential runs → snapshot deltas are race-free)
function withStore<T>(fn: (s: BlockStore) => T, readonly = true): T {
  const db = new Database(join(SHARED_DIR, ".tracebase", "memory.db"), readonly ? { readonly: true } : {});
  const store = new BlockStore(db, { skipMigrate: true });
  try { return fn(store); } finally { store.close(); }
}
const runtimeCapturedCount = (): number => withStore((s) => buildDogfoodManifest(s).summary.runtimeCaptured);

function recallOutcome(runId: string): { fired: boolean; injectedBlockId: string | null; attributedResolved: boolean } {
  return withStore((s) => {
    const ev = s.readEvents({ runId });
    const inj = ev.find((e) => e.event === "injection");
    const agentUsed = ev.some((e) => e.event === "agent_used");
    const resolved = ev.some((e) => e.event === "outcome" && (e as any).resolved === true);
    return { fired: !!inj, injectedBlockId: (inj as any)?.blockId ?? null, attributedResolved: agentUsed && resolved };
  });
}

function verify(task: ManifestRow, ws: string): { exit: number | null; pass: boolean } {
  const r = spawnSync("bash", ["-lc", `cd '${toPosix(ws)}' && timeout 180s ${task.verificationCommand}`], { encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 });
  return { exit: r.status, pass: r.status === 0 };
}

const num = (p: any, ...k: string[]): number | null => { for (const x of k) if (typeof p?.[x] === "number") return p[x]; return null; };
const totalTokens = (u: any): number => !u ? 0 : ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"].reduce((a, k) => a + (typeof u[k] === "number" ? u[k] : 0), 0);

function appendProgress(rec: any): void {
  mkdirSync(RESULTS, { recursive: true });
  appendFileSync(PROGRESS, JSON.stringify(rec) + "\n");
  try { const fd = openSync(PROGRESS, "r+"); fsyncSync(fd); closeSync(fd); } catch { /* */ }
}

function loadProgress(): any[] {
  if (!existsSync(PROGRESS)) return [];
  return readFileSync(PROGRESS, "utf-8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// ---------------------------------------------------------------------------
function preflight(): number {
  console.log("=== orchestrator $0 preflight ===");
  const checks: Array<[string, boolean]> = [];
  // manifest loads
  let mf: FrozenManifest | null = null;
  try { mf = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8")); } catch { /* */ }
  checks.push(["manifest loads + hashed", !!mf && typeof mf.manifestHash === "string" && Array.isArray(mf.tasks)]);
  checks.push(["manifest disjoint capture/recall refs", !!mf && (() => {
    const cap = new Set(mf!.tasks.filter((t) => t.arm === "capture").map((t) => `${t.repo}@${t.fixSHA}`));
    return mf!.tasks.filter((t) => t.arm === "recall").every((t) => !cap.has(`${t.repo}@${t.fixSHA}`));
  })()]);
  // store inits
  let storeOk = false;
  try { if (!isInitialized(SHARED_DIR)) initConfig(SHARED_DIR, { install: { agent: "claude-code", agents: ["claude-code"] } }); storeOk = isInitialized(SHARED_DIR); } catch { /* */ }
  checks.push(["shared store initializes", storeOk]);
  // halt logic fires (pure)
  const capHit = Array.from({ length: ORGANIC_TARGET.capturedRuntime }, (_, i) => ({ taskId: `c${i}`, phase: "capture", costUsd: 0, tokens: 1, exitCode: 0, blockId: "b", attributedResolved: false, empty: false } as TrajRecord));
  const recHit = Array.from({ length: ORGANIC_TARGET.precisionReady }, (_, i) => ({ taskId: `r${i}`, phase: "recall", costUsd: 0, tokens: 1, exitCode: 0, blockId: "b", attributedResolved: true, empty: false } as TrajRecord));
  checks.push(["halt: organic-target reachable", runState([...capHit, ...recHit], {}).halt === "organic-target"]);
  checks.push(["halt: hard-cap fires", runState([{ taskId: "x", phase: "capture", costUsd: CAP_USD, tokens: 1, exitCode: 0, blockId: null, attributedResolved: false, empty: false }], {}).halt === "hard-cap"]);
  checks.push(["halt: 3 consecutive empties", runState([{ taskId: "a", phase: "capture", costUsd: 0, tokens: 0, exitCode: 1, blockId: null, attributedResolved: false, empty: true }, { taskId: "b", phase: "capture", costUsd: 0, tokens: 0, exitCode: 1, blockId: null, attributedResolved: false, empty: true }, { taskId: "c", phase: "capture", costUsd: 0, tokens: 0, exitCode: 1, blockId: null, attributedResolved: false, empty: true }], {}).halt === "consecutive-empty"]);
  checks.push(["halt: privacy-regression", runState([], { privacyRegression: true }).halt === "privacy-regression"]);
  let pass = true;
  for (const [n, ok] of checks) { console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}`); if (!ok) pass = false; }
  console.log(`PREFLIGHT: ${pass ? "PASS" : "FAIL"} (${checks.filter((c) => c[1]).length}/${checks.length})`);
  return pass ? 0 : 1;
}

async function run(): Promise<void> {
  if (!existsSync(MANIFEST_PATH)) throw new Error(`no frozen manifest at ${MANIFEST_PATH}`);
  const mf: FrozenManifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
  if (!isInitialized(SHARED_DIR)) initConfig(SHARED_DIR, { install: { agent: "claude-code", agents: ["claude-code"] } });
  // Materialize + migrate the shared store file NOW so the read-only snapshot
  // reads (runtimeCapturedCount / recallOutcome) work before the first Stop-hook
  // write — initConfig only writes config.json, not memory.db (SQLITE_CANTOPEN).
  { const db = new Database(join(SHARED_DIR, ".tracebase", "memory.db")); new BlockStore(db); db.close(); }
  mkdirSync(WS_DIR, { recursive: true });
  process.env.TRACEBASE_SKIP_HOOK_SELF_HEAL = "1";

  // Order: 10 capture → 10 recall (so the committed 10+10 health checkpoint
  // fires: runState.healthDue needs captureDone===10 && recallDone===10) → the
  // remaining capture → the remaining recall. This honors the operator's
  // "first 10 capture + 10 recall" checkpoint while still running the bulk of
  // recall against the full captured corpus (recall needs captured blocks).
  const cap = mf.tasks.filter((t) => t.arm === "capture");
  const rec = mf.tasks.filter((t) => t.arm === "recall");
  const C = HEALTH_CHECKPOINT.capture, R = HEALTH_CHECKPOINT.recall;
  const ordered = [...cap.slice(0, C), ...rec.slice(0, R), ...cap.slice(C), ...rec.slice(R)];
  const prior = loadProgress();
  const done = new Map<string, any>(prior.filter((r) => !r.empty).map((r) => [r.taskId, r]));
  const records: TrajRecord[] = prior.filter((r) => !r.empty).map((r) => r.record);
  const retryAudit: any[] = prior.filter((r) => r.empty).map((r) => ({ taskId: r.taskId, reason: "infra-empty", attempt: r.attempt }));
  let pipelineFailures = prior.filter((r) => r.pipelineError).length;

  console.log(`=== capture-orchestrator [${RUN_TAG}] ===`);
  console.log(`manifest ${mf.manifestHash} · ${mf.tasks.length} tasks (${ordered.filter((t) => t.arm === "capture").length} cap / ${ordered.filter((t) => t.arm === "recall").length} rec) · cap $${CAP_USD}`);
  console.log(`resuming: ${done.size} completed, spend so far $${records.reduce((a, r) => a + r.costUsd, 0).toFixed(2)}`);

  for (const task of ordered) {
    if (done.has(task.taskId)) continue;
    const pre = runState(records, { pipelineFailures });
    if (pre.halt) { console.log(`HALT (${pre.halt}) before ${task.taskId}`); break; }
    if (pre.spendUsd + MAX_TRAJ_USD > CAP_USD) { console.log(`HALT (cap guard: $${pre.spendUsd.toFixed(2)} + $${MAX_TRAJ_USD} > $${CAP_USD})`); break; }

    let attempt = 0, rec: TrajRecord | null = null;
    while (attempt <= MAX_INFRA_RETRIES) {
      attempt++;
      const sessionId = randomUUID();
      let ws: string;
      try { ws = materialize(task); } catch (e: any) {
        pipelineFailures++; appendProgress({ taskId: task.taskId, pipelineError: e.message, attempt });
        console.log(`  PIPELINE-FAIL materialize ${task.taskId}: ${e.message}`); break;
      }
      writeHookConfig(ws, task.arm);
      const capturedBefore = task.arm === "capture" ? runtimeCapturedCount() : 0;
      const t0 = Date.now();
      const traj = runTrajectory({ workspace: ws, prompt: buildPrompt(task, ws), sessionId, model: MODEL, maxBudgetUsd: MAX_TRAJ_USD, allowedTools: "Read,Edit,Bash,Grep,Glob", timeoutMs: 600_000 });
      const cost = num(traj.parsed, "total_cost_usd") ?? 0;
      const tokens = totalTokens((traj.parsed as any)?.usage);
      const empty = tokens === 0 && cost === 0 && traj.exitCode !== 0;
      if (empty && attempt <= MAX_INFRA_RETRIES) {
        retryAudit.push({ taskId: task.taskId, reason: "infra-empty", attempt, exit: traj.exitCode, stderr: traj.stderr.slice(-200) });
        appendProgress({ taskId: task.taskId, empty: true, attempt });
        console.log(`  RETRY ${task.taskId} (infra-empty exit=${traj.exitCode}, attempt ${attempt})`);
        removeWorkspace(ws); continue;
      }
      const v = verify(task, ws);
      let blockId: string | null = null, attributedResolved = false, fired = false;
      if (task.arm === "capture") {
        blockId = runtimeCapturedCount() > capturedBefore ? `cap:${sessionId}` : null;
      } else {
        const o = recallOutcome(sessionId);
        fired = o.fired; blockId = o.injectedBlockId; attributedResolved = o.attributedResolved && v.pass;
      }
      rec = { taskId: task.taskId, phase: task.arm, costUsd: cost, tokens, exitCode: traj.exitCode ?? -1, blockId, attributedResolved, empty: false };
      appendProgress({ taskId: task.taskId, attempt, record: rec, verifyPass: v.pass, fired, sessionId, wallSec: Math.round((Date.now() - t0) / 100) / 10 });
      console.log(`  ${task.arm.toUpperCase()} ${task.taskId}: cost=$${cost.toFixed(3)} verify=${v.pass ? "PASS" : "fail"} ${task.arm === "capture" ? `captured=${!!blockId}` : `fired=${fired} attributed=${attributedResolved}`}`);
      removeWorkspace(ws);
      break;
    }
    if (!rec) { continue; } // pipeline-fail or exhausted retries
    records.push(rec);

    // privacy / leakage audit on the shared store after each trajectory.
    const leak = withStore((s) => buildDogfoodManifest(s).entries.some((e: any) => e.leakClean === false));
    const st = runState(records, { pipelineFailures, privacyRegression: leak });
    if (st.healthDue) {
      const totalCap = cap.length, totalRec = rec.length;
      const capDone = records.filter((r) => r.phase === "capture" && !r.empty).length;
      const recDone = records.filter((r) => r.phase === "recall" && !r.empty).length;
      const capYield = capDone ? st.organic.capturedRuntime / capDone : 0;
      const prYield = recDone ? st.organic.precisionReady / recDone : 0;
      const projCap = Math.round(capYield * totalCap);
      const projPR = Math.round(prYield * totalRec);
      const s = withStore((x) => buildDogfoodManifest(x).summary);
      console.log(`\n=== HEALTH CHECKPOINT (10 capture + 10 recall) ===`);
      console.log(`  spend=$${st.spendUsd.toFixed(2)} / cap $${CAP_USD}`);
      console.log(`  capture: ${st.organic.capturedRuntime}/${capDone} captured (yield ${(capYield * 100).toFixed(0)}%) → projected ${projCap}/${totalCap} vs target 50`);
      console.log(`  recall:  ${st.organic.precisionReady}/${recDone} precision-ready (yield ${(prYield * 100).toFixed(0)}%) → projected ${projPR}/${totalRec} vs target 30 [thin ${st.organic.capturedRuntime}-block corpus — conservative]`);
      console.log(`  store: ${JSON.stringify(s)}`);
      console.log(`  safety: leak=${leak} consecEmpty=${st.consecutiveEmpty} pipelineFailures=${pipelineFailures}`);
      const safetyGreen = !leak && st.consecutiveEmpty < 3 && pipelineFailures < 3 && st.spendUsd < CAP_USD;
      const checkpoint = { capturedAtCheckpoint: st.organic.capturedRuntime, capDone, capYield, projCap, precisionReadyAtCheckpoint: st.organic.precisionReady, recDone, prYield, projPR, safetyGreen, store: s };
      writeFileSync(join(RESULTS, `${RUN_TAG}-checkpoint.json`), JSON.stringify(checkpoint, null, 2) + "\n");
      // Operator protocol: stop at the checkpoint for a credible-path judgment;
      // continue only on explicit re-dispatch (TB_CHECKPOINT_ONLY unset).
      if (process.env.TB_CHECKPOINT_ONLY) {
        console.log(`  CHECKPOINT-ONLY mode → stopping for credible-path review.\n`);
        writeFinal(mf, records, retryAudit, "checkpoint-batch-complete");
        return;
      }
      if (!safetyGreen) { console.log(`  verdict: SAFETY NOT GREEN — halting\n`); writeFinal(mf, records, retryAudit, "health-unhealthy"); return; }
      console.log(`  verdict: safety green — continuing\n`);
    }
    if (st.halt) { console.log(`\nHALT: ${st.halt}`); writeFinal(mf, records, retryAudit, st.halt); return; }
  }
  writeFinal(mf, records, retryAudit, "manifest-exhausted");
}

function writeFinal(mf: FrozenManifest, records: TrajRecord[], retryAudit: any[], stopReason: string): void {
  mkdirSync(RESULTS, { recursive: true });
  const st = runState(records, {});
  const summary = withStore((s) => buildDogfoodManifest(s).summary);
  const agg = {
    runTag: RUN_TAG, manifestHash: mf.manifestHash, stopReason,
    completed: records.length,
    captureTrajectories: records.filter((r) => r.phase === "capture").length,
    recallTrajectories: records.filter((r) => r.phase === "recall").length,
    retried: retryAudit.length, spendUsd: Number(st.spendUsd.toFixed(4)),
    organic: st.organic, dogfoodSummary: summary,
    targetMet: st.organic.capturedRuntime >= ORGANIC_TARGET.capturedRuntime && st.organic.precisionReady >= ORGANIC_TARGET.precisionReady,
  };
  writeFileSync(AGG, JSON.stringify(agg, null, 2) + "\n");
  writeFileSync(RETRY_AUDIT, JSON.stringify({ retries: retryAudit }, null, 2) + "\n");
  console.log(`\n=== FINAL (${stopReason}) ===\n${JSON.stringify(agg, null, 2)}\nWrote ${AGG}`);
}

async function main() {
  if (process.argv.includes("--preflight")) { process.exit(preflight()); }
  await run();
}
main().catch((e) => { console.error(e); process.exit(1); });
