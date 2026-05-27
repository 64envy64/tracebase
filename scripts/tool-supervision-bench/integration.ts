#!/usr/bin/env tsx
/**
 * 03 Tool Supervision — Path B synthetic integration test.
 *
 * Drives 8 scripted tool-call trajectories against the production
 * capture-pre-tool-use / capture-tool-use CLIs. Asserts that for each
 * scripted scenario, the mechanism produces the pre-registered
 * decisions and analytics_events.
 *
 * No real LLM, no real agent. The point is to verify the production
 * code path fires correctly under known inputs — NOT to measure agent
 * cost reduction (that requires Path A, child Claude Code CLI per
 * workspace, which is queued as future work).
 *
 * Pre-registration: bench-runs/tool-supervision/PRE-REGISTRATION.md
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { initConfig } from "../../src/core/config.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..", "..");
const TSX = join(ROOT, "node_modules", ".bin", "tsx.cmd");
const CLI = join(ROOT, "bin", "cli.ts");
const RESULTS_DIR = join(ROOT, "bench-runs", "tool-supervision");
const RESULTS_JSON = join(RESULTS_DIR, "integration-results.json");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ToolCall =
  | { kind: "read"; filePath: string }
  | { kind: "grep"; pattern: string; path: string }
  | { kind: "bash"; command: string; description: string }
  | { kind: "edit"; filePath: string; oldString: string; newString: string }
  | { kind: "fs-edit"; filePath: string; newContent: string }; // simulates Edit via direct FS write + mtime bump

type DecisionTag = "free" | "warn" | "soft-redirect" | "block" | "skipped-blocked";

interface EventCounts {
  warned?: number;
  cache_hit?: number;
  allowed_after_edit?: number;
  would_block?: number;
  suppressed?: number;
}

interface Scenario {
  id: string;
  description: string;
  /** Tool sequence. Each entry routed through Pre + (if not blocked) Post. */
  sequence: ToolCall[];
  /** One per Pre call (excluding fs-edit which doesn't go through hooks). */
  expectedDecisions: DecisionTag[];
  expectedEvents: EventCounts;
}

interface ScenarioResult {
  id: string;
  description: string;
  expectedDecisions: DecisionTag[];
  actualDecisions: DecisionTag[];
  expectedEvents: EventCounts;
  actualEvents: EventCounts;
  pass: boolean;
  failures: string[];
}

// ---------------------------------------------------------------------------
// Scenarios (locked by PRE-REGISTRATION.md)
// ---------------------------------------------------------------------------

const FIXED_SESSION = "session-integration-0001";

function R(filePath: string): ToolCall {
  return { kind: "read", filePath };
}
function G(pattern: string, path: string): ToolCall {
  return { kind: "grep", pattern, path };
}
function B(command: string, description: string): ToolCall {
  return { kind: "bash", command, description };
}
function E(filePath: string, newContent: string): ToolCall {
  return { kind: "fs-edit", filePath, newContent };
}

