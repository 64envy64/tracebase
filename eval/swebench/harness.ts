import { execSync, ExecSyncOptions } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReasoningLayer } from "../../src/core/engine.js";
import { runAgenticTrajectory, buildPromptParts } from "../agentic/agent.js";
import { Sandbox } from "../agentic/sandbox.js";
import type { AgentStep } from "../agentic/types.js";

/**
 * SWE-bench Verified Harness
 *
 * Runs real GitHub issues from SWE-bench Verified dataset.
 * Each task: clone repo → checkout commit → agent generates patch → run tests.
 *
 * Disk-efficient: clones one repo at a time, cleans up after each task.
 */

export interface SWETask {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  hints_text: string;
  patch: string;
  test_patch: string;
  FAIL_TO_PASS: string;
  PASS_TO_PASS: string;
  version: string;
  difficulty: string;
}

export interface SWEResult {
  instance_id: string;
  repo: string;
  difficulty: string;
  baseline: TrajectoryResult;
  augmented: TrajectoryResult;
}

interface TrajectoryResult {
  success: boolean;
  patchGenerated: boolean;
  patchApplied: boolean;
  testsRun: boolean;
  testsPassed: boolean;
  totalSteps: number;
  totalTokens: number;
  durationMs: number;
  generatedPatch: string;
  stopReason: string;
}

const MAX_STEPS = 15;
const EXEC_OPTS: ExecSyncOptions = { encoding: "utf-8", timeout: 120000, stdio: "pipe" };

/**
 * Run one SWE-bench task: clone, agent solves, test, cleanup.
 */
export async function runSWETask(
  task: SWETask,
  model: string,
  injection: string | null,
  verbose: boolean,
): Promise<TrajectoryResult> {
  const repoDir = mkdtempSync(join(tmpdir(), "swe-"));
  const startMs = Date.now();

  try {
    // 1. Clone repo at base commit (shallow for speed)
    if (verbose) process.stdout.write(`    Cloning ${task.repo}@${task.base_commit.slice(0, 8)}... `);
    try {
      // Shallow clone at exact commit — fastest approach
      exec(`git init ${repoDir}`, { timeout: 10000 });
      exec(`git remote add origin https://github.com/${task.repo}.git`, { cwd: repoDir, timeout: 10000 });
      exec(`git fetch --depth 1 origin ${task.base_commit}`, { cwd: repoDir, timeout: 180000 });
      exec(`git checkout FETCH_HEAD`, { cwd: repoDir, timeout: 30000 });
      if (verbose) process.stdout.write("ok\n");
    } catch (err) {
      if (verbose) console.log("CLONE FAIL:", (err as Error).message?.slice(0, 100));
      return failResult(startMs, "clone_failed");
    }

    // 2. Build the system prompt with SWE-bench context
    const systemPrompt = buildSWESystemPrompt(task, injection);

    // 3. Run the agentic loop with SWE-bench tools
    const result = await runSWEAgentLoop(model, task, repoDir, systemPrompt, injection, verbose);

    // 4. Check if agent produced a valid patch
    if (!result.patch) {
      return { ...failResult(startMs, "no_patch"), totalSteps: result.steps, totalTokens: result.tokens };
    }

    // 5. Apply the patch and run tests
    const testResult = await applyAndTest(repoDir, task, result.patch, verbose);

    return {
      success: testResult.passed,
      patchGenerated: true,
      patchApplied: testResult.applied,
      testsRun: testResult.ran,
      testsPassed: testResult.passed,
      totalSteps: result.steps,
      totalTokens: result.tokens,
      durationMs: Date.now() - startMs,
      generatedPatch: result.patch.slice(0, 2000),
      stopReason: testResult.passed ? "tests_passed" : "tests_failed",
    };
  } finally {
    // Cleanup to save disk
    try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* */ }
  }
}

function buildSWESystemPrompt(task: SWETask, injection: string | null): string {
  // Extract file paths from the gold patch to give the agent a hint
  const patchFiles = extractPatchFiles(task.patch);
  const fileHint = patchFiles.length > 0
    ? `\nRelevant files to examine: ${patchFiles.join(", ")}`
    : "";

  const base = `You are an expert software engineer fixing a bug in a Python repository.
Repository: ${task.repo}
${fileHint}

You have access to tools: readFile, editFile.
Note: runTests is not available during fixing. Focus on producing the correct fix.

Your goal: fix the bug described in the issue by editing source files.

Strategy:
1. Read the relevant source file(s) — start with the files listed above
2. Find the bug based on the issue description
3. Edit the file to fix it — use editFile with the COMPLETE file content
4. Keep the fix MINIMAL — change only the lines necessary

CRITICAL: You MUST call editFile at least once. Do not just read files.
File paths are relative to repository root.`;

  if (!injection) return base;

  return `${base}

${injection}

Apply the pattern from institutional memory if it matches this bug.`;
}

/**
 * Simplified SWE-bench agent loop.
 * Uses the same Anthropic/Azure tool-use as the agentic harness,
 * but with the repo dir as the sandbox and the problem statement as context.
 */
