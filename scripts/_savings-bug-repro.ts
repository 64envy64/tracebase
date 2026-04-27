/**
 * Local-only repro seeder for the 0.7.1 by-family bug.
 *
 * Plants: warn-mode events for shell/edit/write/read so the
 * pre-fix dashboard would have shown those families as "saved"
 * even though the top-line total was 0.
 *
 * NOT shipped — `scripts/` excluded from npm pack.
 */
import Database from "better-sqlite3";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { BlockStore } from "../src/core/block-store.js";

const projectDir = process.argv[2];
if (!projectDir) {
  process.stderr.write("usage: tsx scripts/_savings-bug-repro.ts <project-dir>\n");
  process.exit(1);
}
const cfg = JSON.parse(
  readFileSync(join(projectDir, ".tracebase", "config.json"), "utf-8"),
) as { storagePath?: string };
const dbPath = cfg.storagePath ?? join(projectDir, ".tracebase", "memory.db");

const db = new Database(dbPath);
const store = new BlockStore(db);
const now = Date.now();

// Warn-mode duplicates across the four families the user named.
const warns: Array<[string, number]> = [
  ["Read", 4],
  ["Bash", 3],   // shell
  ["Edit", 2],
  ["Write", 1],
];
for (const [tool, n] of warns) {
  for (let i = 0; i < n; i++) {
    store.appendEvent({
      ts: now - i * 1000,
      queryId: `warn-${tool}-${i}`,
      event: "tool_supervision.warned",
      argKey: `k-${tool}-${i}`,
      toolName: tool,
      mode: "warn",
    });
  }
}

// Suppressed-but-not-blocked across the same set.
for (const [tool, n] of warns) {
  for (let i = 0; i < n; i++) {
    store.appendEvent({
      ts: now - i * 500,
      queryId: `sup-${tool}-${i}`,
      event: "tool_supervision.suppressed",
      argKey: `sk-${tool}-${i}`,
      toolName: tool,
      blocked: false,
    });
  }
}

store.close();
process.stdout.write("repro-seeded (no actual blocks; only warn + unblocked suppressed)\n");
