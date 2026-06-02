#!/usr/bin/env tsx
/**
 * Path A harness: workspace builder.
 *
 * Builds a fresh per-task workspace at
 * `bench-runs/tool-supervision-path-a/workspaces/<task>.<variant>/` from
 * the source fixture at `bench-runs/tool-supervision-path-a/tasks/<task>/`.
 *
 * For variant=ON, additionally:
 *   - runs `initConfig` to create the workspace's `.tracebase/`
 *   - writes `.tracebase/config.json` `toolSupervision.mode = "soft"`
 *   - writes `.claude/settings.json` with PreToolUse + PostToolUse hooks
 *     pointing at the local repo's tsx + bin/cli.ts. Hook command paths
 *     use FORWARD SLASHES (MSYS bash escaping requirement on Windows —
 *     see bench-runs/path-a/README.md §"Windows hook path quoting").
 *
 * For variant=OFF: just the bare fixture copy. No .tracebase, no hooks.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initConfig } from "../../src/core/config.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..", "..");
const PATH_A = join(ROOT, "bench-runs", "tool-supervision-path-a");
const TSX_BIN = join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
const CLI_TS = join(ROOT, "bin", "cli.ts");

const toPosix = (p: string) => p.replace(/\\/g, "/");

export type Variant = "OFF" | "ON";

export interface WorkspaceInfo {
  taskId: string;
  variant: Variant;
  workspace: string;
  promptPath: string;
}

function writeOnHookConfig(workspace: string): void {
  mkdirSync(join(workspace, ".claude"), { recursive: true });
  const preCmd = `${toPosix(TSX_BIN)} ${toPosix(CLI_TS)} capture-pre-tool-use --host claude-code --path ${toPosix(workspace)}`;
  const postCmd = `${toPosix(TSX_BIN)} ${toPosix(CLI_TS)} capture-tool-use --host claude-code --path ${toPosix(workspace)}`;
  writeFileSync(
    join(workspace, ".claude", "settings.json"),
    JSON.stringify(
      {
        hooks: {
          PreToolUse: [
            { hooks: [{ type: "command", command: preCmd, timeout: 5, statusMessage: "TB TOOL" }] },
          ],
          PostToolUse: [
            { hooks: [{ type: "command", command: postCmd, timeout: 5, statusMessage: "TB OBS" }] },
          ],
        },
      },
      null,
      2,
    ) + "\n",
  );
}

function writeOnSupervisionConfig(workspace: string): void {
  const cfgPath = join(workspace, ".tracebase", "config.json");
  const raw = JSON.parse(readFileSync(cfgPath, "utf-8"));
  raw.toolSupervision = { mode: "soft" };
  writeFileSync(cfgPath, JSON.stringify(raw, null, 2) + "\n");
}

export function setupWorkspace(taskId: string, variant: Variant): WorkspaceInfo {
  const src = join(PATH_A, "tasks", taskId);
  if (!existsSync(src)) {
    throw new Error(`task fixture not found: ${src}`);
  }
  const promptPath = join(src, "PROMPT.txt");
  if (!existsSync(promptPath)) {
    throw new Error(`task PROMPT.txt not found: ${promptPath}`);
  }

  const wsRoot = join(PATH_A, "workspaces");
  mkdirSync(wsRoot, { recursive: true });
  const ws = join(wsRoot, `${taskId}.${variant}`);
  if (existsSync(ws)) rmSync(ws, { recursive: true, force: true });
  cpSync(src, ws, { recursive: true });
  // Don't ship the PROMPT.txt into the workspace — it's metadata, not source.
  rmSync(join(ws, "PROMPT.txt"), { force: true });

  if (variant === "ON") {
    initConfig(ws, { install: { agent: "claude-code", agents: ["claude-code"] } });
    writeOnSupervisionConfig(ws);
    writeOnHookConfig(ws);
  }

  return { taskId, variant, workspace: ws, promptPath };
}

// CLI: tsx scripts/path-a-harness/setup-workspace.ts <task> <OFF|ON>
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  const [taskArg, variantArg] = process.argv.slice(2);
  if (!taskArg || (variantArg !== "OFF" && variantArg !== "ON")) {
    console.error("usage: setup-workspace.ts <task> <OFF|ON>");
    process.exit(2);
  }
  const info = setupWorkspace(taskArg, variantArg);
  console.log(JSON.stringify(info, null, 2));
}
