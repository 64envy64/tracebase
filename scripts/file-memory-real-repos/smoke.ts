#!/usr/bin/env tsx
/**
 * Box 6 smoke — file-memory real-repos harness end-to-end on ONE task.
 *
 * Runs ONE variant (OFF or ON) per invocation so cost is observable
 * between arms (operator budget cap). Materializes a workspace from the
 * repo at the task's parent_commit (via `git archive` — NO .git, so the
 * agent cannot use git history as an oracle), overlays the PR's test
 * file (= "apply test diff only"), junctions node_modules from the
 * canonical clone, then:
 *   - OFF: bare workspace, no .tracebase, no hooks.
 *   - ON:  initConfig + indexWorkspace (indexed_files only) +
 *          .claude/settings.json with ONLY UserPromptSubmit→inject-context.
 * Spawns one child `claude --print` trajectory, verifies the repo test
 * command post-trajectory, extracts tool counts + bytes_read from the
 * transcript, and writes a per-variant result JSON.
 *
 * Usage: tsx scripts/file-memory-real-repos/smoke.ts <OFF|ON> [--budget 0.50]
 *
 * NO retries, NO multi-turn, NO workspace reuse across runs.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync, lstatSync, mkdirSync, readFileSync, rmdirSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { initConfig } from "../../src/core/config.js";
import { BlockStore } from "../../src/core/block-store.js";
import { indexWorkspace, recallFiles } from "../../src/core/file-indexer.js";
import { runTrajectory } from "../path-a-harness/run-trajectory.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..", "..");
const BENCH = join(ROOT, "bench-runs", "file-memory-real-repos");
const REPOS = join(BENCH, "repos");
const WS_DIR = join(BENCH, "workspaces");
export const RESULTS = join(BENCH, "results");
const REPO_TSX = join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
const BIN_CLI = join(ROOT, "bin", "cli.ts");

export const REPO_DIR_MAP: Record<string, string> = {
  "josdejong/mathjs": "josdejong-mathjs",
  "psf/black": "psf-black",
  "Textualize/rich": "Textualize-rich",
  "colinhacks/zod": "colinhacks-zod",
};

// Per-repo: how the agent (and the verifier) runs the scoped test.
function repoTestCommand(repo: string, testFile: string): string {
  if (repo === "josdejong/mathjs") return `npx mocha ${testFile}`;
  if (repo === "psf/black" || repo === "Textualize/rich") return `.venv/bin/python -m pytest -q ${testFile}`;
  if (repo === "colinhacks/zod") return `pnpm test -- ${testFile}`;
  throw new Error(`no test command for ${repo}`);
}

// Source root hint for the prompt (KNOWN_SOURCE_DIR).
function knownSourceDir(sourceFiles: string[]): string {
  // Common top-level dir of all source files (e.g. "src/").
  const tops = new Set(sourceFiles.map((f) => f.split("/")[0]));
  return tops.size === 1 ? `${[...tops][0]}/` : sourceFiles[0].split("/").slice(0, 1)[0] + "/";
}

const toPosix = (p: string) => p.replace(/\\/g, "/");

// Generic words that carry no retrieval signal as a feature name.
const GENERIC_FEATURE_WORDS = new Set([
  "index", "main", "test", "tests", "spec", "util", "utils", "helper", "helpers",
  "common", "core", "lib", "src", "mod", "init", "base", "types", "type",
]);

/**
 * Task#3 — build a focused file_memory retrieval query from the task's
 * FIELDS, not the boilerplate agent prompt. Evidence (box-6 probes) shows
 * the single strongest, most reliable signal is the FEATURE NAME taken
 * from the failing test file's basename: a query of just "derivative"
 * recalls src/function/algebra/derivative.js in the top-K, whereas adding
 * the symptom vocabulary from the bug description ("special characters",
 * "SymbolNode") DEGRADES recall — those terms match symptom files
 * (parser / SymbolNode), not the fix location. So we derive the query
 * from the test basename(s), split camelCase / snake_case into words, and
 * drop generic tokens. This is the honest "concise retrievalQuery from
 * test path" the spec calls for; symptom nouns are intentionally excluded
 * because they hurt (documented finding, not an oversight).
 */
