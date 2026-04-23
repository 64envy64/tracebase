import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, realpathSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const CLI_PATH = join(__dirname, "..", "dist", "cli.js");

function cli(args: string[], cwd: string): string {
  return execFileSync("node", [CLI_PATH, ...args], {
    cwd,
    encoding: "utf-8",
    timeout: 10_000,
    env: {
      ...process.env,
      NO_COLOR: "1",
      // Route Claude Code's runtime-registry operations through a
      // file shim so this test doesn't shell out to the real `claude`
      // CLI (which may be missing in CI or slow under contention).
      TRACEBASE_CLAUDE_REGISTRY_FILE: join(cwd, ".claude", "settings.json"),
      // Skip the live MCP boot probe too — this test asserts on CLI
      // lifecycle, not on MCP server bootability.
      TRACEBASE_MCP_PROBE_COMMAND: "skip",
    },
  });
}

describe("CLI integration", () => {
  let workDir: string;

  beforeEach(() => {
    const raw = join(tmpdir(), `tracebase-cli-${randomUUID()}`);
    mkdirSync(raw, { recursive: true });
    workDir = realpathSync(raw);
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("full lifecycle: init → store → recall → search → stats → export", () => {
    // Skip if CLI not built
    if (!existsSync(CLI_PATH)) {
      console.log("Skipping CLI test — run `npm run build` first");
      return;
    }

    // 1. init
    const initOut = cli(["init", "--path", workDir], workDir);
    expect(initOut).toContain("initialized");
    expect(existsSync(join(workDir, ".tracebase", "config.json"))).toBe(true);

    // 2. store a trace
    const storeOut = cli([
      "store",
      "-d", "TypeError: Cannot read property 'map' of undefined in UserList",
      "-s", "Added optional chaining: users?.map()",
      "-l", "typescript",
      "-f", "react",
      "-e", "TypeError",
      "-t", "frontend,runtime-error",
    ], workDir);
    expect(storeOut).toContain("Trace stored");

    // 3. store another trace (different problem)
    cli([
      "store",
      "-d", "ECONNREFUSED when calling payment microservice API",
      "-s", "Payment container had crashed, restarted via docker compose",
      "-l", "javascript",
      "-f", "express",
      "-e", "ECONNREFUSED",
    ], workDir);

    // 4. recall
    const recallOut = cli([
      "recall",
      "TypeError property map undefined React component",
    ], workDir);
    expect(recallOut).toContain("optional chaining");

    // 5. search
    const searchOut = cli(["search", "payment"], workDir);
    expect(searchOut).toContain("Payment");

    // 6. stats
    const statsOut = cli(["stats"], workDir);
    expect(statsOut).toContain("Total:");
    expect(statsOut).toContain("2"); // 2 traces

    // 7. export
    const exportPath = join(workDir, "export.json");
    cli(["export", exportPath], workDir);
    expect(existsSync(exportPath)).toBe(true);

    // 8. JSON output mode
    const jsonOut = cli(["stats", "--json"], workDir);
    const parsed = JSON.parse(jsonOut);
    expect(parsed.totalTraces).toBe(2);
  });
});
