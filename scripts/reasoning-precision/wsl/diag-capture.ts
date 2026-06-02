#!/usr/bin/env tsx
// Diagnose why live capture produced 0 blocks: run the REAL extraction path on
// an actual capture-trajectory transcript.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { readTranscript, extractPattern } from "../../../src/cli/commands/capture-turn.js";
import { BlockStore } from "../../../src/core/block-store.js";
import { storeReasoningPattern } from "../../../src/server/mcp-v2-helpers.js";

const projects = join(process.env.HOME!, ".claude", "projects");
const capDirs = readdirSync(projects).filter((d) => d.includes("reasoning-capture-workspaces-axios"));
console.log(`capture transcript dirs: ${capDirs.length}`);
let analyzed = 0;
for (const d of capDirs.slice(0, 4)) {
  const dir = join(projects, d);
  const jsonl = readdirSync(dir).filter((f) => f.endsWith(".jsonl"))[0];
  if (!jsonl) { console.log(`  ${d}: no jsonl`); continue; }
  const path = join(dir, jsonl);
  const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
  console.log(`\n=== ${d} (${lines.length} rows) ===`);
  const t = readTranscript(path);
  if (!t) { console.log(`  readTranscript → NULL (no usable user+assistant text)`); analyzed++; continue; }
  console.log(`  lastUserText (${t.lastUserText.length} ch): ${JSON.stringify(t.lastUserText.slice(0, 120))}`);
  console.log(`  lastAssistantText (${t.lastAssistantText.length} ch): ${JSON.stringify(t.lastAssistantText.slice(0, 200))}`);
  let extracted: any = null;
  try { extracted = extractPattern(t.lastUserText, t.lastAssistantText); } catch (e: any) { console.log(`  extractPattern THREW: ${e.message}`); }
  if (!extracted) { console.log(`  extractPattern → NULL (no root-cause+fix structure)`); analyzed++; continue; }
  console.log(`  extractPattern → situation=${JSON.stringify(String(extracted.situation ?? extracted.trigger ?? "").slice(0, 80))}`);
  const store = new BlockStore(new Database(":memory:"));
  try { const r = storeReasoningPattern(store, extracted); console.log(`  storeReasoningPattern → blockId=${r?.blockId ?? "null"} status=${(r as any)?.status ?? "?"}`); }
  catch (e: any) { console.log(`  storeReasoningPattern → REJECTED: ${e.constructor?.name}: ${e.message?.slice(0, 160)}`); }
  finally { store.close(); }
  analyzed++;
}
console.log(`\nanalyzed ${analyzed} capture transcripts`);