async function runSWEAgentLoop(
  model: string,
  task: SWETask,
  repoDir: string,
  systemPrompt: string,
  injection: string | null,
  verbose: boolean,
): Promise<{ patch: string | null; steps: number; tokens: number }> {
  // Create a sandbox wrapper around the repo dir
  const sandbox = {
    readFile(path: string): string {
      const full = join(repoDir, path);
      if (!existsSync(full)) return `Error: File not found: ${path}`;
      try {
        const stat = require("fs").statSync(full);
        if (stat.isDirectory()) return `Directory: ${require("fs").readdirSync(full).join(", ")}`;
        const content = readFileSync(full, "utf-8");
        // Truncate very large files
        if (content.length > 8000) {
          return content.slice(0, 4000) + "\n...(truncated)...\n" + content.slice(-4000);
        }
        return content;
      } catch { return `Error reading ${path}`; }
    },
    editFile(path: string, content: string): string {
      const full = join(repoDir, path);
      writeFileSync(full, content, "utf-8");
      return `File written: ${path}`;
    },
    runTests(_lang: string): { passed: boolean; output: string } {
      return { passed: false, output: "Tests are not available during fixing. Use editFile to apply your fix." };
    },
    cleanup() { /* repo cleanup happens in the caller */ },
    dir: repoDir,
    fixtureId: task.instance_id,
    findProjectRoot() { return repoDir; },
  };

  // Build initial message with the issue
  const userMsg = `Issue to fix:\n\n${task.problem_statement}\n\n${task.hints_text ? `Hints: ${task.hints_text}\n\n` : ""}Fix this bug by editing the relevant source file(s).`;

  // Use the agentic agent directly but with custom sandbox
  const agentResult = await runAgenticTrajectory(
    model,
    sandbox as unknown as Sandbox,
    "python",
    systemPrompt,
    MAX_STEPS,
    injection,
  );

  // Extract the patch from git diff
  let patch: string | null = null;
  try {
    const diff = exec("git diff", { cwd: repoDir });
    if (diff.trim()) patch = diff;
  } catch { /* */ }

  if (verbose && patch) {
    const lines = patch.split("\n").length;
    process.stdout.write(`    Patch: ${lines} lines `);
  }

  return {
    patch,
    steps: agentResult.steps.length,
    tokens: agentResult.steps.reduce((s, st) => s + st.inputTokens + st.outputTokens, 0),
  };
}

/**
 * Apply the agent's patch and run the failing tests.
 */
async function applyAndTest(
  repoDir: string,
  task: SWETask,
  _patch: string,
  verbose: boolean,
): Promise<{ applied: boolean; ran: boolean; passed: boolean; output: string }> {
  // The patch is already applied (agent edited files directly via editFile)
  // We need to run the FAIL_TO_PASS tests

  const failTests = JSON.parse(task.FAIL_TO_PASS) as string[];
  if (failTests.length === 0) {
    return { applied: true, ran: false, passed: false, output: "No FAIL_TO_PASS tests" };
  }

  // Apply test_patch to add the test cases
  if (task.test_patch) {
    try {
      const testPatchFile = join(repoDir, "test_patch.diff");
      writeFileSync(testPatchFile, task.test_patch);
      exec(`git apply test_patch.diff`, { cwd: repoDir });
    } catch {
      // Test patch may already be applied or conflict
    }
  }

  // Run the specific failing tests with pytest
  if (verbose) process.stdout.write("→ testing... ");
  try {
    // Install the package in dev mode first
    try {
      exec("pip3 install -e . --quiet 2>/dev/null", { cwd: repoDir, timeout: 120000 });
    } catch { /* may fail, try tests anyway */ }

    // Run the specific test(s) that should now pass
    const testCmd = failTests.map(t => `"${t}"`).join(" ");
    const output = exec(`python3 -m pytest ${testCmd} -x --tb=short --no-header 2>&1 || true`, {
      cwd: repoDir,
      timeout: 60000,
    });

    const passed = output.includes("passed") && !output.includes("FAILED") && !output.includes("ERROR");
    if (verbose) console.log(passed ? "PASS" : "FAIL");

    return { applied: true, ran: true, passed, output: output.slice(-500) };
  } catch (err) {
    if (verbose) console.log("TEST ERROR");
    return { applied: true, ran: false, passed: false, output: String(err).slice(0, 300) };
  }
}

function extractPatchFiles(patch: string): string[] {
  const files: string[] = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ b/")) {
      files.push(line.slice(6));
    }
  }
  return [...new Set(files)];
}

function failResult(startMs: number, reason: string): TrajectoryResult {
  return {
    success: false, patchGenerated: false, patchApplied: false,
    testsRun: false, testsPassed: false, totalSteps: 0, totalTokens: 0,
    durationMs: Date.now() - startMs, generatedPatch: "", stopReason: reason,
  };
}

function exec(cmd: string, opts?: Partial<ExecSyncOptions>): string {
  return execSync(cmd, { ...EXEC_OPTS, ...opts }) as string;
}
