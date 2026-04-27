/**
 * Local-only demo seeder for `tracebase savings`. Plants a realistic
 * mix of mechanism events into a fresh project's analytics_events
 * so the dashboard renders something other than the empty state.
 *
 * Usage: `npx tsx scripts/_savings-demo-seed.ts <project-dir>`
 *
 * NOT shipped — `scripts/` is excluded from the npm `files` array.
 * Used only to demo the new dashboard during development.
 */
import Database from "better-sqlite3";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { BlockStore } from "../src/core/block-store.js";

const projectDir = process.argv[2];
if (!projectDir) {
  process.stderr.write("usage: tsx scripts/_savings-demo-seed.ts <project-dir>\n");
  process.exit(1);
}
const cfg = JSON.parse(
  readFileSync(join(projectDir, ".tracebase", "config.json"), "utf-8"),
) as { storagePath?: string };
const dbPath = cfg.storagePath ?? join(projectDir, ".tracebase", "memory.db");

const db = new Database(dbPath);
const store = new BlockStore(db);

const now = Date.now();
const tBase = now - 6 * 86_400_000;

for (let i = 0; i < 12; i++) {
  store.appendEvent({
    ts: tBase + i * 600_000,
    queryId: `seed-fold-${i}`,
    event: "context.folded",
    sessionId: `s-${i % 3}`,
    chunkRange: `${i * 8}-${(i + 1) * 8 - 1}`,
    tokensBefore: 4200,
    tokensAfter: 250,
    summarizer: "heuristic",
  });
}

for (let i = 0; i < 8; i++) {
  store.appendEvent({
    ts: tBase + i * 800_000,
    queryId: `seed-fm-${i}`,
    event: "file_memory.recalled",
    fileIds: [`src/seed-${i}.ts`],
    tokensInjected: 200,
    bytesAvoided: 7000,
  });
}

// Strict mode only blocks safe-read families (read + search), so
// only Read/Grep produce blocked:true events. The other families
// (Bash/Edit/Write/WebFetch) are emitted with mode:"warn" /
// blocked:false to mirror real supervisor output.
const blockedTools = ["Read", "Read", "Read", "Grep", "Grep"];
for (let i = 0; i < 14; i++) {
  const tool = blockedTools[i % blockedTools.length]!;
  if (i < 4) {
    store.appendEvent({
      ts: tBase + i * 200_000,
      queryId: `seed-warn-block-${i}`,
      event: "tool_supervision.warned",
      argKey: `seed-k-${i}`,
      toolName: tool,
      mode: "block",
    });
  } else {
    store.appendEvent({
      ts: tBase + i * 200_000,
      queryId: `seed-supp-block-${i}`,
      event: "tool_supervision.suppressed",
      argKey: `seed-k-${i}`,
      toolName: tool,
      blocked: true,
    });
  }
}
const warnTools = ["Bash", "Edit", "Write", "WebFetch"];
for (let i = 0; i < 10; i++) {
  const tool = warnTools[i % warnTools.length]!;
  if (i < 4) {
    store.appendEvent({
      ts: tBase + i * 250_000,
      queryId: `seed-warn-only-${i}`,
      event: "tool_supervision.warned",
      argKey: `seed-w-${i}`,
      toolName: tool,
      mode: "warn",
    });
  } else {
    store.appendEvent({
      ts: tBase + i * 250_000,
      queryId: `seed-supp-unblocked-${i}`,
      event: "tool_supervision.suppressed",
      argKey: `seed-w-${i}`,
      toolName: tool,
      blocked: false,
    });
  }
}

for (let i = 0; i < 5; i++) {
  store.appendEvent({
    ts: tBase + i * 1_000_000,
    queryId: `seed-cache-${i}`,
    event: "cache.prompt_hit",
    surface: i % 2 === 0 ? "anthropic" : "openai",
    tokensSaved: 1200 + i * 200,
  });
}

for (let i = 0; i < 6; i++) {
  store.appendEvent({
    ts: tBase + i * 400_000,
    queryId: `seed-retr-${i}`,
    event: "retrieval",
    candidates: [],
    shadow: false,
    injectedTokensEstimate: 800,
  });
}

store.close();
process.stdout.write("seeded\n");
