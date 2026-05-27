#!/usr/bin/env tsx
/**
 * Path A harness: post-trajectory vitest verifier.
 *
 * Runs `vitest run --root <workspace> --no-color --reporter=basic` in the
 * post-trajectory workspace state and returns pass/fail boolean plus a
 * short summary line so the bench can record the actual outcome.
 */
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..", "..");
const VITEST_BIN = join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "vitest.cmd" : "vitest");

export interface VerifyResult {
  pass: boolean;
  summary: string;
  rawTail: string;
  exitCode: number | null;
}

export function verifyPass(workspace: string): VerifyResult {
  const child = spawnSync(
    VITEST_BIN,
    ["run", "--root", workspace, "--no-color", "--reporter=basic"],
    {
      cwd: ROOT,
      encoding: "utf-8",
      shell: process.platform === "win32",
      timeout: 60_000,
    },
  );
  const combined = (child.stdout ?? "") + (child.stderr ?? "");
  const summaryLine = combined
    .split("\n")
    .filter((l) => /Tests\s+\d+/.test(l))
    .slice(-1)[0]
    ?.trim() ?? "(no Tests summary line)";
  const tail = combined.split("\n").slice(-8).join("\n");

  // Heuristic: vitest exits 0 only when all pass.
  return {
    pass: child.status === 0,
    summary: summaryLine,
    rawTail: tail,
    exitCode: child.status,
  };
}

// CLI: tsx scripts/path-a-harness/verify-pass.ts <workspace>
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  const [ws] = process.argv.slice(2);
  if (!ws) {
    console.error("usage: verify-pass.ts <workspace>");
    process.exit(2);
  }
  const r = verifyPass(ws);
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.pass ? 0 : 1);
}