const SCENARIOS: Scenario[] = [
  {
    id: "single-read",
    description: "1 Read of file a — no duplicate, no events.",
    sequence: [R("a.txt")],
    expectedDecisions: ["free"],
    expectedEvents: {},
  },
  {
    id: "read-read-warn",
    description: "2 identical Reads — second hits warn tier, systemMessage only.",
    sequence: [R("a.txt"), R("a.txt")],
    expectedDecisions: ["free", "warn"],
    expectedEvents: { warned: 1 },
  },
  {
    id: "read-read-read-soft",
    description: "3 identical Reads — third hits soft-redirect (decision:block).",
    sequence: [R("a.txt"), R("a.txt"), R("a.txt")],
    expectedDecisions: ["free", "warn", "soft-redirect"],
    expectedEvents: { warned: 2, cache_hit: 1 },
  },
  {
    id: "edit-bypass",
    description: "Read → fs-edit (mtime bump) → Read. Second Read bypasses via allowed_after_edit.",
    sequence: [R("a.txt"), E("a.txt", "post-edit\n"), R("a.txt")],
    expectedDecisions: ["free", "free"], // fs-edit skipped (not routed); only 2 actual hook calls
    expectedEvents: { allowed_after_edit: 1 },
  },
  {
    id: "dup-then-edit-then-read",
    description: "Read → Read (warn) → fs-edit → Read. Post-edit Read uses bypass.",
    sequence: [R("a.txt"), R("a.txt"), E("a.txt", "post-edit\n"), R("a.txt")],
    expectedDecisions: ["free", "warn", "free"],
    expectedEvents: { warned: 1, allowed_after_edit: 1 },
  },
  {
    id: "bash-not-supervised",
    description: "3 identical Bash calls — never blocked. 2nd attaches legacy reuse-hint systemMessage (warn tag, NOT block). 3rd is suppressed.",
    sequence: [
      B("ls -la", "list files"),
      B("ls -la", "list files"),
      B("ls -la", "list files"),
    ],
    // Amendment 1 to PRE-REGISTRATION.md: legacy path attaches systemMessage
    // on first-hit non-safe-read duplicates. This is a visible badge, NOT a
    // tool-call interception. The substantive safety claim (Bash never gets
    // decision:"block") is verified by the absence of "block"/"soft-redirect"
    // tags in this sequence.
    expectedDecisions: ["free", "warn", "free"],
    expectedEvents: { warned: 1, suppressed: 1 },
  },
  {
    id: "distinct-reads-null",
    description: "Read a, Read b, Read c — all distinct argKeys; no duplicates detected.",
    sequence: [R("a.txt"), R("b.txt"), R("c.txt")],
    expectedDecisions: ["free", "free", "free"],
    expectedEvents: {},
  },
  {
    id: "grep-grep-grep-soft",
    description: "3 identical Greps — search family, same tier ladder as Read but no mtime bypass.",
    sequence: [
      G("foo", "src"),
      G("foo", "src"),
      G("foo", "src"),
    ],
    expectedDecisions: ["free", "warn", "soft-redirect"],
    expectedEvents: { warned: 2, cache_hit: 1 },
  },
];

// ---------------------------------------------------------------------------
// Workspace + config bootstrap
// ---------------------------------------------------------------------------

function makeWorkspace(id: string): string {
  const ws = join(tmpdir(), `tb-tool-sup-bench-${id}-${Date.now()}`);
  if (existsSync(ws)) rmSync(ws, { recursive: true, force: true });
  mkdirSync(ws, { recursive: true });
  // Touch the files we'll Read so fileMtimeMs works.
  for (const f of ["a.txt", "b.txt", "c.txt"]) {
    writeFileSync(join(ws, f), `initial ${f}\n`);
  }
  const cfg = initConfig(ws, { install: { agent: "claude-code", agents: ["claude-code"] } });
  const cfgPath = join(ws, ".tracebase", "config.json");
  const raw = JSON.parse(readFileSync(cfgPath, "utf-8"));
  raw.toolSupervision = { mode: "soft" };
  writeFileSync(cfgPath, JSON.stringify(raw, null, 2) + "\n");
  return ws;
}

// ---------------------------------------------------------------------------
// Hook invocations via the production CLIs
// ---------------------------------------------------------------------------

interface PreToolEnvelope {
  decision?: string;
  reason?: string;
  systemMessage?: string;
}

function preToolStdin(call: ToolCall, ws: string): string {
  const base = {
    hook_event_name: "PreToolUse",
    session_id: FIXED_SESSION,
    cwd: ws,
    permission_mode: "default",
  };
  switch (call.kind) {
    case "read":
      return JSON.stringify({ ...base, tool_name: "Read", tool_input: { file_path: join(ws, call.filePath) } });
    case "grep":
      return JSON.stringify({ ...base, tool_name: "Grep", tool_input: { pattern: call.pattern, path: join(ws, call.path) } });
    case "bash":
      return JSON.stringify({ ...base, tool_name: "Bash", tool_input: { command: call.command, description: call.description } });
    case "edit":
      return JSON.stringify({ ...base, tool_name: "Edit", tool_input: { file_path: join(ws, call.filePath), old_string: call.oldString, new_string: call.newString } });
    case "fs-edit":
      throw new Error("fs-edit calls must not go through hooks");
  }
}

