#!/usr/bin/env tsx
/**
 * Dogfood capture status + manifest emitter (Phase 5, Step 2).
 *
 *   npx tsx scripts/reasoning-precision/dogfood-status.ts [--db <path>] [--out manifest.jsonl]
 *
 * Prints the compact progress report and (with --out) writes the privacy-safe
 * JSONL manifest that feeds the organic precision evaluator. Read-only.
 */
import Database from "better-sqlite3";
import { existsSync, writeFileSync } from "node:fs";
import { BlockStore } from "../../src/core/block-store.js";
import { buildDogfoodManifest, manifestToJsonl, formatDogfoodSummary } from "../../src/eval/dogfood-manifest.js";

const argv = process.argv.slice(2);
const opt = (n: string, def?: string): string | undefined => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const dbPath = opt("--db", ".tracebase/memory.db")!;
const out = opt("--out");
if (!existsSync(dbPath)) {
  console.error(`No BlockStore at ${dbPath} — run the runtime (Stop hook) first, or pass --db <path>.`);
  process.exit(1);
}

// Read-only status: open the existing store read-only AND skip migration.
// BlockStore's constructor migrates by default (a write), which throws
// SQLITE_READONLY on a readonly connection — so a plain `{ readonly: true }`
// open crashes against any real store. The runtime (Stop hook) is what
// creates/migrates the DB; a status command must never attempt a migration.
// `skipMigrate` makes the documented command work against an existing DB.
const store = new BlockStore(new Database(dbPath, { readonly: true }), { skipMigrate: true });
const manifest = buildDogfoodManifest(store);
console.log(formatDogfoodSummary(manifest.summary));
if (out) {
  writeFileSync(out, manifestToJsonl(manifest) + "\n");
  console.log(`\nWrote ${manifest.entries.length} entries to ${out}`);
}
