#!/usr/bin/env tsx
/**
 * Path A harness spike.
 *
 * Goal: verify that a child `claude --print` process spawned in a
 * workspace cwd actually loads that workspace's `.claude/settings.json`
 * and fires PreToolUse / PostToolUse hooks per-tool-call into that
 * workspace's `.tracebase/memory.db`.
 *
 * If yes, we have the missing infrastructure to bench tool-supervision,
 * loop-detection, and context-fold mechanisms at real-agent level.
 *
 * If no, we learn why (auth wall? settings source override? hook spec
 * mismatch?) and pick a fallback before sinking time into harness build.
 *
 * Method:
 *   1. Build a fresh ON workspace identical to the 03 bench shape:
 *      - .tracebase via initConfig + toolSupervision.mode = "soft"
 *      - .claude/settings.json with PreToolUse + PostToolUse hooks
 *        pointing at our tsx + bin/cli.ts
 *      - a single source file the agent will Read twice
 *
 *   2. Spawn `claude --print --output-format json` with a prompt that
 *      naturally requires reading the same file twice. The 2nd Read
 *      should produce a soft-redirect (decision:"block") if hooks fire.
 *
 *   3. After exit, inspect the workspace's .tracebase/memory.db:
 *        - tool_observations rows (PostToolUse fills these)
 *        - analytics_events rows with event=tool_supervision.*
 *
 *   4. Report verdict + raw evidence.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { initConfig } from "../../src/core/config.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..", "..");
const TSX_BIN = join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
const CLI_TS = join(ROOT, "bin", "cli.ts");
const CLAUDE_BIN = process.env.CLAUDE_CLI ?? "claude";

// 1. Build workspace
const WS = join(tmpdir(), `tb-path-a-spike-${Date.now()}`);
if (existsSync(WS)) rmSync(WS, { recursive: true, force: true });
mkdirSync(WS, { recursive: true });
mkdirSync(join(WS, "src"), { recursive: true });

writeFileSync(
  join(WS, "src", "parse.ts"),
  `// Simple parser. Has one obvious bug: regex drops decimals.
export function parseNum(s: string): number | null {
  const m = s.match(/(\\d+)/);
  return m ? Number(m[1]) : null;
}
`,
);

// 2. Bootstrap .tracebase + ON config
initConfig(WS, { install: { agent: "claude-code", agents: ["claude-code"] } });
const tracebaseCfgPath = join(WS, ".tracebase", "config.json");
const tracebaseCfg = JSON.parse(readFileSync(tracebaseCfgPath, "utf-8"));
tracebaseCfg.toolSupervision = { mode: "soft" };
writeFileSync(tracebaseCfgPath, JSON.stringify(tracebaseCfg, null, 2) + "\n");

// 3. Install hooks via .claude/settings.json
//
// CRITICAL — Windows path quoting: Claude Code on Windows pipes hook
// commands through MSYS bash. Backslashes in absolute paths become
// shell escape characters and silently collapse the path
// (`C:\Users\...` → `C:Users...command not found`). Use forward slashes
// throughout — Windows file APIs accept them natively, bash does not
// escape them.
mkdirSync(join(WS, ".claude"), { recursive: true });
const toPosix = (p: string) => p.replace(/\\/g, "/");
const preCmd = `${toPosix(TSX_BIN)} ${toPosix(CLI_TS)} capture-pre-tool-use --host claude-code --path ${toPosix(WS)}`;
const postCmd = `${toPosix(TSX_BIN)} ${toPosix(CLI_TS)} capture-tool-use --host claude-code --path ${toPosix(WS)}`;
writeFileSync(
  join(WS, ".claude", "settings.json"),
  JSON.stringify(
    {
      hooks: {
        PreToolUse: [
          {
            hooks: [{ type: "command", command: preCmd, timeout: 5, statusMessage: "TB TOOL" }],
          },
        ],
        PostToolUse: [
          {
            hooks: [{ type: "command", command: postCmd, timeout: 5, statusMessage: "TB OBS" }],
          },
        ],
      },
    },
    null,
    2,
  ) + "\n",
);

console.log("=== Workspace ready ===");
console.log("  ws:", WS);
console.log("  files:", "src/parse.ts");
console.log("");

// 4. The prompt: induce THREE identical Read calls of the same file.
//    Under mode=soft, R1=free, R2=warn (systemMessage), R3=soft-redirect
//    (decision:"block"). The 3rd call is the load-bearing check — if the
//    agent's 3rd Read returns a block decision, hooks definitely fire and
//    the tier ladder works end-to-end through child claude CLI.
const PROMPT =
  "Please use your Read tool to read the file src/parse.ts THREE times in a row, " +
  "back to back, with no other tool calls in between. I am running an instrumentation " +
  "test and need exactly three identical Read calls. After the three Reads, write a " +
  "one-line summary of what the file does and end with 'DONE'.";

const SESSION_ID = "00000000-0000-4000-8000-000000000001";

console.log("=== Spawning child claude CLI ===");
console.log(`  bin: ${CLAUDE_BIN}`);
console.log(`  cwd: ${WS}`);
console.log(`  model: claude-haiku-4-5`);
console.log("");

// Windows: `claude` is a shim (no .exe). Use shell:true so PATH lookup
// resolves it. Pipe prompt via stdin to avoid arg-escaping ambiguity.
const child = spawnSync(
  CLAUDE_BIN,
  [
    "--print",
    "--output-format", "json",
    "--model", "claude-haiku-4-5",
    "--permission-mode", "bypassPermissions",
    "--setting-sources", "project,local",
    "--session-id", SESSION_ID,
    "--max-budget-usd", "0.50",
    "--allowedTools", "Read",
  ],
  {
    cwd: WS,
    encoding: "utf-8",
    shell: process.platform === "win32",
    input: PROMPT,
    timeout: 180_000,
  },
);

console.log("=== Child exit ===");
console.log(`  status: ${child.status}`);
console.log(`  signal: ${child.signal ?? "none"}`);
if (child.error) console.log(`  error: ${child.error.message}`);
console.log(`  stdout length: ${(child.stdout ?? "").length}`);
console.log(`  stderr length: ${(child.stderr ?? "").length}`);
console.log("");

if (child.stderr) {
  console.log("=== STDERR (first 60 lines) ===");
  console.log(child.stderr.split("\n").slice(0, 60).join("\n"));
  console.log("");
}

let parsed: Record<string, unknown> = {};
try {
  parsed = JSON.parse(child.stdout ?? "{}");
} catch (e) {
  console.log("=== STDOUT raw (parse failed) ===");
  console.log((child.stdout ?? "").slice(0, 2000));
  console.log("");
}
if (Object.keys(parsed).length > 0) {
  console.log("=== Child JSON result (top-level keys) ===");
  console.log("  keys:", Object.keys(parsed).join(", "));
  for (const k of ["session_id", "model", "is_error", "duration_ms", "duration_api_ms", "num_turns", "result", "total_cost_usd"] as const) {
    if (k in parsed) console.log(`  ${k}: ${JSON.stringify(parsed[k]).slice(0, 200)}`);
  }
  if (parsed.usage) console.log(`  usage: ${JSON.stringify(parsed.usage).slice(0, 300)}`);
  console.log("");
}

// 5. Inspect workspace's .tracebase/memory.db
console.log("=== Workspace .tracebase inspect ===");
const dbPath = join(WS, ".tracebase", "memory.db");
if (!existsSync(dbPath)) {
  console.log(`  NO memory.db at ${dbPath}`);
  console.log("  → hooks did NOT fire (would have created the DB on first PostToolUse)");
} else {
  const db = new Database(dbPath, { readonly: true });
  try {
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>
    ).map((t) => t.name);
    console.log(`  tables (${tables.length}): ${tables.join(", ").slice(0, 200)}...`);

    const hasObs = tables.includes("tool_observations");
    if (hasObs) {
      const c = db.prepare("SELECT COUNT(*) as c FROM tool_observations").get() as { c: number };
      console.log(`  tool_observations rows: ${c.c}`);
      const byTool = db
        .prepare("SELECT tool_name, COUNT(*) as c FROM tool_observations GROUP BY tool_name ORDER BY c DESC")
        .all() as Array<{ tool_name: string; c: number }>;
      for (const r of byTool) console.log(`    ${r.tool_name} = ${r.c}`);
    }

    const hasEvents = tables.includes("analytics_events");
    if (hasEvents) {
      const rows = db.prepare("SELECT payload FROM analytics_events").all() as Array<{ payload: string }>;
      const supEvents = new Map<string, number>();
      for (const r of rows) {
        try {
          const p = JSON.parse(r.payload);
          if (typeof p.event === "string" && p.event.startsWith("tool_supervision.")) {
            supEvents.set(p.event, (supEvents.get(p.event) ?? 0) + 1);
          }
        } catch { /* skip */ }
      }
      console.log(`  analytics_events total rows: ${rows.length}`);
      console.log(`  tool_supervision.* events:`);
      if (supEvents.size === 0) console.log("    (none)");
      for (const [e, n] of supEvents) console.log(`    ${e} = ${n}`);
    }

    // verdict
    const obsCount = hasObs ? (db.prepare("SELECT COUNT(*) as c FROM tool_observations").get() as { c: number }).c : 0;
    console.log("");
    console.log("=== VERDICT ===");
    if (obsCount > 0) {
      console.log(`  hooks FIRED — ${obsCount} tool_observations row(s) written.`);
      console.log(`  PATH A HARNESS WORKS in principle. Next: capture transcript + standardize OFF/ON driver.`);
    } else {
      console.log("  hooks DID NOT fire — DB exists (from initConfig) but no observations.");
      console.log("  This means child claude loaded settings.json but PostToolUse didn't capture, OR didn't load settings.json at all.");
      console.log(`  Check stderr above for hook errors. Try removing --setting-sources flag to compare.`);
    }
  } finally {
    db.close();
  }
}

console.log("");
console.log(`Workspace preserved for inspection: ${WS}`);
console.log("(Re-run script wipes /tmp/tb-path-a-spike-* — leave for manual look or rm.)");