function postToolStdin(call: ToolCall, ws: string): string {
  const base = {
    hook_event_name: "PostToolBatch",
    session_id: FIXED_SESSION,
    cwd: ws,
    permission_mode: "default",
  };
  let toolCall: unknown;
  switch (call.kind) {
    case "read":
      toolCall = { tool_name: "Read", tool_input: { file_path: join(ws, call.filePath) }, tool_response: { content: "<dummy>" } };
      break;
    case "grep":
      toolCall = { tool_name: "Grep", tool_input: { pattern: call.pattern, path: join(ws, call.path) }, tool_response: { matches: [] } };
      break;
    case "bash":
      toolCall = { tool_name: "Bash", tool_input: { command: call.command, description: call.description }, tool_response: { stdout: "<dummy>" } };
      break;
    case "edit":
      toolCall = { tool_name: "Edit", tool_input: { file_path: join(ws, call.filePath), old_string: call.oldString, new_string: call.newString }, tool_response: { success: true } };
      break;
    case "fs-edit":
      throw new Error("fs-edit calls must not go through hooks");
  }
  return JSON.stringify({ ...base, tool_calls: [toolCall] });
}

function invokeCli(args: string[], stdin: string): string {
  const child = spawnSync(TSX, [CLI, ...args], {
    cwd: ROOT,
    input: stdin,
    encoding: "utf-8",
    shell: process.platform === "win32",
    env: { ...process.env, TRACEBASE_DISABLED: "0", TRACEBASE_SKIP_HOOK_SELF_HEAL: "1" },
  });
  if ((child.status ?? 0) !== 0) {
    throw new Error(`CLI failed: ${args.join(" ")}\nstderr: ${child.stderr}`);
  }
  return child.stdout ?? "";
}

function callPreTool(call: ToolCall, ws: string): PreToolEnvelope {
  const stdin = preToolStdin(call, ws);
  const stdout = invokeCli(["capture-pre-tool-use", "--host", "claude-code", "--path", ws], stdin);
  try {
    return JSON.parse(stdout || "{}");
  } catch {
    return {};
  }
}

function callPostTool(call: ToolCall, ws: string): void {
  const stdin = postToolStdin(call, ws);
  invokeCli(["capture-tool-use", "--host", "claude-code", "--path", ws], stdin);
}

// ---------------------------------------------------------------------------
// fs-edit (simulates a real Edit via direct file write + explicit mtime bump)
// ---------------------------------------------------------------------------

function applyFsEdit(call: Extract<ToolCall, { kind: "fs-edit" }>, ws: string): void {
  const path = join(ws, call.filePath);
  writeFileSync(path, call.newContent);
  // Force mtime to be safely > Date.now() — file-mtime granularity on Windows
  // is fine but the test wants no chance of equal-stamps with prior obs ts.
  const future = (Date.now() + 5000) / 1000;
  utimesSync(path, future, future);
}

// ---------------------------------------------------------------------------
// Decision classification
// ---------------------------------------------------------------------------

function classifyDecision(env: PreToolEnvelope): DecisionTag {
  if (env.decision === "block") return env.reason?.includes("soft-redirect") || env.reason?.includes("Refer to that prior output") ? "soft-redirect" : "block";
  if (env.systemMessage) return "warn";
  return "free";
}

// ---------------------------------------------------------------------------
// Event extraction
// ---------------------------------------------------------------------------

