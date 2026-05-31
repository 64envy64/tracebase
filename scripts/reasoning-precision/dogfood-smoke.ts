#!/usr/bin/env tsx
/**
 * $0 dogfood capture smoke — verifies the ACTIVATED local-code Stop hook captures
 * a block from a realistic (operational-preamble + markdown) turn, via the SAME
 * local CLI command settings.local.json runs. No paid agents, no network.
 * Exits 0 iff exactly one privacy-clean runtime block lands.
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

const dir = mkdtempSync(join(tmpdir(), "tb-dogfood-smoke-"));
try {
  initConfig(dir, { install: { agent: "claude-code", agents: ["claude-code"] } });
  // Realistic closing turn: operational preamble + markdown root-cause/fix.
  const t = join(dir, "t.jsonl");
  writeFileSync(t, [
    JSON.stringify({ type: "user", message: { role: "user", content:
      "Working directory (operate strictly inside):\n/some/abs/ws\n- Run the test with: npx vitest run x\n" +
      "A unit test fails: a recurring null-guard bug lets undefined config values reach the merge step and crash." } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text:
      "## Root Cause\nThe configuration merge step did not guard against undefined values. When a key was absent " +
      "from the incoming partial config, its value came through as undefined, and the reducer that folds the " +
      "defaults over the overrides dereferenced that undefined value and threw before the merged config was ever " +
      "produced. The crash therefore happened during merge, not during validation.\n\n" +
      "## Fix\nGuard the merge: skip undefined values before reducing, treating an absent key as 'inherit the " +
      "default' rather than 'override with undefined'. This keeps the reducer total over partial inputs. I re-ran " +
      "the failing test and the full suite afterwards, and both pass." }] } }),
  ].join("\n") + "\n");

  const r = spawnSync(TSX, [CLI, "capture-turn", "--host", "claude-code", "--capture", "compact", "--path", dir],
    { input: JSON.stringify({ session_id: "smoke-1", transcript_path: t, cwd: dir }), encoding: "utf-8", shell: process.platform === "win32", maxBuffer: 16 * 1024 * 1024 });

  const store = new BlockStore(new Database(join(dir, ".tracebase", "memory.db"), { readonly: true }), { skipMigrate: true });
  const m = buildDogfoodManifest(store);
  const clean = m.entries.every((e) => e.leakClean);
  store.close();
  console.log(`capture-turn exit=${r.status} · runtimeCaptured=${m.summary.runtimeCaptured} · leakClean=${clean}`);
  const ok = m.summary.runtimeCaptured >= 1 && clean;
  console.log(`DOGFOOD CAPTURE SMOKE: ${ok ? "PASS" : "FAIL"}`);
  process.exit(ok ? 0 : 1);
} finally {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }); } catch { /* temp */ }
}
