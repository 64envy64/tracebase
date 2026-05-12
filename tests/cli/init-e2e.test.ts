/**
 * End-to-end `tracebase init` coverage.
 *
 * These tests drive the built CLI binary (`dist/cli.js`) with spawnSync
 * so they exercise argument parsing, exit codes, and user-visible
 * copy — the surfaces that in-process helper tests cannot observe.
 *
 * Gated on `existsSync(CLI_PATH)` so running the suite before
 * `npm run build` degrades to a no-op instead of a spurious failure.
 *
 * Every test uses mkdtemp + an isolated HOME so Cursor's
 * `~/.cursor/mcp.json` never bleeds into the user's actual home.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

const CLI_PATH = join(__dirname, "..", "..", "dist", "cli.js");

/**
 * Minimal PATH that definitely has `node` (so spawnSync can launch our
 * CLI) but definitely does NOT have a real `codex` CLI. Only the
 * process node executable's directory — skipping /usr/bin deliberately
 * so a globally-installed `codex` on the test host cannot leak in.
 * Tests that want to inject a `codex` shim prepend their shim dir in
 * front.
 */
const NODE_DIR = dirname(process.execPath);
const CODEX_FREE_PATH = NODE_DIR;
const PATH_ENV_KEY =
  Object.keys(process.env).find((k) => k.toLowerCase() === "path") ?? "PATH";

/**
 * Install a fake `claude` CLI on PATH that simulates the real
 * `claude mcp add/get/remove` state machine end-to-end.
 *
 * The shim is a Node script (so the implementation stays in-repo TS
 * idiom and needs no python3 on CI), wrapped in a shell script that
 * executes `node`.
 *
 * Returns the bin dir, the invocations log, the backing registry
 * file, and a cleanup handle. The registry is a tiny JSON file;
 * tests assert on its final state directly.
 */
function installClaudeShim(): { binDir: string; log: string; registry: string; cleanup: () => void } {
  const binDir = mkdtempSync(join(tmpdir(), "tb-claude-bin-"));
  const log = join(binDir, "invocations.log");
  const registry = join(binDir, "registry.json");
  const impl = join(binDir, "claude.js");

  const implSource = `#!/usr/bin/env node
const fs = require("node:fs");
const LOG = ${JSON.stringify(log)};
const REG = ${JSON.stringify(registry)};

function load() {
  if (!fs.existsSync(REG)) return {};
  try { return JSON.parse(fs.readFileSync(REG, "utf8")); } catch { return {}; }
}
function save(d) { fs.writeFileSync(REG, JSON.stringify(d)); }

const argv = process.argv.slice(2);
fs.appendFileSync(LOG, argv.join(" ") + "\\n");

if (argv[0] === "--version") {
  process.stdout.write("claude 0.0.0-shim\\n");
  process.exit(0);
}

if (argv[0] === "mcp") {
  const sub = argv[1];
  if (sub === "add") {
    // Flags can appear in any order: --scope <s>, -s <s>, -- … <cmd> <args…>
    let i = 2;
    const name = argv[i++];
    let cmd = null, args = [];
    while (i < argv.length) {
      if (argv[i] === "--scope" || argv[i] === "-s") { i += 2; continue; }
      if (argv[i] === "--") { i++; cmd = argv[i++]; args = argv.slice(i); break; }
      i++;
    }
    const d = load();
    if (d.mcpServers && d.mcpServers[name]) {
      process.stdout.write("MCP server " + name + " already exists in local config\\n");
      process.exit(1);
    }
    d.mcpServers = d.mcpServers || {};
    d.mcpServers[name] = { type: "stdio", command: cmd, args: args };
    save(d);
    process.stdout.write("Added stdio MCP server " + name + " to local config\\n");
    process.exit(0);
  }
  if (sub === "remove") {
    const name = argv[2];
    const d = load();
    if (!d.mcpServers || !d.mcpServers[name]) {
      process.stderr.write("No MCP server found with name: \\"" + name + "\\"\\n");
      process.exit(1);
    }
    delete d.mcpServers[name];
    save(d);
    process.stdout.write("Removed MCP server \\"" + name + "\\" from local config\\n");
    process.exit(0);
  }
  if (sub === "get") {
    const name = argv[2];
    const d = load();
    const e = d.mcpServers && d.mcpServers[name];
    if (!e) {
      process.stderr.write("No MCP server found with name: \\"" + name + "\\"\\n");
      process.exit(1);
    }
    const lines = [
      name + ":",
      "  Scope: Local config (private to you in this project)",
      "  Status: ok",
      "  Type: " + (e.type || "stdio"),
      "  Command: " + e.command,
      "  Args: " + (e.args || []).join(" "),
      "  Environment:",
    ];
    process.stdout.write(lines.join("\\n") + "\\n");
    process.exit(0);
  }
  if (sub === "list") { process.exit(0); }
}

process.stderr.write("claude shim: unhandled args " + argv.join(" ") + "\\n");
process.exit(2);
`;
  writeFileSync(impl, implSource);
  spawnSync("chmod", ["+x", impl]);

  // Wrapper script so anyone spawning "claude" picks up our impl.
  const wrapper = `#!/bin/sh\nexec "${process.execPath}" "${impl}" "$@"\n`;
  writeFileSync(join(binDir, "claude"), wrapper);
  spawnSync("chmod", ["+x", join(binDir, "claude")]);
  writeFileSync(
    join(binDir, "claude.cmd"),
    `@echo off\r\n"${process.execPath}" "${impl}" %*\r\n`,
  );

  return {
    binDir,
    log,
    registry,
    cleanup: () => rmSync(binDir, { recursive: true, force: true }),
  };
}

