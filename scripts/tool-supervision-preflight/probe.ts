#!/usr/bin/env tsx
/**
 * Preflight for the 03 tool-supervision bench. Verifies that the
 * production `capture-pre-tool-use` CLI returns `decision: "block"`
 * in its JSON envelope on a duplicate Read in strict mode — i.e. that
 * the mechanism actually blocks, not just logs.
 *
 * Method: build a fresh .tracebase in a temp workspace, pre-seed the
 * recent-tool cache with three identical Read observations (the
 * production threshold for a "stuck repeat"), then invoke the CLI on
 * a fourth identical Read. Inspect stdout for the block decision.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initConfig, getOrMintWorkspaceSalt } from "../../src/core/config.js";
import { RecentToolCache, type CachedObservation } from "../../src/runtime/recent-tool-cache.js";
import { sanitizeToolArgs } from "../../src/core/tool-arg.js";
import { runCapturePreToolUse } from "../../src/cli/commands/capture-pre-tool-use.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..", "..");
const TSX = join(ROOT, "node_modules", ".bin", "tsx.cmd");
const CLI = join(ROOT, "bin", "cli.ts");
const FIXTURE_PATH = join(ROOT, "tests", "fixtures", "pre-tool-use", "read.json");

const work = join(tmpdir(), `tb-tool-supervision-preflight-${Date.now()}`);
if (existsSync(work)) rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

// 1. Initialise the workspace as a TraceBase project with strict mode enabled.
const cfg = initConfig(work, { install: { agent: "claude-code", agents: ["claude-code"] } });
const cfgPath = join(work, ".tracebase", "config.json");
const cfgRaw = JSON.parse(readFileSync(cfgPath, "utf-8"));
cfgRaw.toolSupervision = { strict: true };
writeFileSync(cfgPath, JSON.stringify(cfgRaw, null, 2));

// 2. Pre-seed the recent-tool warm cache with three identical Reads
//    of /work/repo/src/auth.ts — matching the golden read.json fixture.
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8"));
const toolName = fixture.tool_name;
const toolInput = fixture.tool_input;
const sessionId = fixture.session_id ?? "session-preflight-0001";

const salt = getOrMintWorkspaceSalt(work);
if (!salt) throw new Error("could not mint workspace salt");
const sanitized = sanitizeToolArgs({ toolName, toolInput, cwd: work, workspaceSalt: salt });
const argKey = sanitized.argKey;
const cache = new RecentToolCache();
const now = Date.now();
for (let i = 0; i < 3; i++) {
  cache.append({ argKey, toolName, sessionId, ts: now - 1000 + i });
}
cache.flush(work);
console.log(`Seeded 3 cache entries with argKey=${argKey.slice(0, 16)}...`);

// 3. Invoke runCapturePreToolUse directly (the function the CLI thin-wraps).
const rawStdin = Buffer.from(JSON.stringify(fixture));
const out = runCapturePreToolUse(
  { path: work, host: "claude-code" },
  rawStdin,
);

console.log("\n=== ENVELOPE ===");
console.log(out.envelope);
console.log("\n=== FLAGS ===");
console.log("blocked:", out.blocked, " warned:", out.warned, " signalKind:", out.signalKind);

const env = JSON.parse(out.envelope);
console.log("\n=== VERDICT ===");
console.log("decision:    ", JSON.stringify(env.decision));
console.log("reason:      ", JSON.stringify(env.reason));
console.log("systemMessage:", JSON.stringify(env.systemMessage));
const blocked = env.decision === "block";
console.log("\nblocked end-to-end?", blocked ? "YES — mechanism works" : "NO — mechanism only warns");

// Cleanup
try { rmSync(work, { recursive: true, force: true }); } catch {}
