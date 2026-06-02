#!/usr/bin/env tsx
/**
 * $0 deterministic smoke for the local-code Router V2 SHADOW hook path.
 *
 * Drives the REAL worktree inject-context CLI as a subprocess (the same command
 * the dogfood hook runs) with TRACEBASE_REASONING_ROUTER=shadow against a tiny
 * throwaway store, and asserts the production-safety contract:
 *   - the served injection envelope is V1-identical (shadow ⇄ off, modulo queryId);
 *   - exactly ONE local router.shadow_comparison event is persisted;
 *   - its V2 comparison fields are populated;
 *   - NO raw prompt / body / path / secret is persisted;
 *   - the cloud sanitizer strips a shadow-shaped object whole;
 *   - router-shadow-report.ts runs and sees the traffic.
 *
 * No network, no paid agents, no embeddings. Run: `tsx scripts/dogfood/smoke-shadow-hook.ts`
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import { importPatternsFromJsonl } from "../../src/ingest/import-patterns.js";
import { PATTERN_DTO_SCHEMA_VERSION as V } from "../../src/ingest/pattern-dto.js";
import { sanitizeForCloud } from "../../src/cli/cloud-allowlist.js";
import type { RouterShadowComparisonEvent } from "../../src/types.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const win = process.platform === "win32";
const fails: string[] = [];
function check(cond: boolean, msg: string): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${msg}`);
  if (!cond) fails.push(msg);
}

// 1. Throwaway project with its own store.
const dir = mkdtempSync(join(tmpdir(), "tb-shadow-smoke-"));
const tbDir = join(dir, ".tracebase");
mkdirSync(tbDir, { recursive: true });
const dbPath = join(tbDir, "memory.db");
writeFileSync(join(tbDir, "config.json"), JSON.stringify({ workspaceId: "shadow-smoke", storagePath: dbPath }, null, 2));

// 2. Seed a tiny, safe corpus (two distinct recurring classes).
const NULL_GUARD = {
  s: "a config merge crashes when an optional key is absent and the undefined value is dereferenced",
  m: "an absent optional key yields undefined and the code dereferences it without a null guard so the absent case is indistinguishable",
  u: "guard the access: default or skip undefined before dereferencing",
};
const RETRY_STORM = {
  s: "a transient failure triggers a retry storm because retries lack exponential backoff or jitter",
  m: "retries fire immediately without exponential backoff or jitter so clients synchronize and amplify load into a storm",
  u: "add exponential backoff with jitter and a budget so retries spread out",
};
const mk = (p: typeof NULL_GUARD, ref: string) =>
  JSON.stringify({
    schemaVersion: V,
    pattern: { situation: p.s, mechanism: p.m, unlock: p.u, verification: "re-run the failing scenario and confirm" },
    scope: { language: "general" },
    signals: { tags: [ref] },
    provenance: { sourceType: "import", sourceRef: `t:${ref}`, capturedAt: 1, captureVersion: "smoke" },
  });
{
  const seed = new BlockStore(new Database(dbPath));
  importPatternsFromJsonl(seed, [mk(NULL_GUARD, "null-guard"), mk(RETRY_STORM, "retry-storm")].join("\n"), { now: 1 });
  seed.close();
}

// 3. Drive the REAL worktree inject-context CLI (the hook command) via stdin.
const QUERY = "a request handler throws on a missing optional header whose undefined value is dereferenced with no null guard";
const SESSION = "shadow-smoke-session";
const stdinJson = JSON.stringify({ prompt: QUERY, session_id: SESSION, cwd: dir });
function runHook(routerMode: string | undefined): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(
    "npx",
    ["tsx", "bin/cli.ts", "inject-context", "--host", "claude-code", "--status", "compact", "-p", dir],
    {
      cwd: ROOT,
      input: stdinJson,
      encoding: "utf8",
      timeout: 180_000,
      env: { ...process.env, ...(routerMode ? { TRACEBASE_REASONING_ROUTER: routerMode } : { TRACEBASE_REASONING_ROUTER: "off" }) },
      shell: win,
    },
  );
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

console.log("running inject-context (shadow) through the real hook path...");
const shadowRun = runHook("shadow");
check(shadowRun.status === 0, "inject-context (shadow) exits 0");

console.log("running inject-context (off) for the V1-identical comparison...");
const offRun = runHook("off");
check(offRun.status === 0, "inject-context (off) exits 0");

// Per-recall correlation ids differ every call (NOT a shadow alteration): the
// full queryId UUID and its short `#<hex>` form in the status line. Normalize
// both before comparing the served envelope CONTENT.
const norm = (s: string) =>
  s
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "UUID")
    .replace(/#[0-9a-f]{6,}/gi, "#ID")
    .trim();
check(norm(shadowRun.stdout) === norm(offRun.stdout), "served envelope content is V1-identical (shadow ⇄ off, modulo per-recall ids)");

// 4. Inspect the persisted events.
const inspect = new BlockStore(new Database(dbPath));
const events = inspect.readEvents({});
const shadowEvents = events.filter((e) => e.event === "router.shadow_comparison") as RouterShadowComparisonEvent[];
check(shadowEvents.length === 1, `exactly one router.shadow_comparison event (got ${shadowEvents.length})`);
const e = shadowEvents[0];
check(!!e && e.v2FeatureVersion === 2 && e.candidateCount >= 1, "V2 comparison fields populated (featureVersion 2, candidates >= 1)");
check(!!e && e.resolverName === "structured-signature.v2", "comparison records the hardened resolver name");
check(!!e && (e.v1Action === "inject" || e.v1Action === "abstain") && (e.v2Action === "inject" || e.v2Action === "abstain"), "comparison records both V1 and V2 actions");

// No raw prompt / body / path / secret anywhere in the persisted events.
const serialized = JSON.stringify(events);
check(!serialized.includes(QUERY) && !serialized.includes("missing optional header"), "no raw prompt persisted");
check(!serialized.includes("dereferences it without a null guard"), "no raw body/mechanism persisted");
check(!serialized.includes(dbPath) && !serialized.includes(dir) && !serialized.toLowerCase().includes("users\\") && !serialized.includes("/Users"), "no raw path persisted");
inspect.close();

// 5. Cloud sanitizer strips a shadow-shaped object whole.
const sanitized = sanitizeForCloud({ routerShadow: e, metrics: { routerShadow: e } }) as { routerShadow?: unknown; metrics?: { routerShadow?: unknown } };
check(sanitized.routerShadow === undefined && sanitized.metrics?.routerShadow === undefined, "cloud sanitizer strips the shadow event whole (local-only)");

// 6. The shadow report runs against the store.
console.log("running router-shadow-report.ts...");
const rep = spawnSync("npx", ["tsx", "scripts/reasoning-precision/router-shadow-report.ts", "--db", dbPath], {
  cwd: ROOT,
  encoding: "utf8",
  timeout: 180_000,
  shell: win,
});
check(rep.status === 0 && /traffic:\s*1\b/.test(rep.stdout), "router-shadow-report.ts runs and reports traffic: 1");

// Cleanup (best effort — Windows may hold the temp DB handle briefly).
try {
  rmSync(dir, { recursive: true, force: true });
} catch {
  /* leave the temp dir; the OS reaps it */
}

console.log("");
if (fails.length === 0) {
  console.log("SHADOW HOOK SMOKE: PASS");
  process.exit(0);
} else {
  console.log(`SHADOW HOOK SMOKE: FAIL (${fails.length})`);
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