function cli(args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }) {
  return spawnSync("node", [CLI_PATH, ...args], {
    cwd: opts.cwd,
    encoding: "utf-8",
    env: { ...process.env, NO_COLOR: "1", ...(opts.env ?? {}) },
    timeout: 20_000,
  });
}

let projectDir: string;
let homeDir: string;
let originalHome: string | undefined;
/**
 * Default registry-override path for tests that don't explicitly install
 * the `claude` CLI shim. Making this an absolute file under the test's
 * project directory keeps the claude-code path functional without a
 * real CLI on PATH, while tests that want to exercise real `claude mcp`
 * invocations override PATH to include `installClaudeShim()`.
 */
let claudeRegistryFile: string;

beforeEach(() => {
  const raw = mkdtempSync(join(tmpdir(), "tb-init-e2e-"));
  projectDir = realpathSync(raw);
  // Every init run needs a project marker so resolveProjectBase doesn't
  // walk past into ancestor directories and accidentally attach to a
  // stale parent install.
  mkdirSync(join(projectDir, ".git"), { recursive: true });

  const rawHome = mkdtempSync(join(tmpdir(), "tb-init-home-"));
  homeDir = realpathSync(rawHome);
  originalHome = process.env.HOME;
  process.env.HOME = homeDir;

  claudeRegistryFile = join(projectDir, ".claude", "settings.json");
});

