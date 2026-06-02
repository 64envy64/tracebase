#!/usr/bin/env tsx
/**
 * Seed the captured-trace memory store from training-phase distillates.
 * Uses ReasoningLayer.storeTrace (the API ReasoningLayer.recall searches
 * against) so the recall path actually sees them.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ReasoningLayer } from "../../src/core/engine.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..", "..");
const STORE_ROOT = join(ROOT, "bench-runs", "lift", "store");
const DISTILLATES = join(ROOT, "bench-runs", "lift", "distillates", "captured.jsonl");

if (existsSync(STORE_ROOT)) rmSync(STORE_ROOT, { recursive: true, force: true });
mkdirSync(STORE_ROOT, { recursive: true });
mkdirSync(join(STORE_ROOT, ".tracebase"), { recursive: true });

const rows = readFileSync(DISTILLATES, "utf-8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

const layer = new ReasoningLayer({ storagePath: join(STORE_ROOT, ".tracebase", "memory.db") });
try {
  for (const d of rows) {
    layer.storeTrace({
      problem: {
        description: d.situation,
        language: "typescript",
        errorType: d.fixture_id,
        tags: ["captured-trace"],
      },
      solution: {
        summary: d.unlock,
        explanation: Array.isArray(d.deadEnds) ? d.deadEnds.join(". ") : String(d.deadEnds ?? ""),
        steps: [],
        outcome: "success",
      },
      metadata: { agent: "training-agent", source: "lift-bench:captured" },
    });
  }
} finally {
  layer.close();
}

console.log(`Seeded ${rows.length} captured traces into ${STORE_ROOT}/.tracebase/memory.db (via storeTrace API)`);
