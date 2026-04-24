/**
 * Claude Code silent-injection hook installer.
 *
 * The hook entry in `.claude/settings.json` is the production
 * mechanism that turns "agent must call get_reasoning_patterns"
 * into "Claude Code injects context before the agent runs". The
 * tests here pin three properties:
 *
 *   1. Foreign entries are never trampled. A user-added hook in
 *      the same `UserPromptSubmit` array survives our writer
 *      and our remover; we only touch the entry whose command
 *      string identifies it as ours.
 *   2. The instruction file picks the silent variant for
 *      Claude Code (mentioning the `<tracebase>` block) and the
 *      tool variant for Cursor / Codex (instructing the agent
 *      to call `get_reasoning_patterns` directly).
 *   3. Re-running install is idempotent — a second `init` against
 *      a fully-up-to-date settings.json reports "already-up-to-
 *      date", not "updated".
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectAgentHookConfig,
  removeAgentHookConfig,
  writeAgentHookConfig,
  writeAgentInstructionFile,
} from "../../src/cli/install-targets.js";

let dir: string;
const originalHome = process.env.HOME;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tb-hooks-"));
  process.env.HOME = mkdtempSync(join(tmpdir(), "tb-hooks-home-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (process.env.HOME) rmSync(process.env.HOME, { recursive: true, force: true });
  process.env.HOME = originalHome;
});

describe("writeAgentHookConfig — Claude Code", () => {
  it("creates .claude/settings.json with a UserPromptSubmit entry pointing at inject-context", () => {
    const res = writeAgentHookConfig(dir, "claude-code", false);
    expect(res?.ok).toBe(true);
    if (!res?.ok) return;
    expect(res.kind).toBe("created");

    const settings = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf-8")) as {
      hooks?: { UserPromptSubmit?: Array<{ hooks?: Array<{ command?: string }> }> };
    };
    const inner = settings.hooks?.UserPromptSubmit?.[0]?.hooks?.[0];
    expect(inner?.command).toContain("tracebase-ai");
    expect(inner?.command).toContain("inject-context");
    expect(inner?.command).toContain("--host claude-code");
  });

  it("returns null for agents that do not support silent injection", () => {
    expect(writeAgentHookConfig(dir, "cursor", false)).toBeNull();
    expect(writeAgentHookConfig(dir, "codex", false)).toBeNull();
  });

  it("re-running init is idempotent", () => {
    writeAgentHookConfig(dir, "claude-code", false);
    const second = writeAgentHookConfig(dir, "claude-code", false);
    expect(second?.ok).toBe(true);
    if (!second?.ok) return;
    expect(second.kind).toBe("already-up-to-date");
  });

  it("preserves foreign UserPromptSubmit entries on write and remove", () => {
    // Pre-existing user-defined hook unrelated to TraceBase.
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify(
        {
          hooks: {
            UserPromptSubmit: [
              {
                hooks: [{ type: "command", command: "echo foreign" }],
              },
            ],
          },
        },
        null,
        2,
      ),
    );

    writeAgentHookConfig(dir, "claude-code", false);
    const after = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf-8")) as {
      hooks: { UserPromptSubmit: Array<{ hooks: Array<{ command: string }> }> };
    };
    // Both entries present.
    expect(after.hooks.UserPromptSubmit.length).toBe(2);
    const commands = after.hooks.UserPromptSubmit.flatMap((e) => e.hooks.map((h) => h.command));
    expect(commands).toContain("echo foreign");
    expect(commands.some((c) => c.includes("tracebase-ai"))).toBe(true);

    // Remove only ours; foreign survives.
    removeAgentHookConfig(dir, "claude-code");
    const cleaned = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf-8")) as {
      hooks: { UserPromptSubmit: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(cleaned.hooks.UserPromptSubmit.length).toBe(1);
    expect(cleaned.hooks.UserPromptSubmit[0]!.hooks[0]!.command).toBe("echo foreign");
  });

  it("inspect reports {present, canonical} based on file state", () => {
    expect(inspectAgentHookConfig(dir, "claude-code")).toEqual({
      supported: true,
      present: false,
      canonical: false,
    });

    writeAgentHookConfig(dir, "claude-code", false);
    expect(inspectAgentHookConfig(dir, "claude-code")).toEqual({
      supported: true,
      present: true,
      canonical: true,
    });

    expect(inspectAgentHookConfig(dir, "cursor")).toEqual({
      supported: false,
      present: false,
      canonical: false,
    });
  });

  it("removing a never-installed hook is a no-op (already-absent)", () => {
    const res = removeAgentHookConfig(dir, "claude-code");
    expect(res?.ok).toBe(true);
    if (!res?.ok) return;
    expect(res.kind).toBe("already-absent");
  });

  it("removing the only key collapses the file when no other settings remain", () => {
    writeAgentHookConfig(dir, "claude-code", false);
    expect(existsSync(join(dir, ".claude", "settings.json"))).toBe(true);
    removeAgentHookConfig(dir, "claude-code");
    expect(existsSync(join(dir, ".claude", "settings.json"))).toBe(false);
  });
});

describe("writeAgentInstructionFile — variant per agent", () => {
  it("Claude Code gets the silent variant mentioning the <tracebase> block", () => {
    writeAgentInstructionFile(dir, "claude-code");
    const content = readFileSync(join(dir, "CLAUDE.md"), "utf-8");
    expect(content).toContain("tracebase:begin");
    expect(content).toContain("<tracebase queryId");
    expect(content).toContain("silently attaches");
    // The silent variant explicitly tells the agent NOT to narrate.
    expect(content).toContain("Don't announce or narrate");
  });

  it("Cursor gets the tool variant instructing the agent to call get_reasoning_patterns directly", () => {
    writeAgentInstructionFile(dir, "cursor");
    const content = readFileSync(join(dir, "AGENTS.md"), "utf-8");
    expect(content).toContain("tracebase:begin");
    expect(content).toContain("call `get_reasoning_patterns`");
    // Cursor variant has no <tracebase> block reference because no
    // hook surface attaches one.
    expect(content).not.toContain("<tracebase queryId");
    expect(content).not.toContain("silently attaches");
  });

  it("Codex gets the tool variant until a Codex hook config writer exists", () => {
    writeAgentInstructionFile(dir, "codex");
    const content = readFileSync(join(dir, "AGENTS.md"), "utf-8");
    expect(content).toContain("call `get_reasoning_patterns`");
    expect(content).not.toContain("<tracebase queryId");
  });
});
