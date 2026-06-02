#!/usr/bin/env tsx
/**
 * CLI front-end for the generic pattern importer (Phase 4).
 *
 *   npx tsx scripts/adapters/import-patterns.ts --input patterns.jsonl --dry-run
 *   npx tsx scripts/adapters/import-patterns.ts --input patterns.jsonl [--db <path>]
 *
 * Reads newline-delimited ReasoningPatternDTO records and runs each through the
 * SAME ingestPattern validator the runtime uses. Optional, replaceable, and
 * absent from runtime control flow.
 */
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { BlockStore } from "../../src/core/block-store.js";
import { importPatternsFromJsonl, formatImportSummary } from "../../src/ingest/import-patterns.js";

const argv = process.argv.slice(2);
const has = (n: string): boolean => argv.includes(n);
const opt = (n: string, def?: string): string | undefined => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};

const input = opt("--input");
if (!input) {
  console.error("usage: import-patterns --input <file.jsonl> [--db <path>] [--dry-run]");
  process.exit(1);
}
const dbPath = opt("--db", ".tracebase/memory.db")!;
const dryRun = has("--dry-run");

const store = new BlockStore(new Database(dbPath));
const summary = importPatternsFromJsonl(store, readFileSync(input, "utf-8"), { dryRun });
console.log(formatImportSummary(summary));
process.exitCode = summary.rejected > 0 ? 1 : 0;