afterEach(() => {
  process.env.HOME = originalHome;
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

/**
 * Env for tests that don't want to manage a real `claude` CLI shim:
 * routes the Claude MCP runtime registry through a file path, so the
 * init/doctor/status/remove code paths still run end-to-end. Tests
 * that need to verify real `claude mcp` invocations pass their own env
 * with `PATH` containing the shim bin dir and no override variable.
 *
 * Also redirects doctor's live MCP boot probe at the local dist/cli.js
 * (instead of the canonical `npx -y tracebase-ai@latest serve --mcp`) so the
 * probe exercises local code — not the npm registry — during CI.
 * Tests that want to check the probe's behaviour when the probe itself
 * is unreachable/stale can override `TRACEBASE_MCP_PROBE_COMMAND`
 * explicitly via the `extra` param.
 */
function envWithClaudeRegistryOverride(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const localProbe = JSON.stringify([process.execPath, CLI_PATH, "serve", "--mcp"]);
  return {
    TRACEBASE_CLAUDE_REGISTRY_FILE: claudeRegistryFile,
    TRACEBASE_MCP_PROBE_COMMAND: localProbe,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Argument parsing / validation
// ---------------------------------------------------------------------------

describe("tracebase init — argument validation", () => {
  it("rejects an unsupported --agent with a clear error and non-zero exit", () => {
    if (!existsSync(CLI_PATH)) return;
    const res = cli(["init", "--path", projectDir, "--agent", "chatgpt", "-y"], {
      cwd: projectDir,
      env: { HOME: homeDir },
    });
    expect(res.status).not.toBe(0);
    // Error message names the invalid value and the three valid ones.
    const combined = `${res.stdout}${res.stderr}`;
    expect(combined).toMatch(/Unsupported agent target: chatgpt/);
    expect(combined).toMatch(/claude-code/);
    expect(combined).toMatch(/cursor/);
    expect(combined).toMatch(/codex/);
  });
});

// ---------------------------------------------------------------------------
// Per-agent fresh init (non-interactive)
// ---------------------------------------------------------------------------

describe("tracebase init --agent claude-code (fresh project)", () => {
  it("invokes `claude mcp add` against the runtime registry; writes CLAUDE.md; no manual edits", () => {
    if (!existsSync(CLI_PATH)) return;
    const shim = installClaudeShim();
    try {
      const res = cli(["init", "--agent", "claude-code", "-y", "--path", projectDir], {
        cwd: projectDir,
        env: {
          HOME: homeDir,
          TRACEBASE_API_URL: "",
          [PATH_ENV_KEY]: `${shim.binDir}${delimiter}${CODEX_FREE_PATH}`,
        },
      });
      expect(res.status).toBe(0);

      // Config file exists, workspaceId minted, install.agents stored.
      const config = JSON.parse(
        readFileSync(join(projectDir, ".tracebase", "config.json"), "utf-8"),
      ) as Record<string, unknown>;
      expect(config.workspaceId).toBeTypeOf("string");
      expect((config.install as Record<string, unknown>).agents).toEqual(["claude-code"]);

      // No apiKey anywhere in on-disk config — cloud creds live in ~/.tracebase.
      expect(JSON.stringify(config)).not.toMatch(/apiKey/i);

      // Runtime registry — the actual source of truth for Claude Code.
      // Asserting the precise `claude mcp add` arguments ensures `/mcp`
      // will show tracebase after restart.
      const log = readFileSync(shim.log, "utf-8");
      expect(log).toMatch(
        /mcp add tracebase --scope local -- npx -y tracebase-ai@latest serve --mcp/,
      );

      const registry = JSON.parse(readFileSync(shim.registry, "utf-8")) as {
        mcpServers?: Record<string, { type?: string; command: string; args: string[] }>;
      };
      expect(registry.mcpServers?.tracebase).toEqual({
        type: "stdio",
        command: "npx",
        args: ["-y", "tracebase-ai@latest", "serve", "--mcp"],
      });

      // Claude MCP stays in the runtime registry; .claude/settings.json
      // is used only for the UserPromptSubmit hook that performs silent
      // pre-prompt injection.
      const claudeSettings = JSON.parse(
        readFileSync(join(projectDir, ".claude", "settings.json"), "utf-8"),
      ) as {
        mcpServers?: Record<string, unknown>;
        hooks?: { UserPromptSubmit?: Array<{ hooks?: Array<{ command?: string }> }> };
      };
      expect(claudeSettings.mcpServers).toBeUndefined();
      const hookCommands = claudeSettings.hooks?.UserPromptSubmit?.flatMap((entry) =>
        entry.hooks?.map((h) => h.command ?? "") ?? [],
      ) ?? [];
      expect(hookCommands.some((cmd) => cmd.includes("inject-context --host claude-code"))).toBe(true);

      // Instruction block.
      const claudeMd = readFileSync(join(projectDir, "CLAUDE.md"), "utf-8");
      expect(claudeMd).toContain("tracebase:begin");
      expect(claudeMd).toContain("<tracebase queryId");
      expect(claudeMd).toContain("get_reasoning_patterns");
      // No secrets ever land in instruction files.
      expect(claudeMd).not.toMatch(/apiKey|Bearer /i);
    } finally {
      shim.cleanup();
    }
  });

  it("reports a clear error and non-zero exit when the `claude` CLI is not on PATH", () => {
    if (!existsSync(CLI_PATH)) return;
    const res = cli(["init", "--agent", "claude-code", "-y", "--path", projectDir], {
      cwd: projectDir,
      env: { HOME: homeDir, TRACEBASE_API_URL: "", [PATH_ENV_KEY]: CODEX_FREE_PATH },
    });
    expect(res.status).not.toBe(0);
    const combined = `${res.stdout}${res.stderr}`;
    expect(combined).toMatch(/claude CLI is not available in PATH/i);
    expect(combined).toMatch(/Install Claude Code|add .claude. to PATH/i);
  });

  it("sweeps a stale .claude/settings.json entry after a successful runtime registration", () => {
    if (!existsSync(CLI_PATH)) return;
    const shim = installClaudeShim();
    try {
      // Simulate a legacy install that wrote to .claude/settings.json.
      mkdirSync(join(projectDir, ".claude"), { recursive: true });
      writeFileSync(
        join(projectDir, ".claude", "settings.json"),
        JSON.stringify(
          {
            mcpServers: {
              tracebase: { command: "npx", args: ["-y", "tracebase-ai@latest", "serve", "--mcp"] },
              other: { command: "x", args: [] },
            },
            permissions: { allow: ["npm run build"] },
          },
          null,
          2,
        ),
      );

      const res = cli(["init", "--agent", "claude-code", "-y", "--path", projectDir], {
        cwd: projectDir,
        env: {
          HOME: homeDir,
          TRACEBASE_API_URL: "",
          [PATH_ENV_KEY]: `${shim.binDir}${delimiter}${CODEX_FREE_PATH}`,
        },
      });
      expect(res.status).toBe(0);

      // Legacy entry is gone; unrelated entries preserved.
      const after = JSON.parse(
        readFileSync(join(projectDir, ".claude", "settings.json"), "utf-8"),
      ) as Record<string, unknown>;
      const servers = (after.mcpServers as Record<string, unknown>) || {};
      expect(servers.tracebase).toBeUndefined();
      expect(servers.other).toBeDefined();
      expect((after.permissions as Record<string, unknown>).allow).toEqual(["npm run build"]);
    } finally {
      shim.cleanup();
    }
  });

  it("status + doctor report the runtime registration as configured (PASS), not false-positive on settings.json", () => {
    if (!existsSync(CLI_PATH)) return;
    const shim = installClaudeShim();
    const env = {
      HOME: homeDir,
      TRACEBASE_API_URL: "",
      [PATH_ENV_KEY]: `${shim.binDir}${delimiter}${CODEX_FREE_PATH}`,
    };
    try {
      expect(
        cli(["init", "--agent", "claude-code", "-y", "--path", projectDir], {
          cwd: projectDir,
          env,
        }).status,
      ).toBe(0);

      const doctor = cli(["doctor", "--json", "--path", projectDir], {
        cwd: projectDir,
        env,
      });
      const report = JSON.parse(doctor.stdout) as {
        checks: Array<{ name: string; level: string; message: string }>;
      };
      const mcp = report.checks.find((c) => c.name === "claude-code-mcp")!;
      expect(mcp).toBeDefined();
      expect(mcp.level).toBe("pass");
      expect(mcp.message).toMatch(/claude mcp|runtime registry/i);

      const status = cli(["status", "--path", projectDir], {
        cwd: projectDir,
        env,
      });
      expect(status.status).toBe(0);
      // Runtime location label surfaces in the status output — no
      // lingering reference to `.claude/settings.json` for Claude Code.
      expect(status.stdout).toMatch(/claude mcp registry/i);
    } finally {
      shim.cleanup();
    }
  });

  it("remove: uninstalls both the runtime registration and any legacy .claude/settings.json entry", () => {
    if (!existsSync(CLI_PATH)) return;
    const shim = installClaudeShim();
    const env = {
      HOME: homeDir,
      TRACEBASE_API_URL: "",
      [PATH_ENV_KEY]: `${shim.binDir}${delimiter}${CODEX_FREE_PATH}`,
    };
    try {
      // Fresh init via the real CLI (uses the shim).
      expect(
        cli(["init", "--agent", "claude-code", "-y", "--path", projectDir], {
          cwd: projectDir,
          env,
        }).status,
      ).toBe(0);
      // Seed a lingering legacy entry for the remove sweep to catch.
      mkdirSync(join(projectDir, ".claude"), { recursive: true });
      writeFileSync(
        join(projectDir, ".claude", "settings.json"),
        JSON.stringify({
          mcpServers: {
            tracebase: { command: "npx", args: ["-y", "tracebase-ai@latest", "serve", "--mcp"] },
          },
        }),
      );

      // The init shim's `claude mcp add` produced a registry entry;
      // confirm remove wipes it via `claude mcp remove`.
      const before = JSON.parse(readFileSync(shim.registry, "utf-8")) as {
        mcpServers?: Record<string, unknown>;
      };
      expect(before.mcpServers?.tracebase).toBeDefined();

      const remove = cli(["remove", "--path", projectDir], { cwd: projectDir, env });
      expect(remove.status).toBe(0);

      // Runtime registry empty of tracebase.
      const after = JSON.parse(readFileSync(shim.registry, "utf-8")) as {
        mcpServers?: Record<string, unknown>;
      };
      expect(after.mcpServers?.tracebase).toBeUndefined();

      // Shim saw the `claude mcp remove tracebase` invocation.
      const log = readFileSync(shim.log, "utf-8");
      expect(log).toMatch(/mcp remove tracebase/);

      // Legacy .claude/settings.json removed by remove's sweep.
      if (existsSync(join(projectDir, ".claude", "settings.json"))) {
        const legacy = JSON.parse(
          readFileSync(join(projectDir, ".claude", "settings.json"), "utf-8"),
        ) as Record<string, unknown>;
        expect((legacy.mcpServers as Record<string, unknown> | undefined)?.tracebase).toBeUndefined();
      }
    } finally {
      shim.cleanup();
    }
  });
});

describe("tracebase init --agent cursor (fresh project)", () => {
  it("writes ~/.cursor/mcp.json and AGENTS.md, preserves unrelated MCP entries on re-run", () => {
    if (!existsSync(CLI_PATH)) return;
    // Pre-seed an unrelated Cursor MCP entry to verify the merge is non-destructive.
    mkdirSync(join(homeDir, ".cursor"), { recursive: true });
    writeFileSync(
      join(homeDir, ".cursor", "mcp.json"),
      JSON.stringify(
        {
          mcpServers: { other: { command: "other-cmd", args: [] } },
          telemetry: false,
        },
        null,
        2,
      ),
    );

    const res = cli(["init", "--agent", "cursor", "-y", "--path", projectDir], {
      cwd: projectDir,
      env: { HOME: homeDir, TRACEBASE_API_URL: "" },
    });
    expect(res.status).toBe(0);

    const parsed = JSON.parse(
      readFileSync(join(homeDir, ".cursor", "mcp.json"), "utf-8"),
    ) as Record<string, unknown>;
    const servers = parsed.mcpServers as Record<string, unknown>;
    // Pre-existing entry preserved, unrelated top-level keys preserved.
    expect(servers.other).toEqual({ command: "other-cmd", args: [] });
    expect(parsed.telemetry).toBe(false);
    // Tracebase added.
    expect(servers.tracebase).toBeDefined();

    // Cursor uses AGENTS.md, not CLAUDE.md.
    expect(existsSync(join(projectDir, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(projectDir, "CLAUDE.md"))).toBe(false);
  });
});

describe("tracebase init --agent codex (mocked codex CLI)", () => {
  it("invokes `codex mcp add` via PATH shim, writes AGENTS.md", () => {
    if (!existsSync(CLI_PATH)) return;
    // Create a PATH shim for `codex` that records invocations and
    // pretends every subcommand succeeded. `mcp get` needs to return
    // canonical JSON so the inspector treats the entry as installed.
    const binDir = mkdtempSync(join(tmpdir(), "tb-codex-bin-"));
    const shimLog = join(binDir, "invocations.log");
    const canonicalJson = JSON.stringify({
      name: "tracebase",
      transport: {
        type: "stdio",
        command: "npx",
        args: ["-y", "tracebase-ai@latest", "serve", "--mcp"],
      },
    });
    const impl = join(binDir, "codex.js");
    const implSource = `#!/usr/bin/env node
const fs = require("node:fs");
const LOG = ${JSON.stringify(shimLog)};
const INSTALLED = ${JSON.stringify(join(binDir, "installed"))};
const CANONICAL = ${JSON.stringify(canonicalJson)};
const argv = process.argv.slice(2);
fs.appendFileSync(LOG, argv.join(" ") + "\\n");
const joined = argv.join(" ");
if (joined === "--version") {
  process.stdout.write("codex 0.0.0-shim\\n");
  process.exit(0);
}
if (joined === "mcp get tracebase --json") {
  if (fs.existsSync(INSTALLED)) {
    process.stdout.write(CANONICAL + "\\n");
    process.exit(0);
  }
  process.exit(1);
}
if (joined.startsWith("mcp add tracebase")) {
  fs.writeFileSync(INSTALLED, "1");
  process.exit(0);
}
if (joined.startsWith("mcp remove tracebase")) {
  fs.rmSync(INSTALLED, { force: true });
  process.exit(0);
}
process.stderr.write("codex shim: unhandled args " + joined + "\\n");
process.exit(2);
`;
    writeFileSync(impl, implSource);
    spawnSync("chmod", ["+x", impl]);
    const wrapper = `#!/bin/sh\nexec "${process.execPath}" "${impl}" "$@"\n`;
    writeFileSync(join(binDir, "codex"), wrapper);
    spawnSync("chmod", ["+x", join(binDir, "codex")]);
    writeFileSync(
      join(binDir, "codex.cmd"),
      `@echo off\r\n"${process.execPath}" "${impl}" %*\r\n`,
    );

    const res = cli(["init", "--agent", "codex", "-y", "--path", projectDir], {
      cwd: projectDir,
      env: {
        HOME: homeDir,
        TRACEBASE_API_URL: "",
        [PATH_ENV_KEY]: `${binDir}${delimiter}${process.env[PATH_ENV_KEY] ?? ""}`,
      },
    });

    try {
      expect(res.status).toBe(0);
      const log = readFileSync(shimLog, "utf-8");
      // init always inspects first (mcp get), then adds when missing.
      expect(log).toMatch(/mcp add tracebase -- npx -y tracebase-ai@latest serve --mcp/);
      // AGENTS.md written.
      expect(existsSync(join(projectDir, "AGENTS.md"))).toBe(true);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it("reports a clear error when the codex CLI is not on PATH", () => {
    if (!existsSync(CLI_PATH)) return;
    // Empty PATH so neither the real codex nor any shim is reachable.
    const res = cli(["init", "--agent", "codex", "-y", "--path", projectDir], {
      cwd: projectDir,
      env: { HOME: homeDir, TRACEBASE_API_URL: "", [PATH_ENV_KEY]: CODEX_FREE_PATH},
    });
    // Missing CLI surfaces as an `install incomplete` step but init still
    // returns non-zero so the user sees the problem.
    expect(res.status).not.toBe(0);
    expect(`${res.stdout}${res.stderr}`).toMatch(
      /codex CLI is not available in PATH|codex.*not.*PATH|codex.*shim/i,
    );
  });
});

// ---------------------------------------------------------------------------
// --all (multi-agent)
// ---------------------------------------------------------------------------

describe("tracebase init --all (no codex shim)", () => {
  it("installs claude-code + cursor cleanly even when codex CLI is absent", () => {
    if (!existsSync(CLI_PATH)) return;
    const res = cli(["init", "--all", "-y", "--path", projectDir], {
      cwd: projectDir,
      env: envWithClaudeRegistryOverride({
        HOME: homeDir,
        TRACEBASE_API_URL: "",
        [PATH_ENV_KEY]: CODEX_FREE_PATH,
      }),
    });
    // --all still flags the codex step as incomplete when the CLI is
    // missing, which fails the exit code. The useful invariant is that
    // the Claude Code + Cursor surfaces did land.
    expect(existsSync(join(projectDir, ".claude", "settings.json"))).toBe(true);
    expect(existsSync(join(projectDir, "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(homeDir, ".cursor", "mcp.json"))).toBe(true);
    expect(existsSync(join(projectDir, "AGENTS.md"))).toBe(true);

    // Config records all three in install.agents so doctor/status can
    // still report the codex gap.
    const config = JSON.parse(
      readFileSync(join(projectDir, ".tracebase", "config.json"), "utf-8"),
    ) as Record<string, unknown>;
    const agents = (config.install as Record<string, unknown>).agents as string[];
    expect(agents).toEqual(["claude-code", "cursor", "codex"]);
    // Non-zero exit because the codex step failed — important: init
    // does not silently succeed when a requested adapter is broken.
    expect(res.status).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("tracebase init — idempotency", () => {
  it("re-running init does not mutate workspaceId, does not duplicate MCP entries, does not duplicate the instruction block", () => {
    if (!existsSync(CLI_PATH)) return;
    const env = envWithClaudeRegistryOverride({ HOME: homeDir, TRACEBASE_API_URL: "" });
    const first = cli(["init", "--agent", "claude-code", "-y", "--path", projectDir], {
      cwd: projectDir,
      env,
    });
    expect(first.status).toBe(0);

    const configA = JSON.parse(
      readFileSync(join(projectDir, ".tracebase", "config.json"), "utf-8"),
    ) as Record<string, unknown>;
    const registryA = readFileSync(claudeRegistryFile, "utf-8");
    const claudeMdA = readFileSync(join(projectDir, "CLAUDE.md"), "utf-8");

    const second = cli(["init", "--agent", "claude-code", "-y", "--path", projectDir], {
      cwd: projectDir,
      env,
    });
    expect(second.status).toBe(0);

    const configB = JSON.parse(
      readFileSync(join(projectDir, ".tracebase", "config.json"), "utf-8"),
    ) as Record<string, unknown>;
    const registryB = readFileSync(claudeRegistryFile, "utf-8");
    const claudeMdB = readFileSync(join(projectDir, "CLAUDE.md"), "utf-8");

    // workspaceId stable — critical, this is the local project identity.
    expect(configB.workspaceId).toBe(configA.workspaceId);
    // Registry file bytewise stable — no duplicate entries.
    expect(registryB).toBe(registryA);
    // Instruction block stable.
    expect(claudeMdB).toBe(claudeMdA);

    // Only one occurrence of the managed-section delimiter.
    const markerOccurrences = claudeMdB.split("tracebase:begin").length - 1;
    expect(markerOccurrences).toBe(1);
  });

  it("preserves unrelated user content in CLAUDE.md across re-inits", () => {
    if (!existsSync(CLI_PATH)) return;
    writeFileSync(
      join(projectDir, "CLAUDE.md"),
      "# Project rules\n\nAlways add tests.\n",
    );

    const env = envWithClaudeRegistryOverride({ HOME: homeDir, TRACEBASE_API_URL: "" });
    cli(["init", "--agent", "claude-code", "-y", "--path", projectDir], {
      cwd: projectDir,
      env,
    });
    // Append more user content after the managed block.
    const after = readFileSync(join(projectDir, "CLAUDE.md"), "utf-8") +
      "\n\n## User notes\n\nAppended after init.\n";
    writeFileSync(join(projectDir, "CLAUDE.md"), after);

    cli(["init", "--agent", "claude-code", "-y", "--path", projectDir], {
      cwd: projectDir,
      env,
    });

    const final = readFileSync(join(projectDir, "CLAUDE.md"), "utf-8");
    expect(final).toContain("# Project rules");
    expect(final).toContain("Always add tests.");
    expect(final).toContain("## User notes");
    expect(final).toContain("Appended after init.");
    expect(final).toContain("tracebase:begin");
  });
});

// ---------------------------------------------------------------------------
// Local-only install (no API key, no cloud)
// ---------------------------------------------------------------------------

describe("tracebase init — local-only (no API key)", () => {
  it("succeeds without any cloud link and says so on the Next: screen", () => {
    if (!existsSync(CLI_PATH)) return;
    const res = cli(["init", "--agent", "claude-code", "-y", "--path", projectDir], {
      cwd: projectDir,
      // Empty TRACEBASE_API_URL and no --api-key → no cloud call at all.
      env: envWithClaudeRegistryOverride({
        HOME: homeDir,
        TRACEBASE_API_URL: "",
        TRACEBASE_API_KEY: "",
      }),
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/Cloud: local only/);
    expect(res.stdout).toMatch(/dashboard sync disabled/);
    // Config has no cloud field.
    const config = JSON.parse(
      readFileSync(join(projectDir, ".tracebase", "config.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(config.cloud).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Post-init health: status + doctor
// ---------------------------------------------------------------------------

describe("tracebase status + doctor — after fresh local-only init", () => {
  it("status shows the adapter as configured and reports local-only cloud state", () => {
    if (!existsSync(CLI_PATH)) return;
    const env = envWithClaudeRegistryOverride({ HOME: homeDir, TRACEBASE_API_URL: "" });
    cli(["init", "--agent", "claude-code", "-y", "--path", projectDir], {
      cwd: projectDir,
      env,
    });
    const status = cli(["status", "--path", projectDir], {
      cwd: projectDir,
      env,
    });
    expect(status.status).toBe(0);
    expect(status.stdout).toMatch(/Claude Code/);
    expect(status.stdout).toMatch(/cloud:\s+local only/);
    // no activity yet — first MCP call populates memory.db
    expect(status.stdout).toMatch(/no activity recorded yet|last activity/);
  });

  it("doctor reports cloud-link PASS as local-only, not a FAIL", () => {
    if (!existsSync(CLI_PATH)) return;
    const env = envWithClaudeRegistryOverride({ HOME: homeDir, TRACEBASE_API_URL: "" });
    cli(["init", "--agent", "claude-code", "-y", "--path", projectDir], {
      cwd: projectDir,
      env,
    });
    const doctor = cli(["doctor", "--json", "--path", projectDir], {
      cwd: projectDir,
      env,
    });
    // summary.fail may be 0 here because all checks are PASS/WARN; but
    // cloud-link specifically must be PASS local-only.
    const report = JSON.parse(doctor.stdout) as {
      checks: Array<{ name: string; level: string; message: string }>;
    };
    const cloud = report.checks.find((c) => c.name === "cloud-link")!;
    expect(cloud).toBeDefined();
    expect(cloud.level).toBe("pass");
    expect(cloud.message).toMatch(/local only/);
  });
});

// ---------------------------------------------------------------------------
// Live MCP boot probe — doctor actually spawns `serve --mcp --selftest`
// ---------------------------------------------------------------------------

describe("tracebase doctor — live MCP boot probe", () => {
  it("serve --mcp --selftest boots to READY and exits 0 without binding stdio", () => {
    if (!existsSync(CLI_PATH)) return;
    const env = envWithClaudeRegistryOverride({ HOME: homeDir, TRACEBASE_API_URL: "" });
    // Init first so .tracebase/config.json exists — selftest reads it.
    cli(["init", "--agent", "claude-code", "-y", "--path", projectDir], {
      cwd: projectDir,
      env,
    });

    const res = cli(["serve", "--mcp", "--selftest"], { cwd: projectDir, env });
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/READY/);
  });

  it("doctor's mcp-boot check PASSes on a clean install (SDK loads, SQLite opens, tools register)", () => {
    if (!existsSync(CLI_PATH)) return;
    const env = envWithClaudeRegistryOverride({ HOME: homeDir, TRACEBASE_API_URL: "" });
    cli(["init", "--agent", "claude-code", "-y", "--path", projectDir], {
      cwd: projectDir,
      env,
    });
    const doctor = cli(["doctor", "--json", "--path", projectDir], {
      cwd: projectDir,
      env,
    });
    const report = JSON.parse(doctor.stdout) as {
      checks: Array<{ name: string; level: string; message: string }>;
    };
    const mcpSdk = report.checks.find((c) => c.name === "mcp-sdk")!;
    expect(mcpSdk.level).toBe("pass");
    expect(mcpSdk.message).toMatch(/resolvable/);

    const mcpBoot = report.checks.find((c) => c.name === "mcp-boot")!;
    expect(mcpBoot).toBeDefined();
    expect(mcpBoot.level).toBe("pass");
    expect(mcpBoot.message).toMatch(/boots cleanly/);
  });

  it("doctor's mcp-boot check FAILs with a captured error when the store is corrupted", () => {
    if (!existsSync(CLI_PATH)) return;
    const env = envWithClaudeRegistryOverride({ HOME: homeDir, TRACEBASE_API_URL: "" });
    cli(["init", "--agent", "claude-code", "-y", "--path", projectDir], {
      cwd: projectDir,
      env,
    });
    // Populate memory.db so it exists, then corrupt it — otherwise
    // better-sqlite3 would happily create a fresh empty DB and boot.
    writeFileSync(join(projectDir, ".tracebase", "memory.db"), "not a sqlite file");

    const doctor = cli(["doctor", "--json", "--path", projectDir], {
      cwd: projectDir,
      env,
    });
    const report = JSON.parse(doctor.stdout) as {
      checks: Array<{ name: string; level: string; message: string; fix?: string }>;
    };
    const mcpBoot = report.checks.find((c) => c.name === "mcp-boot")!;
    expect(mcpBoot).toBeDefined();
    expect(mcpBoot.level).toBe("fail");
    expect(mcpBoot.message).toMatch(/failed to boot.*not a database|file is not a database/i);
    expect(mcpBoot.fix).toMatch(/serve --mcp|npx -y tracebase-ai/);
  });

  // Regression — the probe MUST NOT fall back to `process.argv[1]`
  // (the local CLI). It must spawn the actual registered runtime (or
  // a commander-compatible stand-in) so a stale/missing published
  // tracebase-ai surfaces as FAIL, not a false PASS against the dev
  // checkout.
  it("probe uses the canonical command — a missing probe binary is a hard FAIL, not a PASS via local CLI", () => {
    if (!existsSync(CLI_PATH)) return;
    // Init with the standard test env (so registry is populated).
    cli(["init", "--agent", "claude-code", "-y", "--path", projectDir], {
      cwd: projectDir,
      env: envWithClaudeRegistryOverride({ HOME: homeDir, TRACEBASE_API_URL: "" }),
    });
    // Run doctor with a probe command pointing at a non-existent
    // binary. The probe must fail (ENOENT) rather than falling back
    // to the local CLI and reporting a false PASS.
    const doctor = cli(["doctor", "--json", "--path", projectDir], {
      cwd: projectDir,
      env: {
        HOME: homeDir,
        TRACEBASE_API_URL: "",
        TRACEBASE_CLAUDE_REGISTRY_FILE: claudeRegistryFile,
        TRACEBASE_MCP_PROBE_COMMAND: JSON.stringify([
          "/nonexistent/probe/binary-does-not-exist",
        ]),
      },
    });
    const report = JSON.parse(doctor.stdout) as {
      checks: Array<{ name: string; level: string; message: string; fix?: string }>;
    };
    const mcpBoot = report.checks.find((c) => c.name === "mcp-boot")!;
    expect(mcpBoot).toBeDefined();
    expect(mcpBoot.level).toBe("fail");
    expect(mcpBoot.message).toMatch(/command not found|not found/i);
  });

  // Regression — when the probe binary rejects `--selftest`, doctor
  // must NOT assume the bare `serve --mcp` command is fine. Instead
  // it retries without the flag and judges based on THAT outcome.
  // Simulate a shim that: (a) rejects --selftest like commander does,
  // (b) when called without --selftest, crashes with "Cannot find
  // package '@modelcontextprotocol/sdk'" — the exact failure mode
  // the published runtime exhibited that started this fix stream.
  // doctor must FAIL, not WARN.
  it("probe FAILs when --selftest is rejected AND bare `serve --mcp` also crashes (broken published runtime)", () => {
    if (!existsSync(CLI_PATH)) return;
    cli(["init", "--agent", "claude-code", "-y", "--path", projectDir], {
      cwd: projectDir,
      env: envWithClaudeRegistryOverride({ HOME: homeDir, TRACEBASE_API_URL: "" }),
    });

    const brokenProbe = join(projectDir, "broken-published-probe.js");
    writeFileSync(
      brokenProbe,
      `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv.includes("--selftest")) {
  process.stderr.write("error: unknown option '--selftest'\\n");
  process.exit(1);
}
// Bare \`serve --mcp\` — pretend SDK is missing, the real bug users hit.
process.stderr.write("Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@modelcontextprotocol/sdk'\\n");
process.exit(1);
`,
    );

    const doctor = cli(["doctor", "--json", "--path", projectDir], {
      cwd: projectDir,
      env: {
        HOME: homeDir,
        TRACEBASE_API_URL: "",
        TRACEBASE_CLAUDE_REGISTRY_FILE: claudeRegistryFile,
        TRACEBASE_MCP_PROBE_COMMAND: JSON.stringify([process.execPath, brokenProbe]),
      },
    });
    const report = JSON.parse(doctor.stdout) as {
      checks: Array<{ name: string; level: string; message: string; fix?: string }>;
    };
    const mcpBoot = report.checks.find((c) => c.name === "mcp-boot")!;
    expect(mcpBoot).toBeDefined();
    expect(mcpBoot.level).toBe("fail");
    expect(mcpBoot.message).toMatch(/published.*fails to boot|@modelcontextprotocol\/sdk|ERR_MODULE_NOT_FOUND/i);
    expect(mcpBoot.fix).toMatch(/missing-dependency|@modelcontextprotocol\/sdk|re-publish/i);
  });

  // Transitional WARN: --selftest rejected, but the bare command
  // actually stays alive like a healthy stdio server waiting for
  // JSON-RPC. Probe can't VERIFY tool registration without selftest,
  // so it degrades to WARN — but it must not claim "MCP path is
  // unaffected" anymore, since that's what masked the broken
  // published runtime.
  it("probe WARNs when --selftest is rejected but bare `serve --mcp` stays alive (healthy pre-selftest runtime)", () => {
    if (!existsSync(CLI_PATH)) return;
    cli(["init", "--agent", "claude-code", "-y", "--path", projectDir], {
      cwd: projectDir,
      env: envWithClaudeRegistryOverride({ HOME: homeDir, TRACEBASE_API_URL: "" }),
    });

    const healthyStdioProbe = join(projectDir, "healthy-pre-selftest-probe.js");
    writeFileSync(
      healthyStdioProbe,
      `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv.includes("--selftest")) {
  process.stderr.write("error: unknown option '--selftest'\\n");
  process.exit(1);
}
// Mimic a healthy stdio MCP server — stay alive, wait for input.
process.stdin.resume();
setInterval(() => {}, 60_000);
`,
    );

    const doctor = cli(["doctor", "--json", "--path", projectDir], {
      cwd: projectDir,
      env: {
        HOME: homeDir,
        TRACEBASE_API_URL: "",
        TRACEBASE_CLAUDE_REGISTRY_FILE: claudeRegistryFile,
        TRACEBASE_MCP_PROBE_COMMAND: JSON.stringify([process.execPath, healthyStdioProbe]),
      },
    });
    const report = JSON.parse(doctor.stdout) as {
      checks: Array<{ name: string; level: string; message: string; fix?: string }>;
    };
    const mcpBoot = report.checks.find((c) => c.name === "mcp-boot")!;
    expect(mcpBoot).toBeDefined();
    expect(mcpBoot.level).toBe("warn");
    expect(mcpBoot.message).toMatch(/stays alive|healthy stdio/i);
    // Guard against the old misleading copy — WARN must NOT claim
    // Claude Code is unaffected without having verified anything.
    expect(mcpBoot.message).not.toMatch(/MCP path is unaffected/i);
  });
});

// ---------------------------------------------------------------------------
// Abuse guard: secrets never leak into files or output
// ---------------------------------------------------------------------------

describe("secret hygiene", () => {
  it("when no API key is given, init output contains no Bearer tokens or apiKey fields", () => {
    if (!existsSync(CLI_PATH)) return;
    const res = cli(["init", "--agent", "claude-code", "-y", "--path", projectDir], {
      cwd: projectDir,
      env: envWithClaudeRegistryOverride({ HOME: homeDir, TRACEBASE_API_URL: "" }),
    });
    const combined = `${res.stdout}${res.stderr}`;
    expect(combined).not.toMatch(/Bearer\s+[A-Za-z0-9._-]+/);
    expect(combined).not.toMatch(/apiKey/);
  });
});
