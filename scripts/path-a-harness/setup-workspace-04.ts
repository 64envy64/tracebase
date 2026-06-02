#!/usr/bin/env tsx
/**
 * Path A harness — workspace builder for 04 Loop Detection.
 *
 * Mirrors `setup-workspace.ts` but:
 *   - sources fixtures from `bench-runs/tool-supervision-path-a-04/tasks/`
 *     and stages workspaces under `.../workspaces/`
 *   - ON variant writes `.claude/settings.json` with
 *     `PostToolUse + UserPromptSubmit` only (NO `PreToolUse`, NO
 *     `toolSupervision.mode`); this is the isolation locked by
 *     `PRE-REGISTRATION-04-LOOP-DETECTION.md` §"Isolation method".
 *   - `.tracebase/memory.db` `reasoning_blocks` and `indexed_files`
 *     stay empty (no seeding); the resolver is expected to hit
 *     `staticFallback` and emit `loop.fallback`.
 *
 * Hook command paths use forward slashes (Windows MSYS bash escaping
 * requirement, carried from spike + 03 smoke fix).
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initConfig } from "../../src/core/config.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..", "..");
const PATH_A_04 = join(ROOT, "bench-runs", "tool-supervision-path-a-04");
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

function writeOnHookConfig04(workspace: string): void {
  mkdirSync(join(workspace, ".claude"), { recursive: true });
  const postCmd = `${toPosix(TSX_BIN)} ${toPosix(CLI_TS)} capture-tool-use --host claude-code --path ${toPosix(workspace)}`;
  const injectCmd = `${toPosix(TSX_BIN)} ${toPosix(CLI_TS)} inject-context --host claude-code --path ${toPosix(workspace)}`;
  writeFileSync(
    join(workspace, ".claude", "settings.json"),
    JSON.stringify(
      {
        hooks: {
          PostToolUse: [
            { hooks: [{ type: "command", command: postCmd, timeout: 5, statusMessage: "TB OBS" }] },
          ],
          UserPromptSubmit: [
            { hooks: [{ type: "command", command: injectCmd, timeout: 5, statusMessage: "TB LOOP" }] },
          ],
        },
      },
      null,
      2,
    ) + "\n",
  );
}

export function setupWorkspace04(taskId: string, variant: Variant): WorkspaceInfo {
  const src = join(PATH_A_04, "tasks", taskId);
  if (!existsSync(src)) {
    throw new Error(`task fixture not found: ${src}`);
  }
  const promptPath = join(src, "PROMPT.txt");
  if (!existsSync(promptPath)) {
    throw new Error(`task PROMPT.txt not found: ${promptPath}`);
  }

  const wsRoot = join(PATH_A_04, "workspaces");
  mkdirSync(wsRoot, { recursive: true });
  const ws = join(wsRoot, `${taskId}.${variant}`);
  if (existsSync(ws)) rmSync(ws, { recursive: true, force: true });
  cpSync(src, ws, { recursive: true });
  rmSync(join(ws, "PROMPT.txt"), { force: true });

  if (variant === "ON") {
    // Init .tracebase but DO NOT set toolSupervision.mode and DO NOT seed
    // reasoning_blocks or indexed_files. Resolver should fall back per
    // PRE-REGISTRATION-04 §"Isolation method".
    initConfig(ws, { install: { agent: "claude-code", agents: ["claude-code"] } });
    writeOnHookConfig04(ws);
  }

  return { taskId, variant, workspace: ws, promptPath };
}

// CLI: tsx scripts/path-a-harness/setup-workspace-04.ts <task> <OFF|ON>
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  const [taskArg, variantArg] = process.argv.slice(2);
  if (!taskArg || (variantArg !== "OFF" && variantArg !== "ON")) {
    console.error("usage: setup-workspace-04.ts <task> <OFF|ON>");
    process.exit(2);
  }
  const info = setupWorkspace04(taskArg, variantArg);
  console.log(JSON.stringify(info, null, 2));
}