export function buildRetrievalQuery(task: any): string {
  const feats: string[] = [];
  for (const tf of task.test_files_touched as string[]) {
    const base = (tf.split("/").pop() ?? tf)
      .replace(/\.(test|spec)\.[a-z0-9]+$/i, "")
      .replace(/\.[a-z0-9]+$/i, "");
    for (const w of base.split(/[._\-]|(?=[A-Z])/)) {
      const lw = w.toLowerCase();
      if (lw.length > 2 && !GENERIC_FEATURE_WORDS.has(lw)) feats.push(lw);
    }
  }
  const seen = new Set<string>();
  const uniq = feats.filter((w) => (seen.has(w) ? false : (seen.add(w), true)));
  // Fallback: if the test basename was entirely generic, fall back to the
  // source file basenames so the query is never empty.
  if (uniq.length === 0) {
    for (const sf of task.source_files_touched as string[]) {
      const b = (sf.split("/").pop() ?? sf).replace(/\.[a-z0-9]+$/i, "").toLowerCase();
      if (b.length > 2 && !GENERIC_FEATURE_WORDS.has(b)) uniq.push(b);
    }
  }
  return uniq.join(" ");
}

// Junction-aware workspace removal. On Windows, node_modules is a directory
// junction to the canonical clone — it must be unlinked via rmdirSync (which
// removes the link, NOT the target) before a recursive rm, or rmSync can choke
// (EBUSY) and in the worst case follow the link. Retries handle a transient
// lock from a just-exited inject-context hook holding .tracebase/memory.db.
function removeWorkspace(ws: string): void {
  if (!existsSync(ws)) return;
  const nm = join(ws, "node_modules");
  if (existsSync(nm)) {
    try { if (lstatSync(nm).isSymbolicLink()) rmdirSync(nm); } catch { /* fall through */ }
  }
  rmSync(ws, { recursive: true, force: true, maxRetries: 6, retryDelay: 500 });
}

const RETRIEVAL_HOOK = join(SCRIPT_DIR, "retrieval-hook.mjs");

function writeMinimalHookConfig(workspace: string): void {
  mkdirSync(join(workspace, ".claude"), { recursive: true });
  // ON-arm hook = the field-derived-query wrapper around the REAL shipped
  // inject-context. The wrapper substitutes only the recall QUERY (the
  // pre-registered failing-test feature name from .tracebase/retrieval-
  // query.txt); recallFiles still does all the work. Not an oracle: no
  // source filename is hardcoded; missing query-file → original prompt.
  const cmd =
    `node ${toPosix(RETRIEVAL_HOOK)} ` +
    `--path ${toPosix(workspace)} --tsx ${toPosix(REPO_TSX)} --cli ${toPosix(BIN_CLI)}`;
  writeFileSync(
    join(workspace, ".claude", "settings.json"),
    JSON.stringify(
      {
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: "command", command: cmd, timeout: 30, statusMessage: "TB FILE memory" }] },
          ],
        },
      },
      null, 2,
    ) + "\n",
  );
}