function readEvents(ws: string): EventCounts {
  const dbPath = join(ws, ".tracebase", "memory.db");
  if (!existsSync(dbPath)) return {};
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare("SELECT payload FROM analytics_events")
      .all() as Array<{ payload: string }>;
    const counts: EventCounts = {};
    for (const r of rows) {
      let p: { event?: string } = {};
      try {
        p = JSON.parse(r.payload);
      } catch {
        continue;
      }
      if (!p.event?.startsWith("tool_supervision.")) continue;
      const key = p.event.replace("tool_supervision.", "") as keyof EventCounts;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Scenario runner
// ---------------------------------------------------------------------------

function runScenario(scenario: Scenario): ScenarioResult {
  const ws = makeWorkspace(scenario.id);
  const actualDecisions: DecisionTag[] = [];

  try {
    for (const call of scenario.sequence) {
      if (call.kind === "fs-edit") {
        applyFsEdit(call, ws);
        continue;
      }
      const env = callPreTool(call, ws);
      const tag = classifyDecision(env);
      actualDecisions.push(tag);
      if (tag === "soft-redirect" || tag === "block") {
        // Real Claude Code: blocked tools do NOT execute and PostToolUse
        // does NOT fire. Skip the post call to match production semantics.
        continue;
      }
      callPostTool(call, ws);
    }

    const actualEvents = readEvents(ws);

    const failures: string[] = [];

    // Decisions: exact sequence match.
    if (actualDecisions.length !== scenario.expectedDecisions.length) {
      failures.push(`decision count mismatch: expected ${scenario.expectedDecisions.length}, got ${actualDecisions.length}`);
    } else {
      for (let i = 0; i < actualDecisions.length; i++) {
        if (actualDecisions[i] !== scenario.expectedDecisions[i]) {
          failures.push(`decision[${i}] mismatch: expected ${scenario.expectedDecisions[i]}, got ${actualDecisions[i]}`);
        }
      }
    }

    // Events: exact match on every key in expected; absent keys must be 0 in actual.
    const allEventKeys = new Set<keyof EventCounts>([
      ...(Object.keys(scenario.expectedEvents) as Array<keyof EventCounts>),
      ...(Object.keys(actualEvents) as Array<keyof EventCounts>),
    ]);
    for (const key of allEventKeys) {
      const exp = scenario.expectedEvents[key] ?? 0;
      const got = actualEvents[key] ?? 0;
      if (exp !== got) failures.push(`events[${key}] mismatch: expected ${exp}, got ${got}`);
    }

    return {
      id: scenario.id,
      description: scenario.description,
      expectedDecisions: scenario.expectedDecisions,
      actualDecisions,
      expectedEvents: scenario.expectedEvents,
      actualEvents,
      pass: failures.length === 0,
      failures,
    };
  } finally {
    try {
      rmSync(ws, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log("03 Tool Supervision — Path B integration test");
console.log(`Scenarios: ${SCENARIOS.length}`);
console.log("");

const results: ScenarioResult[] = [];
let allPass = true;
for (const scenario of SCENARIOS) {
  const r = runScenario(scenario);
  results.push(r);
  const status = r.pass ? "PASS" : "FAIL";
  console.log(`[${status}] ${r.id}  (${r.description})`);
  if (!r.pass) {
    allPass = false;
    for (const f of r.failures) console.log(`         ${f}`);
    console.log(`         actualDecisions: ${JSON.stringify(r.actualDecisions)}`);
    console.log(`         actualEvents: ${JSON.stringify(r.actualEvents)}`);
  }
}

mkdirSync(RESULTS_DIR, { recursive: true });
writeFileSync(RESULTS_JSON, JSON.stringify({
  version: "tracebase 0.9.0",
  bench: "03 tool-supervision (Path B synthetic integration)",
  pre_registration: "bench-runs/tool-supervision/PRE-REGISTRATION.md",
  mode: "soft",
  n_scenarios: results.length,
  n_pass: results.filter((r) => r.pass).length,
  n_fail: results.filter((r) => !r.pass).length,
  all_pass: allPass,
  results,
}, null, 2) + "\n");

console.log("");
console.log(`Pass: ${results.filter((r) => r.pass).length} / ${results.length}`);
console.log(`Wrote ${RESULTS_JSON}`);
process.exit(allPass ? 0 : 1);
