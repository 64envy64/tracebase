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
  it("returns a well-formed UserPromptSubmit envelope by default", async () => {
    const out = await runInjectContext(
      { path: projectDir },
      { prompt: "anything at all that's long enough to pass the trivial filter" },
    );
    const parsed = envelope(out);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(typeof parsed.hookSpecificOutput.additionalContext).toBe("string");
  });

  it("respects an explicit SessionStart event name", async () => {
    const out = await runInjectContext(
      { event: "SessionStart", path: projectDir },
      { prompt: "session-start prompt long enough for the gate" },
    );
    expect(envelope(out).hookSpecificOutput.hookEventName).toBe("SessionStart");
  });

  it("clamps unknown event names to UserPromptSubmit (safe default)", async () => {
    const out = await runInjectContext(
      { event: "ChaosEvent", path: projectDir },
      { prompt: "anything at all that's long enough to pass the trivial filter" },
    );
    expect(envelope(out).hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
  });
});

describe("runInjectContext — silent injection path", () => {
  it("queries the local store and returns a <tracebase> block when a pattern matches", async () => {
    const config = initConfig(projectDir);
    const db = new Database(config.storagePath);
    const store = new BlockStore(db);
    storeActive(store, PY_BLOCK);
    store.close();

    const out = await runInjectContext(
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

  it("records injection events only for ids that survived the hook budget", async () => {
    const config = initConfig(projectDir);
    const db = new Database(config.storagePath);
    const store = new BlockStore(db);
    storeActive(store, PY_BLOCK);
    storeActive(store, PY_BLOCK_ALT);
    store.close();

    const out = await runInjectContext(
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
  it("empty envelope when project is uninitialised", async () => {
    const out = await runInjectContext(
      { path: projectDir },
      { prompt: "real-looking task prompt with enough chars to pass" },
    );
    expect(out.injected).toBe(false);
    expect(envelope(out).hookSpecificOutput.additionalContext).toBe("");
  });

  it("empty envelope for trivial prompts", async () => {
    initConfig(projectDir);
    const out = await runInjectContext({ path: projectDir }, { prompt: "hi" });
    expect(out.injected).toBe(false);
    expect(envelope(out).hookSpecificOutput.additionalContext).toBe("");
  });

  it("empty envelope when stdin had no prompt at all", async () => {
    initConfig(projectDir);
    const out = await runInjectContext({ path: projectDir }, {});
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
  it("matching pattern: systemMessage starts with ▣ TB TRACE and includes recalled count, shortId, tokens", async () => {
    const config = initConfig(projectDir);
    const db = new Database(config.storagePath);
    const store = new BlockStore(db);
    storeActive(store, PY_BLOCK);
    store.close();

    const out = await runInjectContext(
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

  it('no match (gate rejects / no results): systemMessage is exactly "▣ TB TRACE  checked · no match"', async () => {
    // Project initialised, no blocks seeded → gate has nothing to
    // return → payload.hasContent is false.
    initConfig(projectDir);

    const out = await runInjectContext(
      { path: projectDir },
      { prompt: "something generic enough that nothing matches in an empty store" },
    );
    const parsed = envelope(out);
    expect(parsed.systemMessage).toBe("▣ TB TRACE  checked · no match");
    // additionalContext stays empty — "no match" means no inject.
    expect(parsed.hookSpecificOutput.additionalContext).toBe("");
    expect(out.injected).toBe(false);
  });

  it("trivial prompt: no systemMessage even in compact mode (spec: by default)", async () => {
    initConfig(projectDir);
    const out = await runInjectContext({ path: projectDir }, { prompt: "hi" });
    const parsed = envelope(out);
    expect(parsed.systemMessage).toBeUndefined();
    expect(parsed.hookSpecificOutput.additionalContext).toBe("");
  });

  it("uninitialized project: no systemMessage (spec: by default)", async () => {
    const out = await runInjectContext(
      { path: projectDir },
      { prompt: "real-looking task prompt with enough chars to pass the trivial gate" },
    );
    const parsed = envelope(out);
    expect(parsed.systemMessage).toBeUndefined();
    expect(parsed.hookSpecificOutput.additionalContext).toBe("");
  });

  it('hook failure: systemMessage is "▣ TB TRACE  skipped · unavailable"', async () => {
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

    const out = await runInjectContext(
      { path: projectDir },
      { prompt: "a reasonable task description that would otherwise trigger recall" },
    );
    const parsed = envelope(out);
    expect(parsed.systemMessage).toBe("▣ TB TRACE  skipped · unavailable");
    expect(parsed.hookSpecificOutput.additionalContext).toBe("");
  });
});

describe("runInjectContext — silent mode suppresses systemMessage entirely", () => {
  it("silent mode drops systemMessage on a match", async () => {
    const config = initConfig(projectDir);
    const db = new Database(config.storagePath);
    const store = new BlockStore(db);
    storeActive(store, PY_BLOCK);
    store.close();

    const out = await runInjectContext(
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

  it("silent mode drops systemMessage on no-match too", async () => {
    initConfig(projectDir);
    const out = await runInjectContext(
      { path: projectDir, status: "silent" },
      { prompt: "generic prompt long enough to pass the trivial gate" },
    );
    expect(envelope(out).systemMessage).toBeUndefined();
  });

  it("TRACEBASE_HOOK_STATUS=silent env var overrides --status compact", async () => {
    const config = initConfig(projectDir);
    const db = new Database(config.storagePath);
    const store = new BlockStore(db);
    storeActive(store, PY_BLOCK);
    store.close();

    const prev = process.env.TRACEBASE_HOOK_STATUS;
    process.env.TRACEBASE_HOOK_STATUS = "silent";
    try {
      const out = await runInjectContext(
        { path: projectDir, status: "compact" },
        { prompt: "pytest collects the wrong package — sys.path shadowing module issue" },
      );
      expect(envelope(out).systemMessage).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.TRACEBASE_HOOK_STATUS;
      else process.env.TRACEBASE_HOOK_STATUS = prev;
    }
  });

  it("TRACEBASE_HOOK_STATUS=compact env var overrides --status silent", async () => {
    const config = initConfig(projectDir);
    const db = new Database(config.storagePath);
    const store = new BlockStore(db);
    storeActive(store, PY_BLOCK);
    store.close();

    const prev = process.env.TRACEBASE_HOOK_STATUS;
    process.env.TRACEBASE_HOOK_STATUS = "compact";
    try {
      const out = await runInjectContext(
        { path: projectDir, status: "silent" },
        { prompt: "pytest collects the wrong package — sys.path shadowing module issue" },
      );
      expect(envelope(out).systemMessage).toMatch(/^▣ TB TRACE/);
    } finally {
      if (prev === undefined) delete process.env.TRACEBASE_HOOK_STATUS;
      else process.env.TRACEBASE_HOOK_STATUS = prev;
    }
  });

  it("invalid --status value falls back to compact default (not an error)", async () => {
    initConfig(projectDir);
    const out = await runInjectContext(
      { path: projectDir, status: "quiet" }, // not a valid mode
      { prompt: "generic prompt long enough to clear the trivial gate" },
    );
    // Fell back to compact → emits the no-match badge.
    expect(envelope(out).systemMessage).toBe("▣ TB TRACE  checked · no match");
  });
});

// ---------------------------------------------------------------------------
// Composite TB TRACE + TB MEMORY badge — §2 PLAN-0.5
// ---------------------------------------------------------------------------

describe("runInjectContext — composite TB TRACE + TB MEMORY badge", () => {
  it("emits ONLY TB TRACE half when no facts are recalled", async () => {
    const config = initConfig(projectDir);
    const db = new Database(config.storagePath);
    const store = new BlockStore(db);
    storeActive(store, PY_BLOCK);
    store.close();
    const out = await runInjectContext(
      { path: projectDir },
      { prompt: "pytest is collecting the wrong package — sys.path shadow issue" },
    );
    const msg = JSON.parse(out.envelope).systemMessage as string;
    expect(msg.startsWith("▣ TB TRACE  recalled ")).toBe(true);
    expect(msg).not.toContain("TB MEMORY");
  });

  it("composes BOTH halves when patterns AND facts both recall", async () => {
    const config = initConfig(projectDir);
    const db = new Database(config.storagePath);
    const store = new BlockStore(db);
    storeActive(store, PY_BLOCK);
    // Seed a relevant fact so recall returns both.
    store.storeFact({
      scope: "project",
      factType: "file_semantic",
      statement: "pytest collection is sensitive to sys.path order in monorepos",
      invariants: { language: "python", framework: "pytest" },
      source: { origin: "observed" },
    });
    store.close();
    const out = await runInjectContext(
      { path: projectDir },
      { prompt: "pytest is collecting the wrong package — sys.path shadow in monorepo" },
    );
    const msg = JSON.parse(out.envelope).systemMessage as string;
    // Ordering: TB TRACE first, then TB MEMORY; separator `·`; tail `· #<id> · <T>t`.
    expect(msg).toMatch(/^▣ TB TRACE  recalled \d+ pattern\(s\)/);
    expect(msg).toMatch(/· ▣ TB MEMORY  recalled \d+ fact\(s\)/);
    expect(msg).toMatch(/· #[0-9a-f]{8} · \d+t$/);
    expect(msg.length).toBeLessThan(100);
  });

  it("omits separators when one half is zero — never a dangling `·`", async () => {
    const config = initConfig(projectDir);
    const db = new Database(config.storagePath);
    const store = new BlockStore(db);
    // Only a fact — no blocks.
    store.storeFact({
      scope: "project",
      factType: "file_semantic",
      statement: "pytest collection is sensitive to sys.path order",
      invariants: { language: "python", framework: "pytest" },
      source: { origin: "observed" },
    });
    store.close();
    const out = await runInjectContext(
      { path: projectDir },
      { prompt: "pytest collection sys.path shadow — what's the convention here?" },
    );
    const msg = JSON.parse(out.envelope).systemMessage as string;
    if (msg && msg.startsWith("▣ TB MEMORY")) {
      // When facts matched but no patterns did, the badge is MEMORY-only.
      expect(msg).not.toContain("TB TRACE");
      expect(msg).not.toMatch(/^·/);
      expect(msg).not.toMatch(/· · /);
    }
  });
});

describe("parseStdinPayload — collapses every error mode to {}", () => {
  it("returns {} on empty input", async () => {
    expect(parseStdinPayload("")).toEqual({});
  });

  it("returns {} on malformed JSON", async () => {
    expect(parseStdinPayload("{not valid json")).toEqual({});
  });

  it("returns {} on a JSON primitive (string / number / null)", async () => {
    expect(parseStdinPayload('"a string"')).toEqual({});
    expect(parseStdinPayload("42")).toEqual({});
    expect(parseStdinPayload("null")).toEqual({});
  });

  it("parses a well-formed object", async () => {
    expect(parseStdinPayload('{"prompt":"hello"}')).toEqual({ prompt: "hello" });
  });

  it("rejects oversized payloads (returns {})", async () => {
    const oversize = '{"prompt":"' + "x".repeat(300_000) + '"}';
    expect(parseStdinPayload(oversize)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Session-scoped recall — TB CONTEXT cross-compaction continuity (0.5.2)
//
// When `session_id` is in the UserPromptSubmit stdin, recall narrows
// to `project.session.<sha>` so the digest captured by capture-context
// before /compact lands in the additionalContext of the FIRST turn
// after compaction. Sibling sessions' digests stay isolated because
// project.session.A is never a prefix of project.session.B.
// ---------------------------------------------------------------------------

describe("runInjectContext — session-scoped fact recall (TB CONTEXT)", () => {
  it("re-injects a same-session digest after compact", async () => {
    const config = initConfig(projectDir);
    const db = new Database(config.storagePath);
    const store = new BlockStore(db);
    // Seed a session digest at project.session.<sha-for-S1>.
    const { sessionScope } = await import("../../src/cli/commands/capture-context.js");
    store.storeFact({
      scope: sessionScope("S1"),
      factType: "session_digest",
      statement:
        "Recent user questions:\n- pytest fix needed\n\nDiscussion topics:\n- pytest collection sys.path shadow",
      invariants: {},
      source: { origin: "observed", reference: "S1" },
      ttlDays: 14,
    });
    store.close();

    const out = await runInjectContext(
      { path: projectDir },
      {
        prompt: "Continue helping me with the pytest collection sys.path shadow problem from earlier.",
        session_id: "S1",
      },
    );
    const ctx = JSON.parse(out.envelope).hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain("pytest collection sys.path shadow");
  });

  it("does NOT inject a digest from a different session", async () => {
    const config = initConfig(projectDir);
    const db = new Database(config.storagePath);
    const store = new BlockStore(db);
    const { sessionScope } = await import("../../src/cli/commands/capture-context.js");
    // Seed digest under session A.
    store.storeFact({
      scope: sessionScope("session-A"),
      factType: "session_digest",
      statement: "Recent user questions:\n- some unique-token from session A's conversation",
      invariants: {},
      source: { origin: "observed", reference: "session-A" },
      ttlDays: 14,
    });
    store.close();

    // Query under session B with a prompt that would otherwise match
    // by FTS keywords.
    const out = await runInjectContext(
      { path: projectDir },
      {
        prompt:
          "What was the unique-token discussion about in the previous compaction we were just doing?",
        session_id: "session-B",
      },
    );
    const ctx = JSON.parse(out.envelope).hookSpecificOutput.additionalContext as string;
    // The digest text must NOT cross session boundaries.
    expect(ctx).not.toContain("unique-token from session A");
  });

  it("still surfaces project-level facts when a session_id is present", async () => {
    const config = initConfig(projectDir);
    const db = new Database(config.storagePath);
    const store = new BlockStore(db);
    // Seed a project-scoped TB MEMORY fact.
    store.storeFact({
      scope: "project",
      factType: "file_semantic",
      statement: "tests live under tests/cli/*.test.ts (vitest suite)",
      invariants: {},
      source: { origin: "observed" },
    });
    store.close();

    const out = await runInjectContext(
      { path: projectDir },
      {
        prompt: "Where does the cli vitest suite live in this codebase exactly?",
        session_id: "S2",
      },
    );
    const ctx = JSON.parse(out.envelope).hookSpecificOutput.additionalContext as string;
    // project-scoped facts ARE prefix-parents of project.session.<S2>,
    // so hierarchical resolution surfaces them.
    expect(ctx).toContain("tests/cli");
  });
});

// ---------------------------------------------------------------------------
// 0.5.3 — TB TOOL / TB LOOP detector composes into the badge.
//
// The detector reads tool_observations rows the previous turn's
// PostToolBatch hook wrote. We seed the rows directly here to avoid
// taking a dependency on the capture-tool-use code path.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 0.7.0-rc.6 hardening 3 — JSON envelope shape regression.
//
// The envelope MUST be a single-line JSON string (no pretty-print)
// AND MUST round-trip cleanly through JSON.parse, even when the
// embedded additionalContext carries multi-line content (the
// rendered <tracebase> block, <file_memory>, <context_fold>
// sections all use real newlines internally).
//
// Pre-hardening this was structurally correct (`JSON.stringify`
// with no spacer arg defaults to single-line), but no test pinned
// it — a stray `JSON.stringify(obj, null, 2)` in a future
// refactor would have shipped pretty-printed envelopes that
// some hosts may parse but most won't.
// ---------------------------------------------------------------------------

describe("runInjectContext — JSON envelope shape", () => {
  it("envelope is single-line JSON (no pretty-print) and round-trips through JSON.parse", async () => {
    // Plant enough state to make additionalContext multi-line:
    //   - one block (forces a `<tracebase>` block bullet)
    //   - one fact (forces a Project facts: section)
    //   - one session chunk (forces a `<context_fold>` section)
    const config = initConfig(projectDir);
    const db = new Database(config.storagePath);
    const store = new BlockStore(db);
    const { sessionScope } = await import("../../src/cli/commands/capture-context.js");
    // Block.
    const b = createBlock({
      trigger: {
        situation: "Pytest collects the wrong package due to sys.path shadow",
        invariants: { language: "python", framework: "pytest" },
      },
      body: {
        mechanism: "an earlier sys.path entry shadows the intended package",
        deadEnds: [],
        unlock: "rename the shadowing module or remove its directory from sys.path",
        verification: "pytest --collect-only shows the intended package",
      },
      provenance: {
        sourceTaskId: "envelope-1",
        extractedFrom: "trajectory",
        distilledBy: "llm",
      },
    } satisfies StoreBlockInput);
    b.status = "candidate";
    store.storeBlock(b);
    store.attachCaseRef({
      blockId: b.id,
      traceId: "trace-envelope-1",
      role: "origin",
      evidenceQuality: "strong",
    });
    store.updateBlockStatus(b.id, "active");
    // Fact.
    store.storeFact({
      scope: sessionScope("S-envelope"),
      factType: "session_digest",
      statement: "Recent: pytest sys.path shadow troubleshooting in this codebase",
      invariants: {},
      source: { origin: "observed", reference: "S-envelope" },
      ttlDays: 14,
    });
    // Session chunk.
    const { foldTurns } = await import("../../src/core/context-fold.js");
    const turns: Array<{ role: "user" | "assistant"; content: string }> = [];
    for (let i = 0; i < 16; i++) {
      turns.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `pytest sys.path shadow turn ${i} content padding `.repeat(5),
      });
    }
    const folded = foldTurns({
      sessionId: "S-envelope",
      turns,
      existingWatermark: -1,
    });
    store.recordSessionChunks(folded.chunks);
    store.close();

    const out = await runInjectContext(
      { path: projectDir },
      {
        prompt:
          "Continue helping me with the pytest sys.path shadow troubleshooting from before",
        session_id: "S-envelope",
      },
    );

    // 1) Single-line: no pretty-print indentation. The serialized
    //    string must not contain `\n  "` (two-space indent) or
    //    `\n    "` (four-space) — those are the canonical
    //    pretty-print shapes a stray `JSON.stringify(obj, null, 2)`
    //    would emit.
    expect(out.envelope).not.toMatch(/\n\s{2,}"/);
    // The envelope ALSO must not start with "{\n" — pretty-print
    // always breaks the line right after the opening brace.
    expect(out.envelope).not.toMatch(/^\{\s*\n/);

    // 2) Parses cleanly via JSON.parse — no extraneous bytes,
    //    quotes balanced, escapes intact.
    let parsed: unknown;
    expect(() => {
      parsed = JSON.parse(out.envelope);
    }).not.toThrow();
    expect(parsed).toBeDefined();
    expect(typeof parsed).toBe("object");
    const env = parsed as {
      hookSpecificOutput?: { additionalContext?: string };
      systemMessage?: string;
    };

    // 3) The multi-line additionalContext survives the
    //    stringify→parse round-trip. Internal `\n` in the
    //    rendered <tracebase> block becomes `\\n` in the JSON
    //    string, and JSON.parse decodes them back to real
    //    newlines.
    const ctx = env.hookSpecificOutput?.additionalContext;
    expect(typeof ctx).toBe("string");
    expect(ctx).toContain("\n"); // real newline, post-parse
    expect(ctx).toContain("<tracebase queryId=");
    // And the embedded sections show up because we seeded all three.
    expect(ctx).toContain("Project facts:");
    expect(ctx).toContain("<context_fold>");
  });
});

// ---------------------------------------------------------------------------
// 0.7.0-rc.6 hardening — TB CONTEXT badge surfaces in Claude Code's
// composite systemMessage when <context_fold> was injected.
// ---------------------------------------------------------------------------

describe("runInjectContext — TB CONTEXT composite badge (rc.6 hardening)", () => {
  it("composite systemMessage includes ▣ TB CONTEXT when chunks render", async () => {
    const config = initConfig(projectDir);
    const db = new Database(config.storagePath);
    const store = new BlockStore(db);

    // Seed 16 turns of meaty content for session S-ctx so two
    // chunks fold + one would surface on the prompt-aware recall.
    const { foldTurns } = await import("../../src/core/context-fold.js");
    const turns: Array<{ role: "user" | "assistant"; content: string }> = [];
    for (let i = 0; i < 16; i++) {
      turns.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `kerberos auth helper signing tokens turn ${i} padding `.repeat(5),
      });
    }
    const folded = foldTurns({
      sessionId: "S-ctx",
      turns,
      existingWatermark: -1,
    });
    store.recordSessionChunks(folded.chunks);
    expect(store.countSessionChunks("S-ctx")).toBeGreaterThan(0);
    store.close();

    const out = await runInjectContext(
      { path: projectDir },
      {
        prompt: "Continue with the kerberos auth helper signing tokens",
        session_id: "S-ctx",
      },
    );
    const env = JSON.parse(out.envelope) as {
      systemMessage?: string;
      hookSpecificOutput?: { additionalContext?: string };
    };
    // Composite badge MUST include the TB CONTEXT bullet.
    expect(env.systemMessage).toMatch(/▣ TB CONTEXT\s+folded \d+ turns/);
    // And the additionalContext carries the chunk-fold section.
    expect(env.hookSpecificOutput?.additionalContext).toContain("<context_fold>");
  });
});

describe("runInjectContext — TB TOOL / TB LOOP composite badges", () => {
  it("flags a straight loop with `▣ TB LOOP  straight × N (Tool)`", async () => {
    const cfg = initConfig(projectDir);
    const db = new Database(cfg.storagePath);
    const store = new BlockStore(db);
    // Three identical Reads in the session — straight loop.
    store.recordToolObservations([
      { sessionId: "S-loop", batchOrder: 0, toolName: "Read", argSummary: "Read(src/a.ts)", argKey: "kA" },
      { sessionId: "S-loop", batchOrder: 1, toolName: "Read", argSummary: "Read(src/a.ts)", argKey: "kA" },
      { sessionId: "S-loop", batchOrder: 2, toolName: "Read", argSummary: "Read(src/a.ts)", argKey: "kA" },
    ]);
    store.close();

    const out = await runInjectContext(
      { path: projectDir },
      {
        prompt: "ok now what about the database connection — anything to know?",
        session_id: "S-loop",
      },
    );
    const sys = envelope(out).systemMessage ?? "";
    expect(sys).toMatch(/▣ TB LOOP\s+straight × 3 \(Read\)/);
  });

  it("flags ping-pong with `▣ TB LOOP  ping-pong (Tool)`", async () => {
    const cfg = initConfig(projectDir);
    const db = new Database(cfg.storagePath);
    const store = new BlockStore(db);
    store.recordToolObservations([
      { sessionId: "S-pp", batchOrder: 0, toolName: "Read", argSummary: "x", argKey: "kA" },
      { sessionId: "S-pp", batchOrder: 1, toolName: "Edit", argSummary: "y", argKey: "kB" },
      { sessionId: "S-pp", batchOrder: 2, toolName: "Read", argSummary: "x", argKey: "kA" },
      { sessionId: "S-pp", batchOrder: 3, toolName: "Edit", argSummary: "y", argKey: "kB" },
    ]);
    store.close();

    const out = await runInjectContext(
      { path: projectDir },
      {
        prompt: "ok next let me ask about the migration runner instead",
        session_id: "S-pp",
      },
    );
    const sys = envelope(out).systemMessage ?? "";
    expect(sys).toMatch(/▣ TB LOOP\s+ping-pong/);
  });

  it("flags weak duplicates with the softer `▣ TB TOOL  repeated`", async () => {
    const cfg = initConfig(projectDir);
    const db = new Database(cfg.storagePath);
    const store = new BlockStore(db);
    store.recordToolObservations([
      { sessionId: "S-dup", batchOrder: 0, toolName: "Grep", argSummary: 'Grep("x")', argKey: "kA" },
      { sessionId: "S-dup", batchOrder: 1, toolName: "Read", argSummary: "Read(b)", argKey: "kB" },
      { sessionId: "S-dup", batchOrder: 2, toolName: "Read", argSummary: "Read(c)", argKey: "kC" },
      { sessionId: "S-dup", batchOrder: 3, toolName: "Grep", argSummary: 'Grep("x")', argKey: "kA" },
    ]);
    store.close();

    const out = await runInjectContext(
      { path: projectDir },
      {
        prompt: "ok so what's the plan for fixing the failing migration script?",
        session_id: "S-dup",
      },
    );
    const sys = envelope(out).systemMessage ?? "";
    expect(sys).toMatch(/▣ TB TOOL\s+repeated 2× \(Grep\)/);
  });

  it("emits the TB LOOP fragment even on a no-match prompt", async () => {
    const cfg = initConfig(projectDir);
    const db = new Database(cfg.storagePath);
    const store = new BlockStore(db);
    store.recordToolObservations([
      { sessionId: "S-nm", batchOrder: 0, toolName: "Read", argSummary: "x", argKey: "kA" },
      { sessionId: "S-nm", batchOrder: 1, toolName: "Read", argSummary: "x", argKey: "kA" },
      { sessionId: "S-nm", batchOrder: 2, toolName: "Read", argSummary: "x", argKey: "kA" },
    ]);
    store.close();
    // No blocks / facts — recall returns no-match, but the TB LOOP
    // fragment still composes because detection is independent.
    const out = await runInjectContext(
      { path: projectDir },
      {
        prompt: "completely unrelated topic that wont match any pattern in the empty store",
        session_id: "S-nm",
      },
    );
    const sys = envelope(out).systemMessage ?? "";
    expect(sys).toMatch(/▣ TB TRACE\s+checked · no match/);
    expect(sys).toMatch(/▣ TB LOOP\s+straight × 3/);
  });

  it("silent mode hard-suppresses the TB LOOP fragment", async () => {
    const cfg = initConfig(projectDir);
    const db = new Database(cfg.storagePath);
    const store = new BlockStore(db);
    store.recordToolObservations([
      { sessionId: "S-silent", batchOrder: 0, toolName: "Read", argSummary: "x", argKey: "kA" },
      { sessionId: "S-silent", batchOrder: 1, toolName: "Read", argSummary: "x", argKey: "kA" },
      { sessionId: "S-silent", batchOrder: 2, toolName: "Read", argSummary: "x", argKey: "kA" },
    ]);
    store.close();
    const out = await runInjectContext(
      { path: projectDir, status: "silent" },
      {
        prompt: "again unrelated long enough prompt to pass the gate but silent mode",
        session_id: "S-silent",
      },
    );
    expect(envelope(out).systemMessage).toBeUndefined();
  });
});

describe("runInjectContext — TRACEBASE_DISABLED kill switch", () => {
  // Used by the demo harness (off variant) and as a one-off
  // global suppression. Must short-circuit to the trivial-shape
  // empty envelope without touching the store or running recall.
  it("returns an empty envelope when TRACEBASE_DISABLED=1, even with a matching pattern", async () => {
    const config = initConfig(projectDir);
    const db = new Database(config.storagePath);
    const store = new BlockStore(db);
    storeActive(store, PY_BLOCK);
    store.close();

    // Sanity: without the switch, a matching pattern is injected.
    const before = await runInjectContext(
      { path: projectDir },
      { prompt: "pytest is collecting the wrong package — sys.path looks suspicious" },
    );
    expect(before.injected).toBe(true);
    expect(envelope(before).hookSpecificOutput.additionalContext).toContain("<tracebase queryId=");

    const prev = process.env.TRACEBASE_DISABLED;
    process.env.TRACEBASE_DISABLED = "1";
    try {
      const out = await runInjectContext(
        { path: projectDir },
        { prompt: "pytest is collecting the wrong package — sys.path looks suspicious" },
      );
      expect(out.injected).toBe(false);
      const parsed = envelope(out);
      // Same well-formed shape — host doesn't see a crash.
      expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
      // No <tracebase> block — store wasn't touched.
      expect(parsed.hookSpecificOutput.additionalContext).not.toContain("<tracebase queryId=");
    } finally {
      if (prev === undefined) delete process.env.TRACEBASE_DISABLED;
      else process.env.TRACEBASE_DISABLED = prev;
    }
  });

  it("ignores any value other than the literal string '1' (avoid accidental disables)", async () => {
    const config = initConfig(projectDir);
    const db = new Database(config.storagePath);
    const store = new BlockStore(db);
    storeActive(store, PY_BLOCK);
    store.close();

    const prev = process.env.TRACEBASE_DISABLED;
    process.env.TRACEBASE_DISABLED = "true"; // common trap
    try {
      const out = await runInjectContext(
        { path: projectDir },
        { prompt: "pytest is collecting the wrong package — sys.path looks suspicious" },
      );
      // 'true' must not disable — only the literal '1' does. This
      // keeps the surface unambiguous and catches typos at review.
      expect(out.injected).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.TRACEBASE_DISABLED;
      else process.env.TRACEBASE_DISABLED = prev;
    }
  });
});