export function materializeWorkspace(
  task: any, variant: "OFF" | "ON",
): { ws: string; indexer: any | null } {
  const repoDir = REPO_DIR_MAP[task.repo];
  const clone = join(REPOS, repoDir);
  const taskId = `${repoDir}-${task.pr_commit.slice(0, 8)}`;
  const ws = join(WS_DIR, `${taskId}.${variant}`);

  removeWorkspace(ws);
  mkdirSync(ws, { recursive: true });

  // 1. Materialize parent-state working tree (NO .git) via git archive | tar.
  const archive = spawnSync(
    "bash", ["-lc", `git -C '${toPosix(clone)}' archive ${task.parent_commit} | tar -x -C '${toPosix(ws)}'`],
    { encoding: "utf-8", shell: false },
  );
  if (archive.status !== 0) {
    throw new Error(`git archive failed: ${archive.stderr?.slice(0, 400)}`);
  }

  // 2. Overlay the PR's version of each test file (= apply test diff only).
  for (const tf of task.test_files_touched) {
    const show = spawnSync(
      "git", ["-C", clone, "show", `${task.pr_commit}:${tf}`],
      { encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 },
    );
    if (show.status !== 0) throw new Error(`git show ${tf} failed: ${show.stderr?.slice(0, 300)}`);
    const dest = join(ws, tf);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, show.stdout);
  }

  // 3. Junction node_modules from the canonical clone (avoid huge copy).
  const cloneNM = join(clone, "node_modules");
  if (existsSync(cloneNM)) {
    try { symlinkSync(cloneNM, join(ws, "node_modules"), "junction"); }
    catch (e: any) { console.error(`  WARN node_modules junction failed: ${e.message}`); }
  }

  // 4. ON-only: .tracebase (indexed_files) + minimal hook.
  let indexer: any = null;
  if (variant === "ON") {
    const cfg = initConfig(ws, { install: { agent: "claude-code", agents: ["claude-code"] } });
    const db = new Database(cfg.storagePath);
    const store = new BlockStore(db);
    try {
      // No budget override → walker DEFAULT_BUDGET (maxFiles 5000,
      // maxBytesScan 64 MiB, timeMs 30s) — exactly what the shipped
      // `tracebase init` path uses when fileMemory.initBudget is
      // unconfigured (src/cli/commands/init.ts:418-422). The earlier
      // {maxFiles:256, maxDirs:64, maxBytes:1MB} was copied from the
      // synthetic bench-02 and did NOT match shipped: maxDirs is ignored
      // by the walker, maxBytes is the wrong key (walker reads
      // maxBytesScan), so the only effective cap was maxFiles:256 — which
      // BFS exhausted on root/docs/examples/test before ever descending
      // into src/function/, leaving the bug's own source file unindexed.
      indexer = indexWorkspace(store, { root: ws });
      // Confirm reasoning_blocks + session_chunks are empty (no contamination).
      const rb = db.prepare("SELECT COUNT(*) n FROM reasoning_blocks").get() as { n: number };
      const sc = (() => {
        try { return (db.prepare("SELECT COUNT(*) n FROM session_chunks").get() as { n: number }).n; }
        catch { return 0; }
      })();
      const idx = db.prepare("SELECT COUNT(*) n FROM indexed_files").get() as { n: number };
      indexer = {
        indexedCount: indexer.indexedCount,
        bytesSummarized: indexer.bytesSummarized,
        skipped: indexer.skipped,
        indexed_files_rows: idx.n,
        reasoning_blocks_rows: rb.n,
        session_chunks_rows: sc,
      };
    } finally { store.close(); }
    // Write the field-derived retrieval query the ON hook wrapper will feed
    // to inject-context (Task#3). Derived from task fields only — never the
    // expected source filename.
    writeFileSync(join(ws, ".tracebase", "retrieval-query.txt"), buildRetrievalQuery(task) + "\n");
    writeMinimalHookConfig(ws);
  }

  return { ws, indexer };
}

