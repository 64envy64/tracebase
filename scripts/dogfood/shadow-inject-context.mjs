#!/usr/bin/env node
/**
 * Local-code Router V2 SHADOW dogfood wrapper.
 *
 * Runs the WORKTREE inject-context CLI (not the published `tracebase-ai@latest`
 * package) with TRACEBASE_REASONING_ROUTER=shadow, so a Claude Code
 * UserPromptSubmit hook exercises the unpushed implementation: it still serves
 * the V1 decision (injected context UNCHANGED) and additionally records the
 * side-by-side V2-family comparison locally.
 *
 * Cross-platform: sets the env in Node (inline `VAR=val` prefixes are not
 * portable to Windows), resolves the CLI relative to THIS file (works from any
 * cwd), and forwards stdin/stdout/stderr + exit code so the hook contract is
 * preserved. Fail-open: any spawn error exits 0 with no envelope so a broken
 * dogfood wrapper can never block a prompt.
 *
 * Activation: see scripts/dogfood/README.md. Wire this as the LOCAL
 * (.claude/settings.local.json, gitignored) UserPromptSubmit hook.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = join(ROOT, "bin", "cli.ts");

try {
  const result = spawnSync(
    "npx",
    ["tsx", cli, "inject-context", "--host", "claude-code", "--status", "compact"],
    {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...process.env, TRACEBASE_REASONING_ROUTER: "shadow" },
      shell: process.platform === "win32",
    },
  );
  process.exit(result.status ?? 0);
} catch {
  // Fail-open: never block the prompt on a wrapper error.
  process.exit(0);
}
