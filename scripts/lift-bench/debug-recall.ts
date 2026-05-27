#!/usr/bin/env tsx
import { ReasoningLayer } from "../../src/core/engine.js";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STORE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "bench-runs", "lift", "store", ".tracebase", "memory.db");

const layer = new ReasoningLayer({ storagePath: STORE });
const r = layer.recall({
  problem: "forEach with async callback returns before promises settle",
  limit: 5,
  minScore: 0,
});
console.log("hits:", r.length);
for (const h of r) console.log("  ", h.score.toFixed(3), "|", h.trace.problem.description.slice(0, 80));
layer.close();
