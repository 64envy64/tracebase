/**
 * `tracebase inject-context` — silent hook envelope contract.
 *
 * The CLI is the bridge between a host pre-prompt hook and the
 * silent injection builder. Tests exercise the pure helper
 * `runInjectContext` directly so we don't have to spawn the CLI
 * binary (which would require a built dist) — but the helper is
 * the same code path the action calls in production, so the
 * envelope shape, exit-mode benignity, and silent-voice content
 * are all real-world checks.
 *
 * Three properties are load-bearing:
 *
 *   1. Envelope shape — every call returns one well-formed
 *      `{ hookSpecificOutput: { hookEventName, additionalContext } }`
 *      object. A malformed envelope or a thrown exception would
 *      block the user's prompt in Claude Code.
 *   2. Silent inject path actually queries the store — when the
 *      project is initialised and a matching block exists, the
 *      envelope's `additionalContext` carries a `<tracebase>`
 *      block with the situation text. The MCP tool path is not
 *      exercised — this proves the hook bypasses it entirely.
 *   3. Failure-mode benignity — uninitialised project, trivial
 *      prompt, malformed stdin, missing prompt: each path yields
 *      an empty envelope, never a throw. The hook is invisible
 *      to a user whose project hasn't been wired up.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { initConfig } from "../../src/core/config.js";
import { BlockStore } from "../../src/core/block-store.js";
import { createBlock } from "../../src/core/block.js";
import { parseStdinPayload, runInjectContext } from "../../src/cli/commands/inject-context.js";
import type { StoreBlockInput } from "../../src/types.js";

const PY_BLOCK: StoreBlockInput = {
  trigger: {
    situation: "Pytest collects the wrong package when sys.path has a shadowing module",
    invariants: { language: "python", framework: "pytest" },
  },
  body: {
    mechanism: "an earlier sys.path entry shadows the intended namespace package",
    deadEnds: [],
    unlock: "rename the shadowing module or remove its directory from sys.path",
    verification: "pytest --collect-only shows the intended package",
  },
  provenance: { sourceTaskId: "pytest-1", extractedFrom: "trajectory", distilledBy: "llm" },
};

const PY_BLOCK_ALT: StoreBlockInput = {
  trigger: {
    situation: "Pytest collection follows the wrong package when duplicate helpers shadow sys.path",
    invariants: { language: "python", framework: "pytest" },
  },
  body: {
    mechanism: "duplicate helper modules make the import resolver pick the wrong package first",
    deadEnds: [],
    unlock: "delete the duplicate helper or move it outside the collected package tree",
    verification: "pytest --collect-only lists only the intended package",
  },
  provenance: { sourceTaskId: "pytest-2", extractedFrom: "trajectory", distilledBy: "llm" },
};

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "tb-inject-ctx-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

function envelope(out: { envelope: string }): {
  hookSpecificOutput: { hookEventName: string; additionalContext: string };
  systemMessage?: string;
} {
  return JSON.parse(out.envelope);
}

function storeActive(store: BlockStore, input: StoreBlockInput): void {
  const b = createBlock(input);
  b.status = "candidate";
  store.storeBlock(b);
  store.attachCaseRef({
    blockId: b.id,
    traceId: `trace-${b.provenance.sourceTaskId}`,
    role: "origin",
    evidenceQuality: "strong",
  });
  store.updateBlockStatus(b.id, "active");
}

describe("runInjectContext — envelope shape", () => {
  it("returns a well-formed UserPromptSubmit envelope by default", () => {
    const out = runInjectContext(
      { path: projectDir },
      { prompt: "anything at all that's long enough to pass the trivial filter" },
    );
    const parsed = envelope(out);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(typeof parsed.hookSpecificOutput.additionalContext).toBe("string");
  });

  it("respects an explicit SessionStart event name", () => {
    const out = runInjectContext(
      { event: "SessionStart", path: projectDir },
      { prompt: "session-start prompt long enough for the gate" },
    );
    expect(envelope(out).hookSpecificOutput.hookEventName).toBe("SessionStart");
  });

  it("clamps unknown event names to UserPromptSubmit (safe default)", () => {
    const out = runInjectContext(
      { event: "ChaosEvent", path: projectDir },
      { prompt: "anything at all that's long enough to pass the trivial filter" },
    );
    expect(envelope(out).hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
  });
});

describe("runInjectContext — silent injection path", () => {
  it("queries the local store and returns a <tracebase> block when a pattern matches", () => {
    const config = initConfig(projectDir);
    const db = new Database(config.storagePath);
    const store = new BlockStore(db);
    storeActive(store, PY_BLOCK);
    store.close();

    const out = runInjectContext(
      { path: projectDir },
      { prompt: "pytest is collecting the wrong package — sys.path looks suspicious" },
    );
    expect(out.injected).toBe(true);
    const ctx = envelope(out).hookSpecificOutput.additionalContext;
    expect(ctx).toContain("<tracebase queryId=");
    expect(ctx).toContain("Pytest collects the wrong package");
    // Silent voice — no legacy markers.
    expect(ctx).not.toMatch(/HYPOTHES[EI]S/);
    expect(ctx).not.toContain("<sub>Audit:");
  });

  it("records injection events only for ids that survived the hook budget", () => {
    const config = initConfig(projectDir);
    const db = new Database(config.storagePath);
    const store = new BlockStore(db);
    storeActive(store, PY_BLOCK);
    storeActive(store, PY_BLOCK_ALT);
    store.close();

    const out = runInjectContext(
      { path: projectDir, budget: 1 },
      { prompt: "pytest collection wrong package sys.path shadow helper duplicate" },
    );
    const ctx = envelope(out).hookSpecificOutput.additionalContext;
    const queryId = /<tracebase queryId="([^"]+)">/.exec(ctx)?.[1];
    expect(queryId).toBeTruthy();

    const verifyStore = new BlockStore(new Database(config.storagePath));
    try {
      const events = verifyStore.readEvents({ queryId, limit: 100 });
      const injections = events.filter((ev) => ev.event === "injection");
      expect(events.filter((ev) => ev.event === "retrieval").length).toBe(1);
      expect(injections.length).toBe(1);
    } finally {
      verifyStore.close();
    }
  });
});

describe("runInjectContext — failure-mode benignity", () => {
  it("empty envelope when project is uninitialised", () => {
    const out = runInjectContext(
      { path: projectDir },
      { prompt: "real-looking task prompt with enough chars to pass" },
    );
    expect(out.injected).toBe(false);
    expect(envelope(out).hookSpecificOutput.additionalContext).toBe("");
  });

  it("empty envelope for trivial prompts", () => {
    initConfig(projectDir);
    const out = runInjectContext({ path: projectDir }, { prompt: "hi" });
    expect(out.injected).toBe(false);
    expect(envelope(out).hookSpecificOutput.additionalContext).toBe("");
  });

  it("empty envelope when stdin had no prompt at all", () => {
    initConfig(projectDir);
    const out = runInjectContext({ path: projectDir }, {});
    expect(out.injected).toBe(false);
    expect(envelope(out).hookSpecificOutput.additionalContext).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Compact-mode TB TRACE badge — systemMessage contract
//
// The badge is the only user-visible signal the hook is running. If
// the label / shape / emission conditions drift, users lose hook
// transparency and we can't tell "hook didn't fire" from "hook fired
// and found nothing". Tests here pin every branch.
// ---------------------------------------------------------------------------

describe("runInjectContext — compact status badge (systemMessage)", () => {
  it("matching pattern: systemMessage starts with ▣ TB TRACE and includes recalled count, shortId, tokens", () => {
    const config = initConfig(projectDir);
    const db = new Database(config.storagePath);
    const store = new BlockStore(db);
    storeActive(store, PY_BLOCK);
    store.close();

    const out = runInjectContext(
      { path: projectDir },
      { prompt: "pytest collects the wrong package — sys.path shadowing module issue" },
    );
    const parsed = envelope(out);
    expect(parsed.systemMessage).toBeDefined();
    const msg = parsed.systemMessage!;
    expect(msg.startsWith("▣ TB TRACE")).toBe(true);
    expect(msg).toMatch(/recalled \d+ pattern\(s\)/);
    // queryId is 8-char slice of a UUID; match only the contract
    // surface, not a specific value.
    expect(msg).toMatch(/· #[0-9a-f]{8}/i);
    expect(msg).toMatch(/· \d+t$/);
    // Spec: each status under 100 chars.
    expect(msg.length).toBeLessThan(100);
    // Double-check shortId actually matches the queryId in the body.
    const injected = parsed.hookSpecificOutput.additionalContext;
    const embeddedQueryId = /<tracebase queryId="([^"]+)">/.exec(injected)?.[1];
    expect(embeddedQueryId).toBeDefined();
    const badgeShortId = /· #([0-9a-f]+)/i.exec(msg)?.[1];
    expect(embeddedQueryId!.startsWith(badgeShortId!)).toBe(true);
  });

  it('no match (gate rejects / no results): systemMessage is exactly "▣ TB TRACE  checked · no match"', () => {
    // Project initialised, no blocks seeded → gate has nothing to
    // return → payload.hasContent is false.
    initConfig(projectDir);

    const out = runInjectContext(
      { path: projectDir },
      { prompt: "something generic enough that nothing matches in an empty store" },
    );
    const parsed = envelope(out);
    expect(parsed.systemMessage).toBe("▣ TB TRACE  checked · no match");
    // additionalContext stays empty — "no match" means no inject.
    expect(parsed.hookSpecificOutput.additionalContext).toBe("");
    expect(out.injected).toBe(false);
  });

  it("trivial prompt: no systemMessage even in compact mode (spec: by default)", () => {
    initConfig(projectDir);
    const out = runInjectContext({ path: projectDir }, { prompt: "hi" });
    const parsed = envelope(out);
    expect(parsed.systemMessage).toBeUndefined();
    expect(parsed.hookSpecificOutput.additionalContext).toBe("");
  });

  it("uninitialized project: no systemMessage (spec: by default)", () => {
    const out = runInjectContext(
      { path: projectDir },
      { prompt: "real-looking task prompt with enough chars to pass the trivial gate" },
    );
    const parsed = envelope(out);
    expect(parsed.systemMessage).toBeUndefined();
    expect(parsed.hookSpecificOutput.additionalContext).toBe("");
  });

  it('hook failure: systemMessage is "▣ TB TRACE  skipped · unavailable"', () => {
    // Simulate an inner failure by pointing at a path that WILL fail
    // inside the block-server open — e.g. init a project, then delete
    // the storage directory while preserving the config pointer so
    // better-sqlite3 can't create its file.
    initConfig(projectDir);
    // Replace .tracebase/memory.db with a directory — better-sqlite3
    // will throw on open. findProjectRoot still points at projectDir
    // because .tracebase/config.json is intact.
    const storagePath = join(projectDir, ".tracebase", "memory.db");
    rmSync(storagePath, { force: true });
    require("node:fs").mkdirSync(storagePath, { recursive: true });

    const out = runInjectContext(
      { path: projectDir },
      { prompt: "a reasonable task description that would otherwise trigger recall" },
    );
    const parsed = envelope(out);
    expect(parsed.systemMessage).toBe("▣ TB TRACE  skipped · unavailable");
    expect(parsed.hookSpecificOutput.additionalContext).toBe("");
  });
});

describe("runInjectContext — silent mode suppresses systemMessage entirely", () => {
  it("silent mode drops systemMessage on a match", () => {
    const config = initConfig(projectDir);
    const db = new Database(config.storagePath);
    const store = new BlockStore(db);
    storeActive(store, PY_BLOCK);
    store.close();

    const out = runInjectContext(
      { path: projectDir, status: "silent" },
      { prompt: "pytest collects the wrong package — sys.path shadowing module issue" },
    );
    const parsed = envelope(out);
    expect(parsed.systemMessage).toBeUndefined();
    // Silent suppresses the badge but NOT the injection itself — the
    // agent still reads the context.
    expect(parsed.hookSpecificOutput.additionalContext).toContain("<tracebase queryId=");
    expect(out.injected).toBe(true);
  });

  it("silent mode drops systemMessage on no-match too", () => {
    initConfig(projectDir);
    const out = runInjectContext(
      { path: projectDir, status: "silent" },
      { prompt: "generic prompt long enough to pass the trivial gate" },
    );
    expect(envelope(out).systemMessage).toBeUndefined();
  });

  it("TRACEBASE_HOOK_STATUS=silent env var overrides --status compact", () => {
    const config = initConfig(projectDir);
    const db = new Database(config.storagePath);
    const store = new BlockStore(db);
    storeActive(store, PY_BLOCK);
    store.close();

    const prev = process.env.TRACEBASE_HOOK_STATUS;
    process.env.TRACEBASE_HOOK_STATUS = "silent";
    try {
      const out = runInjectContext(
        { path: projectDir, status: "compact" },
        { prompt: "pytest collects the wrong package — sys.path shadowing module issue" },
      );
      expect(envelope(out).systemMessage).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.TRACEBASE_HOOK_STATUS;
      else process.env.TRACEBASE_HOOK_STATUS = prev;
    }
  });

  it("TRACEBASE_HOOK_STATUS=compact env var overrides --status silent", () => {
    const config = initConfig(projectDir);
    const db = new Database(config.storagePath);
    const store = new BlockStore(db);
    storeActive(store, PY_BLOCK);
    store.close();

    const prev = process.env.TRACEBASE_HOOK_STATUS;
    process.env.TRACEBASE_HOOK_STATUS = "compact";
    try {
      const out = runInjectContext(
        { path: projectDir, status: "silent" },
        { prompt: "pytest collects the wrong package — sys.path shadowing module issue" },
      );
      expect(envelope(out).systemMessage).toMatch(/^▣ TB TRACE/);
    } finally {
      if (prev === undefined) delete process.env.TRACEBASE_HOOK_STATUS;
      else process.env.TRACEBASE_HOOK_STATUS = prev;
    }
  });

  it("invalid --status value falls back to compact default (not an error)", () => {
    initConfig(projectDir);
    const out = runInjectContext(
      { path: projectDir, status: "quiet" }, // not a valid mode
      { prompt: "generic prompt long enough to clear the trivial gate" },
    );
    // Fell back to compact → emits the no-match badge.
    expect(envelope(out).systemMessage).toBe("▣ TB TRACE  checked · no match");
  });
});

describe("parseStdinPayload — collapses every error mode to {}", () => {
  it("returns {} on empty input", () => {
    expect(parseStdinPayload("")).toEqual({});
  });

  it("returns {} on malformed JSON", () => {
    expect(parseStdinPayload("{not valid json")).toEqual({});
  });

  it("returns {} on a JSON primitive (string / number / null)", () => {
    expect(parseStdinPayload('"a string"')).toEqual({});
    expect(parseStdinPayload("42")).toEqual({});
    expect(parseStdinPayload("null")).toEqual({});
  });

  it("parses a well-formed object", () => {
    expect(parseStdinPayload('{"prompt":"hello"}')).toEqual({ prompt: "hello" });
  });

  it("rejects oversized payloads (returns {})", () => {
    const oversize = '{"prompt":"' + "x".repeat(300_000) + '"}';
    expect(parseStdinPayload(oversize)).toEqual({});
  });
});
