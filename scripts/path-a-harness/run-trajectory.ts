#!/usr/bin/env tsx
/**
 * Path A harness: trajectory runner.
 *
 * Spawns one `claude --print --output-format json` child process in the
 * given workspace cwd, feeds the prompt via stdin, captures the structured
 * JSON result + exit + stderr.
 *
 * Spawn shape is locked by PRE-REGISTRATION-PATH-A.md §"Harness contract":
 *   --print
 *   --output-format json
 *   --model claude-haiku-4-5
 *   --permission-mode bypassPermissions
 *   --setting-sources project,local
 *   --session-id <uuid>
 *   --max-budget-usd 0.50
 *   --allowedTools Read,Edit,Bash
 *
 * Returns the parsed JSON envelope + the path to the per-instance
 * transcript that Claude Code writes at
 * `~/.claude/projects/<encoded-cwd>/<sid>.jsonl`.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CLAUDE_BIN = process.env.CLAUDE_CLI ?? "claude";

export interface TrajectoryResult {
  exitCode: number | null;
  stderr: string;
  rawStdout: string;
  parsed: Record<string, unknown> | null;
  transcriptPath: string | null;
}

function encodeCwdForClaudeProjects(cwd: string): string {
  // Claude Code encodes cwd for `~/.claude/projects/` by replacing each
  // path-separator-like character (`:`, `\`, `/`, `.`) individually with
  // `-`. Existing hyphens in path segments are preserved. E.g.:
  //   `C:\Users\Wave\Desktop\.claude\worktrees\interesting-mcclintock`
  // → `C--Users-Wave-Desktop--claude-worktrees-interesting-mcclintock`
  // (verified empirically against ~/.claude/projects/ on Windows).
  return cwd.replace(/[:\\/.]/g, "-");
}

export function runTrajectory(opts: {
  workspace: string;
  prompt: string;
  sessionId: string;
  model?: string;
  maxBudgetUsd?: number;
  allowedTools?: string;
  timeoutMs?: number;
}): TrajectoryResult {
  const {
    workspace,
    prompt,
    sessionId,
    model = "claude-haiku-4-5",
    maxBudgetUsd = 0.5,
    allowedTools = "Read,Edit,Bash",
    timeoutMs = 240_000,
  } = opts;

  const child = spawnSync(
    CLAUDE_BIN,
    [
      "--print",
      "--output-format", "json",
      "--model", model,
      "--permission-mode", "bypassPermissions",
      "--setting-sources", "project,local",
      "--session-id", sessionId,
      "--max-budget-usd", String(maxBudgetUsd),
      "--allowedTools", allowedTools,
    ],
    {
      cwd: workspace,
      encoding: "utf-8",
      shell: process.platform === "win32",
      input: prompt,
      timeout: timeoutMs,
    },
  );

  let parsed: Record<string, unknown> | null = null;
  try { parsed = JSON.parse(child.stdout ?? "{}"); } catch { /* keep null */ }

  // Locate transcript (best-effort; may not exist if claude failed early).
  const encoded = encodeCwdForClaudeProjects(workspace);
  const candidate = join(homedir(), ".claude", "projects", encoded, `${sessionId}.jsonl`);
  const transcriptPath = existsSync(candidate) ? candidate : null;

  return {
    exitCode: child.status,
    stderr: child.stderr ?? "",
    rawStdout: child.stdout ?? "",
    parsed,
    transcriptPath,
  };
}

// CLI: tsx scripts/path-a-harness/run-trajectory.ts <workspace> <session-id> <prompt-file>
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  const [ws, sid, promptFile] = process.argv.slice(2);
  if (!ws || !sid || !promptFile) {
    console.error("usage: run-trajectory.ts <workspace> <session-id> <prompt-file>");
    process.exit(2);
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const prompt = readFileSync(promptFile, "utf-8");
  const result = runTrajectory({ workspace: ws, prompt, sessionId: sid });
  console.log(JSON.stringify({
    exitCode: result.exitCode,
    transcriptPath: result.transcriptPath,
    parsedKeys: result.parsed ? Object.keys(result.parsed) : [],
    stderrTail: result.stderr.split("\n").slice(-10).join("\n"),
  }, null, 2));
}
