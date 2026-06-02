#!/usr/bin/env tsx
/** Inspect tool_observations + analytics_events for one workspace's db. */
import Database from "better-sqlite3";
import { resolve } from "node:path";

const wsArg = process.argv[2];
if (!wsArg) {
  console.error("usage: inspect-events.ts <workspace>");
  process.exit(2);
}
const dbPath = resolve(wsArg, ".tracebase", "memory.db");
const db = new Database(dbPath, { readonly: true });
try {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as Array<{ name: string }>;
  console.log(`db: ${dbPath}`);
  console.log(`tables (${tables.length}): ${tables.map((t) => t.name).join(", ")}`);

  const hasObs = tables.some((t) => t.name === "tool_observations");
  if (hasObs) {
    const c = db.prepare("SELECT COUNT(*) as c FROM tool_observations").get() as { c: number };
    console.log(`tool_observations rows: ${c.c}`);
    const byTool = db
      .prepare("SELECT tool_name, COUNT(*) as c FROM tool_observations GROUP BY tool_name ORDER BY c DESC")
      .all() as Array<{ tool_name: string; c: number }>;
    console.log("  by tool: " + byTool.map((r) => `${r.tool_name}=${r.c}`).join(", "));
  } else {
    console.log("tool_observations table absent");
  }

  const hasEvents = tables.some((t) => t.name === "analytics_events");
  if (hasEvents) {
    const c = db.prepare("SELECT COUNT(*) as c FROM analytics_events").get() as { c: number };
    console.log(`analytics_events rows: ${c.c}`);
    const byEvent = db
      .prepare("SELECT event, COUNT(*) as c FROM analytics_events GROUP BY event ORDER BY c DESC")
      .all() as Array<{ event: string; c: number }>;
    console.log("  by event:");
    for (const r of byEvent) console.log(`    ${r.event} = ${r.c}`);
  } else {
    console.log("analytics_events table absent");
  }

  const hasReason = tables.some((t) => t.name === "reasoning_blocks");
  const hasIdx = tables.some((t) => t.name === "indexed_files");
  if (hasReason) {
    const c = db.prepare("SELECT COUNT(*) as c FROM reasoning_blocks").get() as { c: number };
    console.log(`reasoning_blocks rows: ${c.c} (must stay 0 per pre-registration)`);
  }
  if (hasIdx) {
    const c = db.prepare("SELECT COUNT(*) as c FROM indexed_files").get() as { c: number };
    console.log(`indexed_files rows: ${c.c} (must stay 0 per pre-registration)`);
  }
} finally {
  db.close();
}