export function buildPrompt(task: any, ws: string): string {
  // Amendment 2 (query hygiene): the repo README/CLAUDE.md prefix was REMOVED
  // from the prompt for BOTH arms. inject-context uses the full prompt text as
  // the file_memory FTS query; the README prefix biased recall toward
  // docs/README/package.json instead of the bug's source files. A bug-fix task
  // does not need the README, and removing it keeps OFF/ON symmetric (the only
  // remaining difference is the inject-context mechanism itself).
  const testPath = task.test_files_touched[0];
  const srcDir = knownSourceDir(task.source_files_touched);
  const testCmd = repoTestCommand(task.repo, testPath);
  const bug = task.title;
  return [
    "Working directory (operate strictly inside):",
    toPosix(ws),
    "",
    `Task: Fix the failing test in [${testPath}]. The bug is in [${srcDir}] (per the bug`,
    `report). [${bug}]`,
    "",
    "Rules:",
    "- Work inside the working directory.",
    `- Run tests with: [${testCmd}]`,
    "- Do NOT install or update packages.",
    "- Do NOT modify the test file.",
    "- Keep your patch minimal.",
    "",
    "End your response with the literal text 'DONE'.",
  ].join("\n");
}

interface TranscriptMetrics {
  toolCounts: Record<string, number>;
  bytesRead: number;
  readCount: number;
}

