#!/usr/bin/env tsx
/**
 * File-memory bench setup. For each task:
 *   - Build .OFF workspace = bare source copy.
 *   - Build .ON  workspace = same source + pre-indexed .tracebase
 *     (file_memory populated via indexWorkspace) +
 *     .claude/settings.json with ONLY UserPromptSubmit→inject-context
 *     (NO PreToolUse, NO loop-redirect hooks — reasoning-reuse lane
 *     disabled by keeping reasoning_blocks empty).
 */
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initConfig } from "../../src/core/config.js";
import { BlockStore } from "../../src/core/block-store.js";
import { indexWorkspace } from "../../src/core/file-indexer.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..", "..");
const BENCH = join(ROOT, "bench-runs", "file-memory");
const TASKS = join(BENCH, "tasks");
const WS = join(BENCH, "workspaces");
const REPO_TSX = join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
const BIN_CLI = join(ROOT, "bin", "cli.ts");

if (existsSync(WS)) rmSync(WS, { recursive: true, force: true });
mkdirSync(WS, { recursive: true });

const PAIRS = ["alpha-http-retry", "beta-slug", "gamma-ttl-cache"];

function writeMinimalHookConfig(workspace: string): void {
  // Only UserPromptSubmit → inject-context. No PreToolUse, no PostToolUse,
  // no PreCompact, no Stop. Disables tool supervision + loop redirect +
  // capture pipeline. The reasoning-reuse lane is disabled separately
  // by NOT seeding any reasoning_blocks rows in the store.
  mkdirSync(join(workspace, ".claude"), { recursive: true });
  const cmd =
    `${REPO_TSX} ${BIN_CLI} inject-context ` +
    `--host claude-code --status compact --budget 800 --path ${workspace}`;
  writeFileSync(
    join(workspace, ".claude", "settings.json"),
    JSON.stringify(
      {
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: "command",
                  command: cmd,
                  timeout: 5,
                  statusMessage: "TB FILE memory",
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    ) + "\n",
  );
}

for (const pair of PAIRS) {
  const src = join(TASKS, pair);
  for (const variant of ["OFF", "ON"] as const) {
    const dst = join(WS, `${pair}.${variant}`);
    cpSync(src, dst, { recursive: true });
    if (variant === "ON") {
      const cfg = initConfig(dst, {
        install: { agent: "claude-code", agents: ["claude-code"] },
      });
      const db = new Database(cfg.storagePath);
      const store = new BlockStore(db);
      try {
        const outcome = indexWorkspace(store, {
          root: dst,
          maxBytes: 262144,
          budget: { maxFiles: 256, maxDirs: 64, maxBytes: 1024 * 1024 },
        });
        console.log(`  ${pair}.ON indexed: ${outcome.indexedCount} files, ${outcome.bytesSummarized} bytes (${Object.entries(outcome.skipped).map(([k, v]) => `${k}=${v}`).join(",") || "no-skips"})`);
      } finally {
        store.close();
      }
      writeMinimalHookConfig(dst);
    }
  }
}

console.log("\nSet up 6 workspaces (3 pairs × OFF/ON).");
