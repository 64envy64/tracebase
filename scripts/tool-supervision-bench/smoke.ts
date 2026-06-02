#!/usr/bin/env tsx
/**
 * End-to-end smoke: drive the actual production capture-tool-use +
 * capture-pre-tool-use CLIs against a real ON workspace exactly as
 * Claude Code would. Confirms:
 *   1. PostToolUse (capture-tool-use) materialises tool_observations rows.
 *   2. PreToolUse (capture-pre-tool-use) reads them and returns soft-
 *      redirect (decision:"block") on the second identical Read call
 *      under mode=soft, with the prior-output-reference reason text.
 *
 * If this smoke fails, the bench will be null-result for the wrong reason
 * (mis-configured install, not mechanism failure) — so it must pass
 * before any agent dispatch.
 */
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..", "..");
const TSX = join(ROOT, "node_modules", ".bin", "tsx.cmd");
const CLI = join(ROOT, "bin", "cli.ts");
const WS = join(ROOT, "bench-runs", "tool-supervision", "workspaces", "hunt-the-bug.ON");
const TARGET = join(WS, "src", "parse.ts");

const SESSION_ID = "smoke-session-0001";

function call(args: string[], stdin: string): { stdout: string; stderr: string; code: number } {
  const child = spawnSync(TSX, [CLI, ...args], {
    cwd: ROOT,
    input: stdin,
    encoding: "utf-8",
    shell: process.platform === "win32",
    env: { ...process.env, TRACEBASE_DISABLED: "0", TRACEBASE_SKIP_HOOK_SELF_HEAL: "1" },
  });
  return { stdout: child.stdout ?? "", stderr: child.stderr ?? "", code: child.status ?? -1 };
}

// 1. PostToolUse (capture-tool-use) — fire twice as if Claude Code ran two
//    identical Read calls and the post-tool hook captured each batch.
//    Stdin shape per src/cli/commands/capture-tool-use.ts.
function postBatch(label: string) {
  const stdin = JSON.stringify({
    hook_event_name: "PostToolBatch",
    session_id: SESSION_ID,
    cwd: WS,
    permission_mode: "default",
    tool_calls: [
      {
        tool_name: "Read",
        tool_input: { file_path: TARGET },
        tool_response: { content: "<dummy>" },
      },
    ],
  });
  const r = call(["capture-tool-use", "--host", "claude-code", "--path", WS], stdin);
  console.log(`postBatch[${label}] code=${r.code} stdout-len=${r.stdout.length}`);
  if (r.stderr) console.log(`  stderr: ${r.stderr.trim().slice(0, 200)}`);
}

// 2. PreToolUse (capture-pre-tool-use) — call once before observation,
//    then twice after seeding two prior observations.
function preCall(label: string): { decision?: string; reason?: string; systemMessage?: string } {
  const stdin = JSON.stringify({
    hook_event_name: "PreToolUse",
    session_id: SESSION_ID,
    cwd: WS,
    permission_mode: "default",
    tool_name: "Read",
    tool_input: { file_path: TARGET },
  });
  const r = call(["capture-pre-tool-use", "--host", "claude-code", "--path", WS], stdin);
  let env: { decision?: string; reason?: string; systemMessage?: string } = {};
  try { env = JSON.parse(r.stdout || "{}"); } catch {}
  console.log(`preCall[${label}] code=${r.code} decision=${JSON.stringify(env.decision)} reason=${(env.reason ?? "").slice(0, 80)}`);
  return env;
}

console.log("=== before any observation ===");
const before = preCall("0-prior");
console.log();

console.log("=== seed 1 observation ===");
postBatch("first");
const after1 = preCall("1-prior");
console.log();

console.log("=== seed 2 observations total ===");
postBatch("second");
const after2 = preCall("2-prior");
console.log();

console.log("=== verdict ===");
const expectFreeFirst = before.decision === undefined;
const expectWarnAfter1 = after1.systemMessage !== undefined && after1.decision === undefined;
const expectBlockAfter2 = after2.decision === "block";
console.log(`first call free?         ${expectFreeFirst ? "YES" : "NO"}`);
console.log(`1-prior is warn only?    ${expectWarnAfter1 ? "YES" : "NO"} (systemMessage='${(after1.systemMessage ?? "").slice(0, 60)}')`);
console.log(`2-prior is soft-redirect (decision:block)? ${expectBlockAfter2 ? "YES" : "NO"}`);

if (expectFreeFirst && expectWarnAfter1 && expectBlockAfter2) {
  console.log("\nALL GREEN — bench install is correctly wired, mechanism fires end-to-end.");
  process.exit(0);
} else {
  console.log("\nSMOKE FAIL — install/mechanism wiring is wrong. Do not dispatch agents.");
  process.exit(1);
}
