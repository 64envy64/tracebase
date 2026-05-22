#!/usr/bin/env node
/**
 * `tsx scripts/demo-real-runner.ts --task <id> --variant <off|on>`
 *
 * Real-agent recording runner for the YC demo. Builds a fresh
 * Anthropic message loop with three workspace-sandboxed tools
 * (read_file, edit_file, run_bash) and runs it against the task's
 * BROKEN starting state (`demo-tasks/<id>/state-off/`). The OFF
 * variant runs bare. The ON variant:
 *
 *   - spins up an in-memory `BlockStore`,
 *   - seeds it with `demo-tasks/<id>/seeded-patterns.json`,
 *   - calls `runReasoningPatternsRecall` against the user prompt,
 *   - prepends the recalled `<tracebase>` block to the system prompt,
 *   - blocks any tool call whose (name, arg-hash) appears 3 times in
 *     a row (the same supervision contract as production
 *     block-after-N).
 *
 * Token accounting is real — taken straight from each Anthropic
 * response's `usage.input_tokens` / `output_tokens`. A per-response
 * char/4 fallback runs only when usage is missing on a particular
 * response; if any response triggered the fallback, the whole
 * artifact is labelled `tokens.source = "estimate"`. Estimated
 * numbers are NEVER presented as provider-reported.
 *
 * Verifier exit code is real (the task's `check.sh` runs against the
 * agent's actual workspace state at end-of-loop).
 *
 * Output: `demo-runs/real/<task>/<variant>.json` with
 * `source: "real"`. Requires `ANTHROPIC_API_KEY` in env — the runner
 * exits 2 if it's missing. There is no synthetic fallback path; the
 * synthetic fixtures were removed from the repo on 2026-05-23.
 *
 * Recording: this script logs every turn to stdout in a stable
 * one-line format (turn, tool, arg-hash, blocked / exit-status).
 * Combine with `script(1)` or `asciinema rec` on the surrounding
 * terminal session to capture the operator's view for an external
 * demo.
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, normalize, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { request as httpsRequest } from "node:https";
import Database from "better-sqlite3";
import { BlockStore } from "../src/core/block-store.js";
import { BlockServer } from "../src/core/block-serving.js";
import { createBlock } from "../src/core/block.js";
import { runReasoningPatternsRecall } from "../src/server/reasoning-patterns-entry.js";
import type { StoreBlockInput } from "../src/types.js";
import type {
  RunArtifact,
  TaskDefinition,
  TokenUsage,
  TraceBaseTelemetry,
  Variant,
  VerifierResult,
} from "../src/demo/types.js";

const TASKS_DIR = resolve("demo-tasks");
const REAL_RUNS_DIR = resolve("demo-runs/real");

const DEFAULT_MAX_TURNS = 20;
const DEFAULT_RESPONSE_MAX_TOKENS = 4096;
const BLOCK_AFTER_N = 3;
const BASH_TIMEOUT_MS = 30_000;
const BASH_OUTPUT_LIMIT = 4000;
const FILE_READ_LIMIT = 100_000;

const SYSTEM_PROMPT_BASE =
  "You are a software engineering agent. Your working directory is the workspace.\n" +
  "Use read_file, edit_file, and run_bash to investigate and fix the bug.\n" +
  "Edits use exact string replacement — pick a unique old_string snippet.\n" +
  "When the verifier passes, reply with a one-sentence summary instead of more tool calls.";

interface AnthropicToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

const TOOLS: AnthropicToolDef[] = [
  {
    name: "read_file",
    description:
      "Read a file from the workspace. Returns full text content (capped at " +
      `${FILE_READ_LIMIT} chars).`,
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative path" },
      },
      required: ["path"],
    },
  },
  {
    name: "edit_file",
    description:
      "Replace exactly one occurrence of old_string with new_string in a workspace file. " +
      "Errors if old_string is missing or appears more than once.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "run_bash",
    description:
      "Run a bash command in the workspace. Returns combined stdout+stderr " +
      `(truncated to ${BASH_OUTPUT_LIMIT} chars) and the exit code. Timeout ${BASH_TIMEOUT_MS}ms.`,
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
];

interface ParsedArgs {
  task: string;
  variant: Variant;
  modelOverride?: string;
  maxTurnsOverride?: number;
}

function arg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function usage(): never {
  console.error(
    "Usage: tsx scripts/demo-real-runner.ts --task <id> --variant <off|on>\n" +
      "       [--model <name>] [--max-turns <N>]\n\n" +
      "ANTHROPIC_API_KEY must be set. Output: demo-runs/real/<task>/<variant>.json.\n" +
      "The OFF variant runs bare; the ON variant pre-recalls a seeded pattern\n" +
      "and runs supervised (block-after-N for repeated tool calls).",
  );
  process.exit(2);
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  const task = arg(args, "--task");
  const variant = arg(args, "--variant");
  if (!task || !variant) usage();
  if (variant !== "off" && variant !== "on") {
    console.error(`--variant must be off or on; got ${variant}`);
    process.exit(2);
  }
  const maxTurnsRaw = arg(args, "--max-turns");
  const maxTurnsOverride = maxTurnsRaw ? parseInt(maxTurnsRaw, 10) : undefined;
  if (maxTurnsOverride !== undefined && !Number.isFinite(maxTurnsOverride)) {
    console.error(`--max-turns must be a number; got ${maxTurnsRaw}`);
    process.exit(2);
  }
  return {
    task: task!,
    variant: variant as Variant,
    modelOverride: arg(args, "--model"),
    maxTurnsOverride,
  };
}

function loadTask(task: string): TaskDefinition {
  const path = join(TASKS_DIR, task, "task.json");
  if (!existsSync(path)) {
    console.error(`No task at ${path}`);
    process.exit(2);
  }
  return JSON.parse(readFileSync(path, "utf-8")) as TaskDefinition;
}

function resetWorkspaceToBroken(task: string, variant: Variant): string {
  // BOTH variants start from state-off — the broken state. The
  // agent's job is to fix it. state-on/ is kept as a known-good
  // verifier-PASS reference so check.sh can be smoke-tested; the
  // real-agent runner must never start from a pre-fixed workspace.
  const stateDir = join(TASKS_DIR, task, "state-off");
  if (!existsSync(stateDir)) {
    console.error(`No state directory at ${stateDir}`);
    process.exit(2);
  }
  const workspace = join(REAL_RUNS_DIR, task, `${variant}-workspace`);
  if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });
  cpSync(stateDir, workspace, { recursive: true });
  return workspace;
}

// ---------------------------------------------------------------------------
// Tool execution — every path argument is validated to stay inside the
// workspace; ../escape attempts return an is_error result.
// ---------------------------------------------------------------------------

function safeWorkspacePath(workspace: string, rel: string): string | null {
  if (typeof rel !== "string" || rel.length === 0) return null;
  // Reject absolute paths and any segment that climbs out of workspace.
  if (rel.startsWith("/") || rel.startsWith(sep)) return null;
  const joined = normalize(join(workspace, rel));
  const wsNorm = normalize(workspace) + sep;
  if (!joined.startsWith(wsNorm) && joined !== normalize(workspace)) return null;
  return joined;
}

interface ToolOutcome {
  content: string;
  is_error: boolean;
}

function execReadFile(workspace: string, input: Record<string, unknown>): ToolOutcome {
  const rel = String(input.path ?? "");
  const full = safeWorkspacePath(workspace, rel);
  if (full === null) return { content: `read_file: invalid path ${rel}`, is_error: true };
  if (!existsSync(full)) return { content: `read_file: not found ${rel}`, is_error: true };
  try {
    const data = readFileSync(full, "utf-8");
    if (data.length > FILE_READ_LIMIT) {
      return {
        content: data.slice(0, FILE_READ_LIMIT) + `\n…(truncated at ${FILE_READ_LIMIT} chars)`,
        is_error: false,
      };
    }
    return { content: data, is_error: false };
  } catch (e) {
    return { content: `read_file: ${(e as Error).message}`, is_error: true };
  }
}

function execEditFile(workspace: string, input: Record<string, unknown>): ToolOutcome {
  const rel = String(input.path ?? "");
  const oldStr = String(input.old_string ?? "");
  const newStr = String(input.new_string ?? "");
  const full = safeWorkspacePath(workspace, rel);
  if (full === null) return { content: `edit_file: invalid path ${rel}`, is_error: true };
  if (!existsSync(full)) return { content: `edit_file: not found ${rel}`, is_error: true };
  if (oldStr.length === 0)
    return { content: "edit_file: old_string must be non-empty", is_error: true };
  try {
    const before = readFileSync(full, "utf-8");
    const occurrences = before.split(oldStr).length - 1;
    if (occurrences === 0)
      return { content: "edit_file: old_string not found", is_error: true };
    if (occurrences > 1)
      return {
        content: `edit_file: old_string occurs ${occurrences} times — must be unique`,
        is_error: true,
      };
    const after = before.replace(oldStr, newStr);
    writeFileSync(full, after);
    return { content: `edit_file: replaced 1 occurrence in ${rel}`, is_error: false };
  } catch (e) {
    return { content: `edit_file: ${(e as Error).message}`, is_error: true };
  }
}

function execBash(workspace: string, input: Record<string, unknown>): ToolOutcome {
  const command = String(input.command ?? "");
  if (command.length === 0) return { content: "run_bash: empty command", is_error: true };
  try {
    const proc = spawnSync(command, {
      cwd: workspace,
      shell: true,
      encoding: "utf-8",
      timeout: BASH_TIMEOUT_MS,
    });
    const exit = typeof proc.status === "number" ? proc.status : 1;
    let body = (proc.stdout ?? "") + (proc.stderr ?? "");
    if (body.length > BASH_OUTPUT_LIMIT) {
      body = body.slice(0, BASH_OUTPUT_LIMIT) + `\n…(truncated at ${BASH_OUTPUT_LIMIT} chars)`;
    }
    return {
      content: `exit=${exit}\n${body}`,
      // is_error=false even on non-zero exit — the agent uses the exit
      // code as a signal, not a tool failure.
      is_error: false,
    };
  } catch (e) {
    return { content: `run_bash: ${(e as Error).message}`, is_error: true };
  }
}

function executeTool(name: string, input: Record<string, unknown>, workspace: string): ToolOutcome {
  switch (name) {
    case "read_file":
      return execReadFile(workspace, input);
    case "edit_file":
      return execEditFile(workspace, input);
    case "run_bash":
      return execBash(workspace, input);
    default:
      return { content: `unknown tool ${name}`, is_error: true };
  }
}

// ---------------------------------------------------------------------------
// Anthropic API — raw https.request, no SDK dependency.
// ---------------------------------------------------------------------------

interface AnthropicMessage {
  role: "user" | "assistant";
  content: unknown;
}

interface AnthropicResponse {
  content: Array<Record<string, unknown>>;
  stop_reason: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message: string };
}

function callAnthropic(
  model: string,
  system: string,
  messages: AnthropicMessage[],
  apiKey: string,
): Promise<AnthropicResponse> {
  return new Promise((resolveP, rejectP) => {
    const body = JSON.stringify({
      model,
      max_tokens: DEFAULT_RESPONSE_MAX_TOKENS,
      system,
      tools: TOOLS,
      messages,
    });
    const req = httpsRequest(
      {
        hostname: "api.anthropic.com",
        path: "/v1/messages",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data) as AnthropicResponse;
            if (parsed.error) {
              rejectP(new Error(`Anthropic: ${parsed.error.message}`));
              return;
            }
            resolveP(parsed);
          } catch (e) {
            rejectP(new Error(`Anthropic parse: ${(e as Error).message}`));
          }
        });
      },
    );
    req.on("error", rejectP);
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// ON-mode: in-memory recall + directive build.
// ---------------------------------------------------------------------------

interface OnInjection {
  directive: string;
  queryId: string;
  injectedTokens: number;
  overheadMs: number;
}

function buildOnInjection(taskId: string, taskDef: TaskDefinition, taskPrompt: string): OnInjection | null {
  const seedRel = taskDef.seededPatterns;
  if (!seedRel) return null;
  const seedPath = join(TASKS_DIR, taskId, seedRel);
  if (!existsSync(seedPath)) {
    console.warn(`ON-mode: seeded patterns missing at ${seedPath} — proceeding without injection`);
    return null;
  }
  const start = performance.now();
  const seeds = JSON.parse(readFileSync(seedPath, "utf-8")) as { patterns: StoreBlockInput[] };
  const db = new Database(":memory:");
  try {
    const store = new BlockStore(db);
    for (const p of seeds.patterns) {
      const block = createBlock(p);
      block.status = "candidate";
      store.storeBlock(block);
      store.attachCaseRef({
        blockId: block.id,
        traceId: `seed-${block.id}`,
        role: "origin",
        evidenceQuality: "strong",
      });
      store.updateBlockStatus(block.id, "active");
    }
    const server = new BlockServer(store);
    const recall = runReasoningPatternsRecall(
      server,
      { problem: taskPrompt },
      { readHoldoutConfig: () => null },
    );
    const overheadMs = Math.round(performance.now() - start);
    if (!recall.shouldInject || recall.blocks.length === 0) return null;
    const top = recall.blocks[0]!;
    const directive =
      `<tracebase queryId="${recall.queryId}">\n` +
      `<situation>${top.block.trigger.situation}</situation>\n` +
      `<unlock>${top.block.body.unlock}</unlock>\n` +
      `<verification>${top.block.body.verification}</verification>\n` +
      `</tracebase>`;
    return {
      directive,
      queryId: recall.queryId,
      injectedTokens: Math.ceil(directive.length / 4),
      overheadMs,
    };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

interface LoopResult {
  startedAt: number;
  wallClockMs: number;
  tokens: TokenUsage;
  toolCalls: { total: number; duplicates: number; byName: Record<string, number> };
  tracebase: TraceBaseTelemetry | null;
  stopReason: string;
}

function hashArgs(name: string, input: unknown): string {
  return createHash("sha256")
    .update(name + "::" + JSON.stringify(input))
    .digest("hex")
    .slice(0, 16);
}

async function runAgentLoop(opts: {
  task: string;
  variant: Variant;
  model: string;
  maxTurns: number;
  workspace: string;
  taskPrompt: string;
  injection: OnInjection | null;
  apiKey: string;
}): Promise<LoopResult> {
  const { variant, model, maxTurns, workspace, taskPrompt, injection, apiKey } = opts;
  const systemPrompt = injection
    ? SYSTEM_PROMPT_BASE + "\n\n" + injection.directive
    : SYSTEM_PROMPT_BASE;

  const messages: AnthropicMessage[] = [{ role: "user", content: taskPrompt }];
  let inputTokens = 0;
  let outputTokens = 0;
  let estimateUsed = false;
  const toolCallLog: Array<{ name: string; argHash: string }> = [];
  let blockedToolCalls = 0;
  let stopReason = "max_turns";

  const startedAt = Date.now();
  const startPerf = performance.now();

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await callAnthropic(model, systemPrompt, messages, apiKey);
    const inT = response.usage?.input_tokens ?? 0;
    const outT = response.usage?.output_tokens ?? 0;
    if (response.usage === undefined || (inT === 0 && outT === 0)) {
      // Provider did not report usage on this response — fall back to
      // char/4 estimate over the response's text content. Surface this
      // up by flipping `estimateUsed`; the artifact's token source
      // becomes "estimate" if any response triggered the fallback.
      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => String((b as { text?: unknown }).text ?? ""))
        .join("");
      outputTokens += Math.ceil(text.length / 4);
      estimateUsed = true;
    } else {
      inputTokens += inT;
      outputTokens += outT;
    }

    const content = response.content;
    const toolUseBlocks = content.filter((b) => b.type === "tool_use");
    if (toolUseBlocks.length === 0 || response.stop_reason === "end_turn") {
      stopReason = response.stop_reason ?? "end_turn";
      console.log(`[turn ${turn}] end (stop_reason=${stopReason})`);
      break;
    }

    messages.push({ role: "assistant", content });

    const toolResults: unknown[] = [];
    for (const block of toolUseBlocks) {
      const name = String((block as { name?: unknown }).name ?? "");
      const id = String((block as { id?: unknown }).id ?? "");
      const input = ((block as { input?: unknown }).input ?? {}) as Record<string, unknown>;
      const argHash = hashArgs(name, input);

      let blocked = false;
      if (variant === "on") {
        const recent = toolCallLog.slice(-BLOCK_AFTER_N).filter(
          (c) => c.name === name && c.argHash === argHash,
        );
        if (recent.length >= BLOCK_AFTER_N) {
          blocked = true;
          blockedToolCalls++;
        }
      }

      let outcome: ToolOutcome;
      if (blocked) {
        outcome = {
          content:
            `▣ TraceBase supervision: this tool call (${name}) with these arguments has run ` +
            `${BLOCK_AFTER_N}+ times in a row. Try a different approach — read a different file, ` +
            `run a different command, or finalize your fix.`,
          is_error: false,
        };
      } else {
        outcome = executeTool(name, input, workspace);
      }
      toolCallLog.push({ name, argHash });
      console.log(
        `[turn ${turn}] tool=${name} argHash=${argHash.slice(0, 8)} ${
          blocked ? "BLOCKED" : `is_error=${outcome.is_error}`
        }`,
      );

      toolResults.push({
        type: "tool_result",
        tool_use_id: id,
        content: outcome.content,
        is_error: outcome.is_error,
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  const wallClockMs = Math.round(performance.now() - startPerf);

  const total = toolCallLog.length;
  const byName: Record<string, number> = {};
  let duplicates = 0;
  for (let i = 0; i < toolCallLog.length; i++) {
    const c = toolCallLog[i]!;
    byName[c.name] = (byName[c.name] ?? 0) + 1;
    if (i > 0) {
      const prev = toolCallLog[i - 1]!;
      if (prev.name === c.name && prev.argHash === c.argHash) duplicates++;
    }
  }

  const tokens: TokenUsage = {
    input: inputTokens,
    output: outputTokens,
    total: inputTokens + outputTokens,
    source: estimateUsed ? "estimate" : "provider",
  };

  const tracebase: TraceBaseTelemetry | null =
    variant === "on"
      ? {
          injectedTokens: opts.injection?.injectedTokens ?? 0,
          overheadMs: opts.injection?.overheadMs ?? 0,
          queryIds: opts.injection ? [opts.injection.queryId] : [],
          blockedToolCalls,
        }
      : null;

  return {
    startedAt,
    wallClockMs,
    tokens,
    toolCalls: { total, duplicates, byName },
    tracebase,
    stopReason,
  };
}

// ---------------------------------------------------------------------------
// Verifier
// ---------------------------------------------------------------------------

function runVerifier(workspace: string, command: string): VerifierResult {
  const start = performance.now();
  const proc = spawnSync(command, {
    cwd: workspace,
    shell: true,
    encoding: "utf-8",
    timeout: BASH_TIMEOUT_MS,
  });
  const elapsed = Math.round(performance.now() - start);
  const exitCode = typeof proc.status === "number" ? proc.status : 1;
  const output = ((proc.stdout ?? "") + (proc.stderr ?? "")).slice(0, 500);
  const pass = exitCode === 0;
  console.log(`Verifier finished in ${elapsed}ms — exit ${exitCode} (${pass ? "PASS" : "FAIL"})`);
  return { command, exitCode, pass, outputExcerpt: output };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey.length === 0) {
    console.error(
      "ANTHROPIC_API_KEY is required for the real-agent runner. Set it in the\n" +
        "environment and re-run. There is no synthetic fallback — the synthetic\n" +
        "fixtures and harness were removed on 2026-05-23.",
    );
    process.exit(2);
  }

  const { task, variant, modelOverride, maxTurnsOverride } = parseArgs();
  const taskDef = loadTask(task);
  const model = modelOverride ?? taskDef.model;
  const maxTurns = maxTurnsOverride ?? taskDef.maxTurns ?? DEFAULT_MAX_TURNS;

  if (!taskDef.prompt) {
    console.error(`task.json for ${task} is missing a "prompt" path`);
    process.exit(2);
  }
  const promptPath = join(TASKS_DIR, task, taskDef.prompt);
  if (!existsSync(promptPath)) {
    console.error(`prompt file not found at ${promptPath}`);
    process.exit(2);
  }
  const taskPrompt = readFileSync(promptPath, "utf-8").trim();

  console.log(`Task: ${task}`);
  console.log(`Variant: ${variant}`);
  console.log(`Model: ${model}`);
  console.log(`Max turns: ${maxTurns}`);

  const workspace = resetWorkspaceToBroken(task, variant);
  console.log(`Workspace: ${workspace}`);

  const injection = variant === "on" ? buildOnInjection(task, taskDef, taskPrompt) : null;
  if (variant === "on") {
    console.log(
      injection
        ? `ON-mode injection ready — queryId=${injection.queryId} injectedTokens=${injection.injectedTokens}`
        : "ON-mode injection: no match — running ON without prepended directive",
    );
  }

  const loop = await runAgentLoop({
    task,
    variant,
    model,
    maxTurns,
    workspace,
    taskPrompt,
    injection,
    apiKey,
  });

  const verifier = runVerifier(workspace, taskDef.verifier);

  const artifact: RunArtifact = {
    task,
    variant,
    source: "real",
    timestamp: loop.startedAt,
    model,
    wallClockMs: loop.wallClockMs,
    tokens: loop.tokens,
    toolCalls: loop.toolCalls,
    tracebase: loop.tracebase,
    verifier,
    notes:
      `real-agent recording — model=${model} maxTurns=${maxTurns} ` +
      `stopReason=${loop.stopReason}`,
  };

  const outDir = join(REAL_RUNS_DIR, task);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${variant}.json`);
  writeFileSync(outPath, JSON.stringify(artifact, null, 2) + "\n");
  console.log(`Wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
