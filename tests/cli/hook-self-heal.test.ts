/**
 * `src/cli/hook-self-heal.ts` + `selfHealClaudeHookConfig`
 * (PLAN-0.5.6 §1 / §6).
 *
 * Eight scenarios pinned down per the spec:
 *   1. stale 0.5.2 config without PostToolBatch → self-heal adds it
 *   2. canonical config → no-op (no write)
 *   3. legacy default shape → upgraded
 *   4. user-customised TraceBase hook → not overwritten, surfaced as `skippedCustom`
 *   5. foreign hooks preserved
 *   6. throttle prevents repeated writes within the window
 *   7. version change bypasses throttle once
 *   8. malformed settings.json → no throw, error surfaced
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureManagedHooksCurrent,
  readHookHealth,
} from "../../src/cli/hook-self-heal.js";
import {
  HOOKS_INJECT_COMMAND,
  HOOKS_CAPTURE_COMMAND,
  HOOKS_PRECOMPACT_COMMAND,
  HOOKS_POSTTOOLBATCH_COMMAND,
  HOOKS_PRETOOLUSE_COMMAND,
  selfHealClaudeHookConfig,
} from "../../src/cli/install-targets.js";

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "tb-self-heal-"));
  // The throttle reads .tracebase/hook-health.json; bootstrapping
  // .tracebase/ here mirrors what `initConfig` would do without
  // dragging the full config writer into every test.
  mkdirSync(join(projectDir, ".tracebase"), { recursive: true });
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

function writeSettings(hooks: Record<string, unknown[]>): void {
  const dir = join(projectDir, ".claude");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ hooks }, null, 2));
}

function readSettings(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(projectDir, ".claude", "settings.json"), "utf-8"),
  ) as Record<string, unknown>;
}

function canonicalEntryFor(command: string, statusMessage: string, timeout: number) {
  return {
    hooks: [
      {
        type: "command",
        command,
        timeout,
        statusMessage,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// 1 — stale 0.5.2 config (UserPromptSubmit + Stop + PreCompact only) →
// self-heal adds PostToolBatch
// ---------------------------------------------------------------------------

describe("ensureManagedHooksCurrent — stale 0.5.2 config", () => {
  it("adds PostToolBatch when only the older three events are present", () => {
    writeSettings({
      UserPromptSubmit: [
        canonicalEntryFor(HOOKS_INJECT_COMMAND, "▣ TB TRACE  checking", 5),
      ],
      Stop: [
        canonicalEntryFor(HOOKS_CAPTURE_COMMAND, "▣ TB TRACE  capturing", 8),
      ],
      PreCompact: [
        canonicalEntryFor(HOOKS_PRECOMPACT_COMMAND, "▣ TB CONTEXT  capturing", 10),
      ],
    });

    const result = ensureManagedHooksCurrent(projectDir, "claude-code", {
      packageVersion: "0.5.6",
    });
    expect(result.attempted).toBe(true);
    expect(result.selfHeal?.fileWritten).toBe(true);
    // 0.7.0-rc.4 — PreToolUse is also added on first heal because
    // the rc.2/rc.3 stale-config doesn't carry it yet.
    expect(result.selfHeal?.updated).toEqual(["PostToolBatch", "PreToolUse"]);
    expect(result.selfHeal?.skippedCustom).toEqual([]);

    const settings = readSettings();
    const hooks = settings.hooks as Record<string, unknown[]>;
    expect(hooks.UserPromptSubmit).toHaveLength(1);
    expect(hooks.PostToolBatch).toHaveLength(1);
    expect(hooks.PreToolUse).toHaveLength(1);
    const postEntry = (hooks.PostToolBatch as Array<{ hooks: Array<{ command: string }> }>)[0];
    expect(postEntry.hooks[0].command).toBe(HOOKS_POSTTOOLBATCH_COMMAND);
  });
});

// ---------------------------------------------------------------------------
// 2 — fully canonical config → no-op (no write, no marker bump beyond
// throttle metadata)
// ---------------------------------------------------------------------------

describe("ensureManagedHooksCurrent — fully canonical", () => {
  it("does not rewrite the file when every event is current", () => {
    // 0.7.0-rc.4 — fully canonical includes PreToolUse now.
    writeSettings({
      UserPromptSubmit: [
        canonicalEntryFor(HOOKS_INJECT_COMMAND, "▣ TB TRACE  checking", 5),
      ],
      Stop: [
        canonicalEntryFor(HOOKS_CAPTURE_COMMAND, "▣ TB TRACE  capturing", 8),
      ],
      PreCompact: [
        canonicalEntryFor(HOOKS_PRECOMPACT_COMMAND, "▣ TB CONTEXT  capturing", 10),
      ],
      PostToolBatch: [
        canonicalEntryFor(HOOKS_POSTTOOLBATCH_COMMAND, "▣ TB TOOL  observing", 5),
      ],
      PreToolUse: [
        canonicalEntryFor(HOOKS_PRETOOLUSE_COMMAND, "▣ TB TOOL  guarding", 2),
      ],
    });
    const before = readFileSync(join(projectDir, ".claude", "settings.json"), "utf-8");
    const result = ensureManagedHooksCurrent(projectDir, "claude-code", {
      packageVersion: "0.5.6",
    });
    expect(result.attempted).toBe(true);
    expect(result.selfHeal?.fileWritten).toBe(false);
    expect(result.selfHeal?.updated).toEqual([]);
    expect(result.selfHeal?.skippedCustom).toEqual([]);
    const after = readFileSync(join(projectDir, ".claude", "settings.json"), "utf-8");
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 3 — legacy default shape (the 0.4.0 inject-context entry) → upgraded
// ---------------------------------------------------------------------------

describe("ensureManagedHooksCurrent — legacy default upgrade", () => {
  it("upgrades the 0.4.0 inject-context shape to current canonical", () => {
    writeSettings({
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
    });
    const result = ensureManagedHooksCurrent(projectDir, "claude-code", {
      packageVersion: "0.5.6",
    });
    expect(result.selfHeal?.fileWritten).toBe(true);
    // UserPromptSubmit upgraded + Stop / PreCompact / PostToolBatch /
    // PreToolUse added (rc.4 ships PreToolUse).
    expect(result.selfHeal?.updated).toEqual([
      "UserPromptSubmit",
      "Stop",
      "PreCompact",
      "PostToolBatch",
      "PreToolUse",
    ]);
    const hooks = readSettings().hooks as Record<string, Array<{ hooks: Array<{ command: string; statusMessage?: string }> }>>;
    const upd = hooks.UserPromptSubmit[0]!.hooks[0]!;
    expect(upd.command).toBe(HOOKS_INJECT_COMMAND);
    expect(upd.statusMessage).toBe("▣ TB TRACE  checking");
  });
});

// ---------------------------------------------------------------------------
// 4 — user-customised TraceBase hook → NOT overwritten; reported as skipped
// ---------------------------------------------------------------------------

describe("ensureManagedHooksCurrent — customised entry preserved", () => {
  it("does not overwrite a TraceBase hook with a non-default timeout", () => {
    writeSettings({
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: "command",
              command: HOOKS_INJECT_COMMAND, // ours
              timeout: 30, // user bumped it
              statusMessage: "▣ TB TRACE  checking",
            },
          ],
        },
      ],
    });
    const result = ensureManagedHooksCurrent(projectDir, "claude-code", {
      packageVersion: "0.5.6",
    });
    expect(result.selfHeal?.skippedCustom).toContain("UserPromptSubmit");
    // Still added the missing siblings.
    expect(result.selfHeal?.updated).toContain("Stop");
    expect(result.selfHeal?.updated).toContain("PreCompact");
    expect(result.selfHeal?.updated).toContain("PostToolBatch");
    expect(result.selfHeal?.updated).toContain("PreToolUse");
    expect(result.selfHeal?.updated).not.toContain("UserPromptSubmit");
    // The user's customised entry is byte-identical after the heal.
    const hooks = readSettings().hooks as Record<string, Array<{ hooks: Array<{ timeout: number }> }>>;
    expect(hooks.UserPromptSubmit[0]!.hooks[0]!.timeout).toBe(30);
  });

  it("does not overwrite a TraceBase hook with extra fields", () => {
    writeSettings({
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: "command",
              command: HOOKS_INJECT_COMMAND,
              timeout: 5,
              statusMessage: "▣ TB TRACE  checking",
              extraUserField: "left-by-user", // extra field
            },
          ],
        },
      ],
    });
    const result = ensureManagedHooksCurrent(projectDir, "claude-code", {
      packageVersion: "0.5.6",
    });
    expect(result.selfHeal?.skippedCustom).toContain("UserPromptSubmit");
    const hooks = readSettings().hooks as Record<string, Array<{ hooks: Array<{ extraUserField?: string }> }>>;
    expect(hooks.UserPromptSubmit[0]!.hooks[0]!.extraUserField).toBe("left-by-user");
  });
});

// ---------------------------------------------------------------------------
// 5 — foreign hooks (third-party UserPromptSubmit) preserved alongside ours
// ---------------------------------------------------------------------------

describe("ensureManagedHooksCurrent — foreign hooks preserved", () => {
  it("never touches a non-TraceBase entry", () => {
    writeSettings({
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: "command",
              command: "npx some-other-tool --on-prompt",
              timeout: 3,
            },
          ],
        },
      ],
    });
    const result = ensureManagedHooksCurrent(projectDir, "claude-code", {
      packageVersion: "0.5.6",
    });
    expect(result.selfHeal?.fileWritten).toBe(true);
    const hooks = readSettings().hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    // Foreign entry first, ours appended.
    expect(hooks.UserPromptSubmit).toHaveLength(2);
    expect(hooks.UserPromptSubmit[0]!.hooks[0]!.command).toBe(
      "npx some-other-tool --on-prompt",
    );
    expect(hooks.UserPromptSubmit[1]!.hooks[0]!.command).toBe(HOOKS_INJECT_COMMAND);
  });
});

// ---------------------------------------------------------------------------
// 6 — throttle prevents repeated writes within the window
// ---------------------------------------------------------------------------

describe("ensureManagedHooksCurrent — throttle window", () => {
  it("second call within the throttle window is a no-op", () => {
    writeSettings({
      UserPromptSubmit: [
        canonicalEntryFor(HOOKS_INJECT_COMMAND, "▣ TB TRACE  checking", 5),
      ],
    });
    let now = 1000;
    const first = ensureManagedHooksCurrent(projectDir, "claude-code", {
      packageVersion: "0.5.6",
      throttleMs: 60_000,
      now: () => now,
    });
    expect(first.attempted).toBe(true);
    expect(first.selfHeal?.fileWritten).toBe(true);

    now += 30_000; // 30 s — still within throttle
    const second = ensureManagedHooksCurrent(projectDir, "claude-code", {
      packageVersion: "0.5.6",
      throttleMs: 60_000,
      now: () => now,
    });
    expect(second.attempted).toBe(false);
    expect(second.throttledReason).toBe("fresh-marker");
  });

  it("third call after the throttle window elapses runs again", () => {
    writeSettings({
      UserPromptSubmit: [
        canonicalEntryFor(HOOKS_INJECT_COMMAND, "▣ TB TRACE  checking", 5),
      ],
    });
    let now = 1_000;
    ensureManagedHooksCurrent(projectDir, "claude-code", {
      packageVersion: "0.5.6",
      throttleMs: 60_000,
      now: () => now,
    });
    now += 90_000; // past 60 s window
    const second = ensureManagedHooksCurrent(projectDir, "claude-code", {
      packageVersion: "0.5.6",
      throttleMs: 60_000,
      now: () => now,
    });
    expect(second.attempted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7 — version change bypasses throttle once
// ---------------------------------------------------------------------------

describe("ensureManagedHooksCurrent — version drift bypass", () => {
  it("a different packageVersion triggers a re-check inside the throttle window", () => {
    writeSettings({
      UserPromptSubmit: [
        canonicalEntryFor(HOOKS_INJECT_COMMAND, "▣ TB TRACE  checking", 5),
      ],
    });
    let now = 1_000;
    ensureManagedHooksCurrent(projectDir, "claude-code", {
      packageVersion: "0.5.6",
      throttleMs: 60_000,
      now: () => now,
    });
    now += 5_000; // 5 s — way inside throttle
    const second = ensureManagedHooksCurrent(projectDir, "claude-code", {
      packageVersion: "0.5.7", // drift
      throttleMs: 60_000,
      now: () => now,
    });
    expect(second.attempted).toBe(true);
    const health = readHookHealth(projectDir);
    expect(health.lastSeenPackageVersion).toBe("0.5.7");
  });
});

// ---------------------------------------------------------------------------
// 8 — malformed settings.json → no throw, error surfaced
// ---------------------------------------------------------------------------

describe("ensureManagedHooksCurrent — malformed settings.json", () => {
  it("never throws; surfaces a parse error", () => {
    const dir = join(projectDir, ".claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), "{not valid json");
    const result = ensureManagedHooksCurrent(projectDir, "claude-code", {
      packageVersion: "0.5.6",
    });
    expect(result.attempted).toBe(true);
    expect(result.selfHeal?.fileWritten).toBe(false);
    expect(result.selfHeal?.error).toMatch(/parse:/);
  });

  it("missing settings.json is a clean no-op (no write, no error)", () => {
    // No writeSettings() call → file absent.
    const result = ensureManagedHooksCurrent(projectDir, "claude-code", {
      packageVersion: "0.5.6",
    });
    expect(result.attempted).toBe(true);
    expect(result.selfHeal?.fileWritten).toBe(false);
    expect(result.selfHeal?.error).toBeUndefined();
    expect(existsSync(join(projectDir, ".claude", "settings.json"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Bonus — non-claude-code agents short-circuit
// ---------------------------------------------------------------------------

describe("ensureManagedHooksCurrent — non-claude-code agents", () => {
  it("cursor short-circuits without touching the filesystem", () => {
    writeSettings({});
    const result = ensureManagedHooksCurrent(projectDir, "cursor", {
      packageVersion: "0.5.6",
    });
    expect(result.attempted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Direct selfHealClaudeHookConfig coverage — caller can invoke it
// without the throttle when force-driven (e.g. `tracebase init`).
// ---------------------------------------------------------------------------

describe("selfHealClaudeHookConfig — direct call", () => {
  it("returns a result object even when the file doesn't exist", () => {
    const result = selfHealClaudeHookConfig(projectDir);
    expect(result.checked).toEqual([
      "UserPromptSubmit",
      "Stop",
      "PreCompact",
      "PostToolBatch",
      "PreToolUse",
    ]);
    expect(result.fileWritten).toBe(false);
    expect(result.updated).toEqual([]);
  });
});
