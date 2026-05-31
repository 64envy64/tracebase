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

const store = new BlockStore(new Database(dbPath, { readonly: true }));
const manifest = buildDogfoodManifest(store);
console.log(formatDogfoodSummary(manifest.summary));
if (out) {
  writeFileSync(out, manifestToJsonl(manifest) + "\n");
  console.log(`\nWrote ${manifest.entries.length} entries to ${out}`);
}
