#!/usr/bin/env tsx
/**
 * $0 capture-path preflight (Phase 5, Step 3).
 *
 * Drives the REAL hook CLIs — `capture-turn` and `inject-context` — through the
 * full organic loop against a single shared `--path` store, with NO paid agents:
 *
 *   1. CAPTURE  : synthetic bug-fix transcript → capture-turn → 1 runtime block
 *   2. RECALL   : inject-context with a matching query → injection rendered
 *   3. ATTRIBUTE: a 2nd transcript (same session_id) that USES the recalled
 *                 reasoning + verifies → Stop-hook inference emits
 *                 agent_used + resolved outcome with the SAME runId →
 *                 dogfood manifest reports fired/attributed/precision-ready.
 *
 * This proves the load-bearing wiring the paid run depends on: the shared store
 * via --path, the local CLI hook plumbing, and runId-consistent attribution
 * (the exact failure mode where mismatched runIds silently yield 0 agent_used).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { initConfig } from "../../src/core/config.js";
import { BlockStore } from "../../src/core/block-store.js";
import { buildDogfoodManifest } from "../../src/eval/dogfood-manifest.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TSX = join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
const CLI = join(ROOT, "bin", "cli.ts");

process.env.TRACEBASE_SKIP_HOOK_SELF_HEAL = "1";

const USER =
  "The pytest suite fails to collect the right package on a fresh clone because an " +
  "earlier sys.path entry shadows the intended namespace package, so imports resolve " +
  "to the wrong module and the tests error out during collection.";
const ASSISTANT =
  "The root cause is that an earlier sys.path entry exposes a namespace package that " +
  "shadows the intended one, so the pytest collector imports the wrong module during " +
  "collection. The first matching entry wins, which is why the intended package is " +
  "never reached.\n\n" +
  "Rename the shadowing module or remove its directory from sys.path before invoking " +
  "pytest, then run pytest collect-only to confirm the intended package is collected.";
// Recall query — a natural paraphrase of the same problem (no answer leakage).
const QUERY =
  "pytest can't collect the right package on a fresh clone; an early sys.path entry " +
  "seems to shadow the intended namespace package and imports resolve wrong.";
// Attribution turn: assistant USES the recalled reasoning AND verifies (resolved).
const USER2 = QUERY;
const ASSISTANT2 =
  "Following the recalled approach: an earlier sys.path entry was shadowing the " +
  "intended namespace package, so I removed that directory from sys.path before pytest " +
  "ran. I then ran `pytest --collect-only` and the intended package now collects, and " +
  "the full suite passes. Verified: tests pass.";

function hook(cmd: string, args: string[], stdin: object): { code: number | null; out: string; err: string } {
  const r = spawnSync(TSX, [CLI, cmd, ...args], {
    input: JSON.stringify(stdin), encoding: "utf-8",
    shell: process.platform === "win32", maxBuffer: 16 * 1024 * 1024,
  });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

function summary(shared: string) {
  const s = new BlockStore(new Database(join(shared, ".tracebase", "memory.db"), { readonly: true }), { skipMigrate: true });
  try { return buildDogfoodManifest(s).summary; } finally { s.close(); }
}

const SHARED = mkdtempSync(join(tmpdir(), "tb-preflight-"));
const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
const check = (name: string, pass: boolean, detail?: string) => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

try {
  console.log("=== $0 capture-path preflight ===");
  console.log(`shared store: ${SHARED}`);
  initConfig(SHARED, { install: { agent: "claude-code", agents: ["claude-code"] } });

  // 1. CAPTURE
  const t1 = join(SHARED, "t1.jsonl");
  writeFileSync(t1, [
    JSON.stringify({ type: "user", message: { role: "user", content: USER } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: ASSISTANT }] } }),
  ].join("\n") + "\n");
  const cap = hook("capture-turn", ["--host", "claude-code", "--capture", "compact", "--path", SHARED], { session_id: "S1", transcript_path: t1, cwd: SHARED });
  const s1 = summary(SHARED);
  check("capture: 1 runtime block stored", s1.runtimeCaptured === 1, `runtimeCaptured=${s1.runtimeCaptured}, capture-turn exit=${cap.code}`);

  // 2. RECALL
  const inj = hook("inject-context", ["--host", "claude-code", "--status", "compact", "--path", SHARED], { session_id: "S2", prompt: QUERY, cwd: SHARED });
  const injectedText = (inj.out || "").toLowerCase();
  const rendered = /sys\.path|namespace|pytest|shadow|tracebase|tb trace/.test(injectedText);
  check("recall: injection rendered into hook output", rendered, `out=${(inj.out || "").slice(0, 80).replace(/\n/g, " ")}`);
  const s2 = summary(SHARED);
  check("recall: injection event recorded (fired>=1)", s2.fired >= 1, `fired=${s2.fired}`);

  // 3. ATTRIBUTE (same session_id S2 → runId match)
  const t2 = join(SHARED, "t2.jsonl");
  writeFileSync(t2, [
    JSON.stringify({ type: "user", message: { role: "user", content: USER2 } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: ASSISTANT2 }] } }),
  ].join("\n") + "\n");
  const att = hook("capture-turn", ["--host", "claude-code", "--capture", "compact", "--path", SHARED], { session_id: "S2", transcript_path: t2, cwd: SHARED });
  const s3 = summary(SHARED);
  check("attribute: agent_used emitted (attributed>=1)", s3.attributed >= 1, `attributed=${s3.attributed}, exit=${att.code}`);
  check("attribute: precision-ready organic case (>=1)", s3.precisionReady >= 1, `precisionReady=${s3.precisionReady}`);

  const allPass = results.every((r) => r.pass);
  console.log(`\nfinal summary: ${JSON.stringify(s3)}`);
  console.log(`PREFLIGHT: ${allPass ? "PASS" : "FAIL"} (${results.filter((r) => r.pass).length}/${results.length})`);
  process.exit(allPass ? 0 : 1);
} finally {
  try { rmSync(SHARED, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }); } catch { /* temp */ }
}
