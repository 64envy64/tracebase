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
      hooks?: {
        UserPromptSubmit?: Array<{
          hooks?: Array<{ command?: string; statusMessage?: string; timeout?: number }>;
        }>;
      };
    };
    const inner = settings.hooks?.UserPromptSubmit?.[0]?.hooks?.[0];
    expect(inner?.command).toContain("tracebase-ai");
    expect(inner?.command).toContain("inject-context");
    expect(inner?.command).toContain("--host claude-code");
    // Hook transparency contract: the installed command opts into the
    // compact TB TRACE badge, and the static `statusMessage` Claude
    // Code shows while the hook is running mirrors that badge prefix.
    // Regressing either drops the user's only visible signal that the
    // hook fired.
    expect(inner?.command).toContain("--status compact");
    expect(inner?.statusMessage).toBe("▣ TB TRACE  checking");
  });

  it("installs a Stop hook alongside UserPromptSubmit pointing at capture-turn", () => {
    const res = writeAgentHookConfig(dir, "claude-code", false);
    expect(res?.ok).toBe(true);

    const settings = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf-8")) as {
      hooks?: {
        UserPromptSubmit?: Array<{ hooks?: Array<{ command?: string }> }>;
        Stop?: Array<{
          hooks?: Array<{ command?: string; statusMessage?: string; timeout?: number }>;
        }>;
      };
    };
    // Both hooks must be present — the Stop hook is the production
    // replacement for the MCP `store_reasoning_pattern` permission
    // prompt UX, and regressing it sends users back to that prompt.
    expect(settings.hooks?.UserPromptSubmit?.length).toBe(1);
    expect(settings.hooks?.Stop?.length).toBe(1);

    const inner = settings.hooks?.Stop?.[0]?.hooks?.[0];
    expect(inner?.command).toContain("tracebase-ai");
    expect(inner?.command).toContain("capture-turn");
    expect(inner?.command).toContain("--host claude-code");
    expect(inner?.command).toContain("--capture compact");
    expect(inner?.statusMessage).toBe("▣ TB TRACE  capturing");
    // Stop hook gets a slightly larger timeout — the heuristic
    // extractor has to read the transcript and run a SQLite write,
    // which is still fast but allocates more than the inject-context
    // path's read-only query.
    expect(inner?.timeout).toBeGreaterThanOrEqual(5);
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

  it("inspect reports {present, canonical, events} based on file state", () => {
    const before = inspectAgentHookConfig(dir, "claude-code");
    expect(before.supported).toBe(true);
    expect(before.present).toBe(false);
    expect(before.canonical).toBe(false);
    // Pre-install: every managed event is marked missing.
    expect(before.events.UserPromptSubmit).toBe("missing");
    expect(before.events.Stop).toBe("missing");

    writeAgentHookConfig(dir, "claude-code", false);
    const after = inspectAgentHookConfig(dir, "claude-code");
    expect(after.supported).toBe(true);
    expect(after.present).toBe(true);
    expect(after.canonical).toBe(true);
    expect(after.events.UserPromptSubmit).toBe("canonical");
    expect(after.events.Stop).toBe("canonical");

    const cursor = inspectAgentHookConfig(dir, "cursor");
    expect(cursor.supported).toBe(false);
    expect(cursor.present).toBe(false);
    expect(cursor.canonical).toBe(false);
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

  // Zero-friction upgrade regression. The 0.4.0 hook entry had no
  // --status flag and no statusMessage; this release adds both for
  // the compact TB TRACE badge. A user re-running `npx tracebase
  // init` (without --force) after upgrading the npm package must
  // land on the new entry automatically — that is the core promise
  // of `init` in this codebase. Requiring --force here would turn
  // a routine upgrade into a visible error.
  it("upgrades the 0.4.0 default hook entry to the new badge-enabled entry without --force", () => {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify(
        {
          hooks: {
            UserPromptSubmit: [
              {
                hooks: [
                  {
                    type: "command",
                    command: "npx -y tracebase-ai@latest inject-context --host claude-code",
                    timeout: 5,
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      ),
    );

    const res = writeAgentHookConfig(dir, "claude-code", false);
    expect(res?.ok).toBe(true);
    if (!res?.ok) return;
    expect(res.kind).toBe("updated");

    const after = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf-8")) as {
      hooks: {
        UserPromptSubmit: Array<{
          hooks: Array<{ command: string; statusMessage?: string; timeout: number }>;
        }>;
      };
    };
    const inner = after.hooks.UserPromptSubmit[0]!.hooks[0]!;
    expect(inner.command).toContain("--status compact");
    expect(inner.statusMessage).toBe("▣ TB TRACE  checking");
    expect(inner.timeout).toBe(5);
    // No duplicate entries landed — the slot was reused.
    expect(after.hooks.UserPromptSubmit.length).toBe(1);
    expect(after.hooks.UserPromptSubmit[0]!.hooks.length).toBe(1);
  });

  // Regression: 0.4.1 users only had the UserPromptSubmit hook (no
  // Stop hook existed). After the Stop hook shipped in 0.4.2, a
  // re-run of `tracebase init` must auto-add it without requiring
  // --force — the existing UserPromptSubmit stays untouched if
  // already canonical, the Stop entry is appended, result kind is
  // "updated" (not an error).
  it("adds the Stop hook to an existing 0.4.1-shape settings.json without --force", () => {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify(
        {
          hooks: {
            UserPromptSubmit: [
              {
                hooks: [
                  {
                    type: "command",
                    command:
                      "npx -y tracebase-ai@latest inject-context --host claude-code --status compact",
                    timeout: 5,
                    statusMessage: "▣ TB MEMORY  checking",
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      ),
    );

    const res = writeAgentHookConfig(dir, "claude-code", false);
    expect(res?.ok).toBe(true);
    if (!res?.ok) return;
    expect(res.kind).toBe("updated");

    const after = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf-8")) as {
      hooks: {
        UserPromptSubmit: Array<{
          hooks: Array<{ command: string; statusMessage?: string }>;
        }>;
        Stop: Array<{
          hooks: Array<{ command: string; statusMessage?: string }>;
        }>;
      };
    };
    // UserPromptSubmit rebadged from TB MEMORY → TB TRACE automatically
    // via the 0.4.1/0.4.2 legacyDefault entry.
    expect(after.hooks.UserPromptSubmit[0]!.hooks[0]!.statusMessage).toBe("▣ TB TRACE  checking");
    // Stop hook newly added with current canonical shape.
    expect(after.hooks.Stop?.length).toBe(1);
    expect(after.hooks.Stop[0]!.hooks[0]!.command).toContain("capture-turn");
    expect(after.hooks.Stop[0]!.hooks[0]!.statusMessage).toBe("▣ TB TRACE  capturing");
  });

  // Regression: 0.4.2 installed both hooks but the statusMessages read
  // "TB MEMORY" (the pre-rename badge). 0.4.3 reserves TB MEMORY for a
  // different feature and rebadges reasoning reuse to TB TRACE.
  // Users on 0.4.2 must get the rebadge on a plain `tracebase init`
  // re-run — no --force prompt, no user-customisation error.
  it("rebadges 0.4.2 'TB MEMORY' statusMessages to 'TB TRACE' without --force", () => {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify(
        {
          hooks: {
            UserPromptSubmit: [
              {
                hooks: [
                  {
                    type: "command",
                    command:
                      "npx -y tracebase-ai@latest inject-context --host claude-code --status compact",
                    timeout: 5,
                    statusMessage: "▣ TB MEMORY  checking",
                  },
                ],
              },
            ],
            Stop: [
              {
                hooks: [
                  {
                    type: "command",
                    command:
                      "npx -y tracebase-ai@latest capture-turn --host claude-code --capture compact",
                    timeout: 8,
                    statusMessage: "▣ TB MEMORY  capturing",
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      ),
    );

    const res = writeAgentHookConfig(dir, "claude-code", false);
    expect(res?.ok).toBe(true);
    if (!res?.ok) return;
    expect(res.kind).toBe("updated");

    const after = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf-8")) as {
      hooks: {
        UserPromptSubmit: Array<{ hooks: Array<{ statusMessage: string }> }>;
        Stop: Array<{ hooks: Array<{ statusMessage: string }> }>;
      };
    };
    expect(after.hooks.UserPromptSubmit[0]!.hooks[0]!.statusMessage).toBe("▣ TB TRACE  checking");
    expect(after.hooks.Stop[0]!.hooks[0]!.statusMessage).toBe("▣ TB TRACE  capturing");
  });

  it("still requires --force to replace a user-customised TraceBase hook (non-default command / timeout / extras)", () => {
    // Identifiably "ours" (command mentions tracebase-ai +
    // inject-context) but with a user-added flag — we must NOT
    // silently overwrite this.
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify(
        {
          hooks: {
            UserPromptSubmit: [
              {
                hooks: [
                  {
                    type: "command",
                    command:
                      "npx -y tracebase-ai@latest inject-context --host claude-code --budget 2400",
                    timeout: 10,
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      ),
    );

    const res = writeAgentHookConfig(dir, "claude-code", false);
    expect(res?.ok).toBe(false);
    if (res?.ok) return;
    expect(res.reason).toMatch(/customised.*--force/);

    // File untouched.
    const after = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf-8")) as {
      hooks: {
        UserPromptSubmit: Array<{ hooks: Array<{ command: string; timeout: number }> }>;
      };
    };
    expect(after.hooks.UserPromptSubmit[0]!.hooks[0]!.command).toContain("--budget 2400");
    expect(after.hooks.UserPromptSubmit[0]!.hooks[0]!.timeout).toBe(10);

    // With --force, the custom shape is replaced by the canonical one.
    const forced = writeAgentHookConfig(dir, "claude-code", true);
    expect(forced?.ok).toBe(true);
    if (!forced?.ok) return;
    const afterForce = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf-8")) as {
      hooks: {
        UserPromptSubmit: Array<{
          hooks: Array<{ command: string; statusMessage?: string; timeout: number }>;
        }>;
      };
    };
    expect(afterForce.hooks.UserPromptSubmit[0]!.hooks[0]!.command).toContain("--status compact");
    expect(afterForce.hooks.UserPromptSubmit[0]!.hooks[0]!.statusMessage).toBe(
      "▣ TB TRACE  checking",
    );
    expect(afterForce.hooks.UserPromptSubmit[0]!.hooks[0]!.timeout).toBe(5);
  });
});

describe("writeAgentInstructionFile — variant per agent", () => {
  it("Claude Code gets the silent variant mentioning the <tracebase> block and delegating capture to the background hook", () => {
    writeAgentInstructionFile(dir, "claude-code");
    const content = readFileSync(join(dir, "CLAUDE.md"), "utf-8");
    expect(content).toContain("tracebase:begin");
    expect(content).toContain("<tracebase queryId");
    expect(content).toContain("silently attaches");
    // The silent variant explicitly tells the agent NOT to narrate.
    expect(content).toContain("Don't announce or narrate");
    // Regression: the default flow MUST NOT instruct Claude Code to
    // call `store_reasoning_pattern` directly. That was the v1 UX
    // users complained about — a permission prompt plus the full
    // payload dump in the transcript after every novel task. Capture
    // now runs in the background Stop hook; the instruction file
    // tells the agent that explicitly.
    expect(content).toContain("handled automatically");
    expect(content).toContain("Stop");
    expect(content).toContain("do **not** call `store_reasoning_pattern` in normal flow");
    // outcome attribution stays on the agent — hooks can't guess
    // which patterns were useful.
    expect(content).toContain("record_reasoning_outcome");
  });

  it("silent variant does NOT ask the agent to call store_reasoning_pattern in normal flow", () => {
    writeAgentInstructionFile(dir, "claude-code");
    const content = readFileSync(join(dir, "CLAUDE.md"), "utf-8");
    // The phrase "call store_reasoning_pattern" MAY appear inside
    // the "do not call … in normal flow" sentence; assert absence of
    // the old directive phrasing that pushed the agent to call it
    // after every novel case.
    expect(content).not.toContain("even if no `<tracebase>` block appeared");
    expect(content).not.toMatch(/call\s+`?store_reasoning_pattern`?\s+(with|to save)/i);
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