export function parseTranscript(transcriptPath: string | null): TranscriptMetrics {
  const m: TranscriptMetrics = { toolCounts: {}, bytesRead: 0, readCount: 0 };
  if (!transcriptPath || !existsSync(transcriptPath)) return m;
  const idToName = new Map<string, string>();
  for (const line of readFileSync(transcriptPath, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    let row: any;
    try { row = JSON.parse(line); } catch { continue; }
    if (row?.message?.role === "assistant" && Array.isArray(row.message.content)) {
      for (const c of row.message.content) {
        if (c?.type === "tool_use" && typeof c.name === "string") {
          m.toolCounts[c.name] = (m.toolCounts[c.name] ?? 0) + 1;
          if (typeof c.id === "string") idToName.set(c.id, c.name);
        }
      }
    }
    if (row?.message?.role === "user" && Array.isArray(row.message.content)) {
      for (const c of row.message.content) {
        if (c?.type === "tool_result" && typeof c.tool_use_id === "string") {
          const name = idToName.get(c.tool_use_id);
          if (name === "Read") {
            const text = typeof c.content === "string" ? c.content : JSON.stringify(c.content ?? "");
            m.bytesRead += Buffer.byteLength(text, "utf-8");
            m.readCount += 1;
          }
        }
      }
    }
  }
  return m;
}

// Extract the file paths file_memory recalled from the injected <file_memory>
// block in the transcript. Lines look like: "• src/foo.js: src/foo.js (lang)...".
export function extractRecalledFiles(transcriptPath: string | null): string[] {
  if (!transcriptPath || !existsSync(transcriptPath)) return [];
  const text = readFileSync(transcriptPath, "utf-8");
  const files: string[] = [];
  const seen = new Set<string>();
  // The block may be JSON-escaped (\n) inside a transcript row, so scan globally.
  const blockMatch = text.match(/<file_memory>([\s\S]*?)<\/file_memory>/);
  const block = blockMatch ? blockMatch[1] : "";
  // Bullets use "•" then "<path>:"; tolerate \n escaping.
  for (const m of block.matchAll(/•\s*([^:\n\\]+?):/g)) {
    const p = m[1].trim();
    if (p && !seen.has(p)) { seen.add(p); files.push(p); }
  }
  return files;
}

export function verifyPass(task: any, ws: string): { exit: number | null; elapsedSec: number; tail: string } {
  const testCmd = repoTestCommand(task.repo, task.test_files_touched[0]);
  const t0 = Date.now();
  const r = spawnSync("bash", ["-lc", `cd '${toPosix(ws)}' && timeout 180s ${testCmd}`], {
    encoding: "utf-8", maxBuffer: 32 * 1024 * 1024,
  });
  return {
    exit: r.status,
    elapsedSec: Math.round((Date.now() - t0) / 100) / 10,
    tail: ((r.stdout ?? "") + (r.stderr ?? "")).split("\n").slice(-8).join("\n"),
  };
}

export function num(parsed: any, ...keys: string[]): number | null {
  for (const k of keys) if (typeof parsed?.[k] === "number") return parsed[k];
  return null;
}

export function totalTokens(usage: any): number | null {
  if (!usage || typeof usage !== "object") return null;
  const f = (k: string) => (typeof usage[k] === "number" ? usage[k] : 0);
  return f("input_tokens") + f("output_tokens") + f("cache_creation_input_tokens") + f("cache_read_input_tokens");
}

// ---------------------------------------------------------------------------
async function main() {
  const variant = (process.argv[2] || "").toUpperCase() as "OFF" | "ON";
  if (variant !== "OFF" && variant !== "ON") {
    console.error("usage: smoke.ts <OFF|ON> [--budget 0.50]");
    process.exit(2);
  }
  const budgetIdx = process.argv.indexOf("--budget");
  const budget = budgetIdx >= 0 ? parseFloat(process.argv[budgetIdx + 1]) : 0.5;
  const dry = process.argv.includes("--dry");
  const probe = process.argv.includes("--probe");

  mkdirSync(RESULTS, { recursive: true });
  const sel = JSON.parse(readFileSync(join(BENCH, "selected-tasks.json"), "utf-8"));
  const task = sel.tasks[0];
  const repoDir = REPO_DIR_MAP[task.repo];
  const taskId = `${repoDir}-${task.pr_commit.slice(0, 8)}`;

  console.log(`=== smoke ${variant} — ${task.repo} ${task.pr_commit.slice(0, 8)} ===`);
  console.log(`task: ${task.title}`);

  const { ws, indexer } = materializeWorkspace(task, variant);
  console.log(`workspace: ${ws}`);
  if (indexer) console.log(`indexer: indexed=${indexer.indexedCount} files, bytes=${indexer.bytesSummarized}, indexed_files_rows=${indexer.indexed_files_rows}, reasoning_blocks=${indexer.reasoning_blocks_rows}, session_chunks=${indexer.session_chunks_rows}, skipped=${JSON.stringify(indexer.skipped)}`);

  if (probe) {
    // Task#4 — FREE recall probe ($0, no child claude). Asserts the
    // retrieval improvement actually surfaces the bug's source files for a
    // field-derived natural query, and never a README/doc.
    if (variant !== "ON") { console.error("probe requires ON"); process.exit(2); }
    const query = buildRetrievalQuery(task);
    const db = new Database(join(ws, ".tracebase", "memory.db"), { readonly: true });
    const store = new BlockStore(db);
    const hits = recallFiles(store, { prompt: query, k: 5 });
    db.close();
    const recalled = hits.map((h) => h.relPath);
    const sourceSet = new Set(task.source_files_touched as string[]);
    const sourceRecalled = recalled.filter((p) => sourceSet.has(p));
    const isDoc = (p: string) =>
      /\.(md|mdx|markdown|rst|adoc|txt)$/i.test(p) ||
      /(^|\/)(readme|license|licence|contributing|changelog|authors|notice|code_of_conduct|security)/i.test(p) ||
      p.endsWith("package.json");
    const docsRecalled = recalled.filter(isDoc);
    console.log(`\n=== BOX-6 RECALL PROBE ($0) ===`);
    console.log(`field-derived query: "${query}"`);
    console.log(`recalled (k=5):`);
    for (const h of hits) console.log(`   bm25=${h.score.toFixed(3)}  ${h.relPath}${sourceSet.has(h.relPath) ? "  <-- BUG SOURCE" : ""}`);
    const pass = sourceRecalled.length >= 1 && docsRecalled.length === 0;
    console.log(`\nsource files recalled: ${sourceRecalled.length ? sourceRecalled.join(", ") : "(none)"}`);
    console.log(`doc/README files recalled: ${docsRecalled.length ? docsRecalled.join(", ") : "(none)"}`);
    console.log(`PROBE: ${pass ? "PASS" : "FAIL"} — at least one bug-source file recalled AND zero docs`);
    // Persist the curated query for the future live-bench hook (#5).
    writeFileSync(join(ws, ".tracebase", "retrieval-query.txt"), query + "\n");
    process.exit(pass ? 0 : 1);
  }

  const prompt = buildPrompt(task, ws);

  if (dry) {
    console.log(`\n--- DRY (no child claude, $0) ---`);
    console.log(`prompt (${prompt.length} chars):\n${prompt}\n`);
    // Sanity: at parent + test-diff, the bug is present → test MUST fail.
    const pre = verifyPass(task, ws);
    console.log(`pre-fix test exit=${pre.exit} (${pre.elapsedSec}s) — expect NON-zero (bug present): ${pre.exit !== 0 ? "OK FAIL" : "!! UNEXPECTED PASS"}`);
    console.log(`  tail:\n${pre.tail}`);
    if (variant === "ON") {
      // Fire inject-context exactly as the hook would, confirm <file_memory> renders.
      const stdin = JSON.stringify({ prompt, cwd: toPosix(ws), session_id: randomUUID() });
      const hook = spawnSync(
        "bash", ["-lc",
          `cd '${toPosix(ws)}' && echo '${stdin.replace(/'/g, "'\\''")}' | ` +
          `'${toPosix(REPO_TSX)}' '${toPosix(BIN_CLI)}' inject-context --host claude-code --status compact --budget 800 --path '${toPosix(ws)}'`],
        { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 },
      );
      const rendered = (hook.stdout ?? "").includes("<file_memory>");
      console.log(`\ninject-context hook exit=${hook.status}, <file_memory> rendered=${rendered}`);
      console.log(`hook stdout (first 1200 chars):\n${(hook.stdout ?? "").slice(0, 1200)}`);
      if (hook.status !== 0) console.log(`hook stderr:\n${(hook.stderr ?? "").slice(0, 600)}`);
    }
    console.log(`\nDRY complete for ${variant}. No API spend.`);
    return;
  }

  const sessionId = randomUUID();
  console.log(`session: ${sessionId}  budget cap: $${budget}`);

  // Bench-isolation guard (propagates to the child claude AND its hooks):
  // stop inject-context's self-heal from rewriting the ON workspace's
  // minimal UserPromptSubmit-only config into the full managed hook suite.
  // Without this the ON arm silently runs the entire mechanism stack
  // (PreToolUse/PostToolBatch/Stop/PreCompact), violating file_memory-only
  // isolation. (Root-caused in box-6 diagnostic, 2026-05-30.)
  process.env.TRACEBASE_SKIP_HOOK_SELF_HEAL = "1";

  const t0 = Date.now();
  const traj = runTrajectory({
    workspace: ws, prompt, sessionId,
    model: "claude-haiku-4-5",
    maxBudgetUsd: budget,
    allowedTools: "Read,Edit,Bash,Grep,Glob",
    // Wall timeout must exceed the budget-bounded runtime so the
    // --max-budget-usd cap (not this timeout) is the limiter; otherwise
    // a long trajectory is killed before claude emits its JSON envelope
    // and cost/tokens come back null. (First ON smoke hit a 300s wall.)
    timeoutMs: 600_000,
  });
  const wallSec = Math.round((Date.now() - t0) / 100) / 10;

  const cost = num(traj.parsed, "total_cost_usd");
  const durationMs = num(traj.parsed, "duration_ms");
  const numTurns = num(traj.parsed, "num_turns");
  const terminalReason = (traj.parsed as any)?.subtype ?? (traj.parsed as any)?.terminal_reason ?? null;
  const tokens = totalTokens((traj.parsed as any)?.usage);
  const tm = parseTranscript(traj.transcriptPath);

  console.log(`trajectory: exit=${traj.exitCode} wall=${wallSec}s cost=$${cost} turns=${numTurns} reason=${terminalReason} tokens=${tokens}`);
  console.log(`tools: ${JSON.stringify(tm.toolCounts)}  bytes_read=${tm.bytesRead}`);
  if (traj.exitCode !== 0) console.log(`stderr tail:\n${traj.stderr.split("\n").slice(-8).join("\n")}`);

  const verify = verifyPass(task, ws);
  console.log(`verify: test exit=${verify.exit} (${verify.elapsedSec}s) — ${verify.exit === 0 ? "PASS" : "FAIL"}`);

  // Post-run hook-isolation check (ON only): the workspace settings.json
  // MUST still contain ONLY UserPromptSubmit after the trajectory. If any
  // other hook event appears, inject-context's self-heal contaminated the
  // file_memory-only arm and the run is NOT comparable.
  let hookIsolation: { ok: boolean; events: string[] } | null = null;
  if (variant === "ON") {
    try {
      const sj = JSON.parse(readFileSync(join(ws, ".claude", "settings.json"), "utf-8"));
      const events = Object.keys(sj.hooks ?? {});
      hookIsolation = { ok: events.length === 1 && events[0] === "UserPromptSubmit", events };
      console.log(`hook isolation: ${hookIsolation.ok ? "OK (UserPromptSubmit only)" : `CONTAMINATED → ${events.join(",")}`}`);
    } catch (e: any) {
      hookIsolation = { ok: false, events: [`read-failed: ${e.message}`] };
      console.log(`hook isolation: UNKNOWN (${e.message})`);
    }
  }

  // Detect whether <file_memory> rendered in the injected context (ON only):
  // grep the transcript for the file_memory marker.
  let fileMemoryRendered: boolean | null = null;
  let recalledFiles: string[] = [];
  if (variant === "ON") {
    fileMemoryRendered = false;
    if (traj.transcriptPath && existsSync(traj.transcriptPath)) {
      const t = readFileSync(traj.transcriptPath, "utf-8");
      fileMemoryRendered = t.includes("<file_memory>") || t.includes("TB MEMORY");
    }
    recalledFiles = extractRecalledFiles(traj.transcriptPath);
    console.log(`file_memory recalled: ${JSON.stringify(recalledFiles)}`);
  }

  const out = {
    phase: "box 6 smoke",
    variant,
    task_id: taskId,
    repo: task.repo,
    pr_commit: task.pr_commit,
    parent_commit: task.parent_commit,
    title: task.title,
    workspace: toPosix(ws),
    session_id: sessionId,
    budget_cap_usd: budget,
    indexer,
    prompt_chars: prompt.length,
    trajectory: {
      exit_code: traj.exitCode,
      wall_sec: wallSec,
      duration_ms: durationMs,
      total_cost_usd: cost,
      num_turns: numTurns,
      terminal_reason: terminalReason,
      total_tokens: tokens,
      tool_counts: tm.toolCounts,
      glob: tm.toolCounts["Glob"] ?? 0,
      grep: tm.toolCounts["Grep"] ?? 0,
      read: tm.toolCounts["Read"] ?? 0,
      edit: tm.toolCounts["Edit"] ?? 0,
      bash: tm.toolCounts["Bash"] ?? 0,
      bytes_read: tm.bytesRead,
      transcript_path: traj.transcriptPath ? toPosix(traj.transcriptPath) : null,
    },
    file_memory_rendered: fileMemoryRendered,
    file_memory_recalled_files: variant === "ON" ? recalledFiles : null,
    hook_isolation: hookIsolation,
    verify: { test_exit: verify.exit, pass: verify.exit === 0, elapsed_sec: verify.elapsedSec, tail: verify.tail },
    raw_envelope_keys: traj.parsed ? Object.keys(traj.parsed) : [],
  };

  const outPath = join(RESULTS, `box-6-smoke.${variant}.json`);
  writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  console.log(`\nWrote ${outPath}`);
}

// Run main() only when invoked directly as a CLI, NOT when imported (e.g.
// by mini-pilot.ts). Robust cross-platform check: resolve argv[1] and
// compare to this module's file path (handles Windows file:///C: vs
// relative argv).
const invokedDirectly = (() => {
  try { return !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
})();
if (invokedDirectly) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
