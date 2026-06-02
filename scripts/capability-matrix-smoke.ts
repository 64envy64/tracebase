/**
 * $0 integrated workspace smoke for the five public runtime capabilities:
 *
 *   reasoning reuse + semantic file memory + loop detection +
 *   tool supervision + context compression.
 *
 * It drives the real hook helpers against one fresh local workspace, verifies
 * the canonical managed-hook graph before and after, and asserts that no
 * workspace absolute path leaks into injected context.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { BlockStore } from "../src/core/block-store.js";
import { createBlock } from "../src/core/block.js";
import { initConfig } from "../src/core/config.js";
import {
  hookEventsForAgent,
  inspectAgentHookConfig,
  writeAgentHookConfig,
} from "../src/cli/install-targets.js";
import { runCaptureToolUse } from "../src/cli/commands/capture-tool-use.js";
import { runCapturePreToolUse } from "../src/cli/commands/capture-pre-tool-use.js";
import { runInjectContext } from "../src/cli/commands/inject-context.js";
import type { StoreBlockInput } from "../src/types.js";

export interface CapabilityMatrixSmokeResult {
  hooks: string[];
  contextSections: string[];
  preToolWarned: boolean;
  loopBadge: boolean;
  absolutePathLeak: boolean;
}

function seedWorkspace(projectDir: string, storagePath: string): void {
  mkdirSync(join(projectDir, "src"), { recursive: true });
  writeFileSync(join(projectDir, "src", "auth-shadow.ts"), "export const authShadow = true;\n", "utf8");
  const db = new Database(storagePath);
  const store = new BlockStore(db);
  try {
    const block = createBlock({
      trigger: {
        situation: "Pytest collects the wrong auth helper because sys.path resolves a shadow package",
        invariants: { language: "python", framework: "pytest" },
      },
      body: {
        mechanism: "an earlier sys.path entry shadows the intended auth helper package",
        deadEnds: [],
        unlock: "remove the shadow directory from sys.path before pytest collection",
        verification: "pytest --collect-only resolves the intended auth helper",
      },
      provenance: {
        sourceTaskId: "capability-matrix-smoke",
        extractedFrom: "trajectory",
        distilledBy: "rule",
      },
    } satisfies StoreBlockInput);
    block.status = "candidate";
    store.storeBlock(block);
    store.attachCaseRef({
      blockId: block.id,
      traceId: "capability-matrix-origin",
      role: "origin",
      evidenceQuality: "strong",
    });
    store.updateBlockStatus(block.id, "active");

    const now = Date.now();
    store.rawDb
      .prepare(
        `INSERT INTO indexed_files
           (id, rel_path, hash, language, size_bytes, summary, symbols, summarizer, indexed_at, updated_at)
         VALUES
           ('capability-file', 'src/auth-shadow.ts', 'capability-hash', 'ts', 128,
            'Pytest sys.path shadow auth helper package resolution and collection guard.',
            'authShadow', 'heuristic', ?, ?)`,
      )
      .run(now, now);

    store.recordSessionChunks([
      {
        sessionId: "capability-session",
        chunkStartTurn: 0,
        chunkEndTurn: 7,
        turnHash: "capability-context-fold",
        summary: "Investigated pytest sys.path shadow auth helper package resolution during collection.",
        tokensBefore: 4_000,
        tokensAfter: 220,
        summarizer: "heuristic",
        expiresAt: now + 14 * 86_400_000,
      },
    ]);
  } finally {
    store.close();
  }
}

export async function runCapabilityMatrixSmoke(): Promise<CapabilityMatrixSmokeResult> {
  const projectDir = mkdtempSync(join(tmpdir(), "tb-capability-matrix-"));
  const previousSelfHeal = process.env.TRACEBASE_SKIP_HOOK_SELF_HEAL;
  process.env.TRACEBASE_SKIP_HOOK_SELF_HEAL = "1";
  try {
    const config = initConfig(projectDir);
    const hookWrite = writeAgentHookConfig(projectDir, "claude-code", false);
    assert.ok(hookWrite?.ok, "fresh workspace hook graph must install cleanly");
    const hooks = hookEventsForAgent("claude-code");
    const before = inspectAgentHookConfig(projectDir, "claude-code");
    assert.equal(before.canonical, true, "all managed hooks must be canonical before the turn");
    assert.deepEqual(Object.keys(before.events), hooks);

    seedWorkspace(projectDir, config.storagePath);
    const filePath = join(projectDir, "src", "auth-shadow.ts");
    const batch = Buffer.from(
      JSON.stringify({
        session_id: "capability-session",
        cwd: projectDir,
        tool_calls: [0, 1, 2].map((n) => ({
          tool_name: "Read",
          tool_input: { file_path: filePath },
          tool_use_id: `read-${n}`,
          outcome: "success",
        })),
      }),
      "utf8",
    );
    const observed = runCaptureToolUse({ path: projectDir }, batch);
    assert.equal(observed.recorded, 3, "PostToolBatch must record three sanitized observations");

    const preTool = runCapturePreToolUse(
      { path: projectDir },
      Buffer.from(
        JSON.stringify({
          session_id: "capability-session",
          cwd: projectDir,
          tool_name: "Read",
          tool_input: { file_path: filePath },
        }),
        "utf8",
      ),
    );
    assert.equal(preTool.warned, true, "PreToolUse must warn before the fourth duplicate safe read");

    const injected = await runInjectContext(
      { path: projectDir },
      {
        prompt: "Continue fixing the pytest sys.path shadow auth helper package resolution during collection",
        session_id: "capability-session",
      },
    );
    const envelope = JSON.parse(injected.envelope) as {
      systemMessage?: string;
      hookSpecificOutput?: { additionalContext?: string };
    };
    const additionalContext = envelope.hookSpecificOutput?.additionalContext ?? "";
    const contextSections = ["<tracebase", "<file_memory>", "<context_fold>"].filter((needle) =>
      additionalContext.includes(needle),
    );
    assert.deepEqual(
      contextSections,
      ["<tracebase", "<file_memory>", "<context_fold>"],
      "one prompt must compose reasoning reuse, file memory, and context compression",
    );
    const loopBadge = /TB LOOP/.test(envelope.systemMessage ?? "");
    assert.equal(loopBadge, true, "UserPromptSubmit must surface the prior straight-loop badge");
    const absolutePathLeak = additionalContext.includes(projectDir);
    assert.equal(absolutePathLeak, false, "injected context must not contain the workspace absolute path");

    const after = inspectAgentHookConfig(projectDir, "claude-code");
    assert.equal(after.canonical, true, "runtime execution must preserve the canonical hook graph");
    assert.deepEqual(after.events, before.events, "runtime execution must not contaminate managed hooks");

    return {
      hooks,
      contextSections,
      preToolWarned: preTool.warned,
      loopBadge,
      absolutePathLeak,
    };
  } finally {
    if (previousSelfHeal === undefined) delete process.env.TRACEBASE_SKIP_HOOK_SELF_HEAL;
    else process.env.TRACEBASE_SKIP_HOOK_SELF_HEAL = previousSelfHeal;
    rmSync(projectDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runCapabilityMatrixSmoke()
    .then((result) => {
      process.stdout.write(JSON.stringify({ ok: true, ...result }, null, 2) + "\n");
    })
    .catch((error: unknown) => {
      process.stderr.write(`capability-matrix-smoke: ${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    });
}
