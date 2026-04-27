/**
 * `tracebase capture-pre-tool-use` (PLAN-0.7 §rc.4) — full coverage.
 *
 * Coverage axes:
 *   rc.4a — parser locked against committed golden fixtures; dump-
 *           only writes raw stdin without touching state
 *   rc.4b — warm cache (RecentToolCache) is the only state read on
 *           the hot path; SQLite never opened on a cache miss
 *   rc.4c — warn mode (default) emits systemMessage on duplicate;
 *           warn-once-per-arg-per-session
 *   rc.4d — strict mode (config OR env) emits decision:'block' for
 *           safe-read tools; never blocks Bash/Edit/Write
 *
 * Privacy invariants verified end-to-end:
 *   - parsed stdin never appears in any persisted analytics row
 *   - argSummary stays local; only argKey + toolName + mode reach
 *     the analytics_events row
 *   - the dump-only path writes RAW stdin to .tracebase/dumps/
 *     pre-tool-use/<ts>.json (the format the golden fixtures came
 *     from)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { initConfig, loadConfig, getOrMintWorkspaceSalt } from "../../src/core/config.js";
import { BlockStore } from "../../src/core/block-store.js";
import { observeToolBatch } from "../../src/runtime/observe-tools.js";
import {
  RecentToolCache,
  cacheFilePath,
} from "../../src/runtime/recent-tool-cache.js";
import {
  parsePreToolUseStdin,
  runCapturePreToolUse,
} from "../../src/cli/commands/capture-pre-tool-use.js";

const FIXTURE_DIR = join(__dirname, "..", "fixtures", "pre-tool-use");

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "tb-prehook-"));
  initConfig(workDir);
  // Reset env so prior cases don't leak strict mode.
  delete process.env.TRACEBASE_TOOL_STRICT;
  delete process.env.TRACEBASE_CAPTURE_PRE_TOOL;
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  delete process.env.TRACEBASE_TOOL_STRICT;
  delete process.env.TRACEBASE_CAPTURE_PRE_TOOL;
});

function loadFixture(name: string): Buffer {
  return readFileSync(join(FIXTURE_DIR, name));
}

function readEvents(eventType: string): Array<{ event: string } & Record<string, unknown>> {
  const cfg = loadConfig(workDir);
  const db = new Database(cfg.storagePath);
  try {
    const store = new BlockStore(db);
    try {
      return store.readEvents({
        eventType: eventType as "tool_supervision.warned" | "tool_supervision.suppressed",
      }) as unknown as Array<{ event: string } & Record<string, unknown>>;
    } finally {
      store.close();
    }
  } catch {
    db.close();
    return [];
  }
}

function seedCache(records: Array<{ argKey: string; toolName: string; sessionId: string }>): void {
  const cache = new RecentToolCache();
  for (const r of records) {
    cache.append({ ...r, ts: Date.now() });
  }
  cache.flush(workDir);
}

// ---------------------------------------------------------------------------
// rc.4a — parser locked against committed golden fixtures
// ---------------------------------------------------------------------------

describe("capture-pre-tool-use — rc.4a parser locked against golden fixtures", () => {
  it.each([
    "read.json",
    "grep.json",
    "glob.json",
    "bash.json",
    "edit.json",
    "write.json",
    "multi-edit.json",
    "webfetch.json",
  ])("parses %s with the documented top-level fields", (filename) => {
    const raw = loadFixture(filename);
    const parsed = parsePreToolUseStdin(raw);
    expect(parsed.hook_event_name).toBe("PreToolUse");
    expect(typeof parsed.session_id).toBe("string");
    expect(typeof parsed.cwd).toBe("string");
    expect(typeof parsed.tool_name).toBe("string");
    expect(parsed.tool_input).toBeDefined();
  });

  it("unknown future shape parses without throwing — extra fields preserved", () => {
    const raw = loadFixture("unknown-future.json");
    const parsed = parsePreToolUseStdin(raw);
    expect(parsed.tool_name).toBe("FuturisticMystery");
    // Extra top-level + extra tool_input fields don't crash; the
    // parser is tolerant by design.
    expect((parsed as Record<string, unknown>).future_hook_field).toBe(
      "added in some 2027 Claude Code release",
    );
  });

  it("malformed JSON returns {} (fail-open at the parser boundary)", () => {
    expect(parsePreToolUseStdin(Buffer.from("not json at all"))).toEqual({});
    expect(parsePreToolUseStdin(Buffer.from("[1,2,3]"))).toEqual({});
    expect(parsePreToolUseStdin(Buffer.from("42"))).toEqual({});
  });

  it("oversized stdin returns {}", () => {
    const big = Buffer.alloc(300 * 1024, "a".charCodeAt(0));
    expect(parsePreToolUseStdin(big)).toEqual({});
  });

  it("empty buffer returns {}", () => {
    expect(parsePreToolUseStdin(Buffer.alloc(0))).toEqual({});
  });

  it("unknown envelope shape: hook exits 0 with empty envelope (fail-open)", () => {
    const planted = Buffer.from(JSON.stringify({ unknown_shape: true }));
    const out = runCapturePreToolUse({ path: workDir }, planted);
    expect(out.envelope).toBe("{}");
    expect(out.warned).toBe(false);
    expect(out.blocked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// rc.4a — --dump-only writes raw stdin without touching state
// ---------------------------------------------------------------------------

describe("capture-pre-tool-use — --dump-only", () => {
  it("writes raw stdin to .tracebase/dumps/pre-tool-use/", () => {
    const raw = loadFixture("read.json");
    const out = runCapturePreToolUse({ path: workDir, dumpOnly: true }, raw);
    expect(out.dumped).toBe(true);
    expect(out.dumpPath).not.toBeNull();
    expect(existsSync(out.dumpPath!)).toBe(true);
    // Round-trip — the dumped bytes equal the input bytes.
    const dumped = readFileSync(out.dumpPath!);
    expect(dumped.equals(raw)).toBe(true);
  });

  it("dump-only produces NO analytics events and NO cache writes", () => {
    const raw = loadFixture("read.json");
    runCapturePreToolUse({ path: workDir, dumpOnly: true }, raw);
    expect(readEvents("tool_supervision.warned").length).toBe(0);
    // No cache file was written — dump-only doesn't touch state.
    expect(existsSync(cacheFilePath(workDir))).toBe(false);
  });

  it("works without TraceBase being initialized (no `init` ran first)", () => {
    const fresh = mkdtempSync(join(tmpdir(), "tb-prehook-uninit-"));
    try {
      const raw = loadFixture("read.json");
      const out = runCapturePreToolUse({ path: fresh, dumpOnly: true }, raw);
      expect(out.dumped).toBe(true);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// rc.4b — warm cache only; SQLite never opened on cache miss
// ---------------------------------------------------------------------------

describe("capture-pre-tool-use — rc.4b warm cache", () => {
  it("cache miss → fail-open (empty envelope, no analytics row)", () => {
    const raw = loadFixture("read.json");
    const out = runCapturePreToolUse({ path: workDir }, raw);
    expect(out.envelope).toBe("{}");
    expect(out.warned).toBe(false);
    expect(out.signalKind).toBe("none");
    expect(readEvents("tool_supervision.warned").length).toBe(0);
  });

  it("synthetic observation does NOT persist to the cache file", () => {
    const raw = loadFixture("read.json");
    runCapturePreToolUse({ path: workDir }, raw);
    // Cache file may not exist (no warm load was needed) OR was
    // hydrated read-only. Either way the synthetic call's argKey
    // must NOT appear in it.
    if (existsSync(cacheFilePath(workDir))) {
      const raw2 = readFileSync(cacheFilePath(workDir), "utf-8");
      expect(raw2.length).toBe(0);
    }
  });

  // 0.7.0-rc.4 hardening — P1 regression. The PostToolBatch path
  // MUST warm RecentToolCache. Pre-hardening, observeToolBatch
  // recorded to SQLite but never wrote .tracebase/cache/rtools.bin,
  // which left PreToolUse permanently cache-missing on real
  // Claude Code sessions.
  it("PostToolBatch (capture-tool-use) warms the cache; subsequent PreToolUse sees the duplicate", async () => {
    // Drive 3 PostToolBatch invocations on the same Read shape via
    // the canonical CLI hook surface. After this, the warm cache
    // file must exist and contain the seeded argKey.
    const { runCaptureToolUse } = await import(
      "../../src/cli/commands/capture-tool-use.js"
    );

    const ptbStdin = Buffer.from(
      JSON.stringify({
        hook_event_name: "PostToolBatch",
        session_id: "session-deadbeef-0001",
        cwd: "/work/repo",
        tool_calls: [
          {
            tool_name: "Read",
            tool_input: { file_path: "/work/repo/src/auth.ts" },
            tool_use_id: "tu-1",
          },
        ],
      }),
    );

    // Three runs to push the duplicate detector past the
    // STRAIGHT threshold (3 consecutive same-argKey calls).
    runCaptureToolUse({ path: workDir }, ptbStdin);
    runCaptureToolUse({ path: workDir }, ptbStdin);
    runCaptureToolUse({ path: workDir }, ptbStdin);

    // The cache file should now exist with the rc.4 short-key
    // format. Verify by hydrating a fresh cache and querying.
    expect(existsSync(cacheFilePath(workDir))).toBe(true);
    const cache = new RecentToolCache();
    cache.hydrate(workDir);
    const window = cache.recent("session-deadbeef-0001", 6);
    expect(window.length).toBeGreaterThanOrEqual(3);
    expect(window.every((w) => w.toolName === "Read")).toBe(true);
    // All three records share the same argKey (same path, same
    // session, same workspace salt).
    const argKeys = new Set(window.map((w) => w.argKey));
    expect(argKeys.size).toBe(1);

    // Now run PreToolUse on the same Read fixture — the warm
    // cache should drive a duplicate signal.
    const out = runCapturePreToolUse({ path: workDir }, loadFixture("read.json"));
    expect(out.warned).toBe(true);
    expect(out.signalKind === "duplicate" || out.signalKind === "straight").toBe(true);
    const env = JSON.parse(out.envelope) as { systemMessage?: string };
    // 0.7.1 — copy switched from "duplicate" to "reused" for safe-read
    // tools so the badge reads as actionable, not advisory.
    expect(env.systemMessage).toMatch(/▣ TB TOOL\s+reused: Read/);

    const events = readEvents("tool_supervision.warned");
    expect(events.length).toBe(1);
    expect(events[0]!.toolName).toBe("Read");
  });
});

// ---------------------------------------------------------------------------
// rc.4c — warn mode default
// ---------------------------------------------------------------------------

describe("capture-pre-tool-use — rc.4c warn mode (default)", () => {
  function readArgKey(): string {
    // Pre-warm by running PostToolBatch on the same shape so we
    // get the canonical argKey for `Read("/work/repo/src/auth.ts")`.
    // Then we plant 3 of those in the cache to drive a duplicate.
    const cfg = loadConfig(workDir);
    const db = new Database(cfg.storagePath);
    const store = new BlockStore(db);
    try {
      const result = observeToolBatch(store, {
        sessionId: "session-deadbeef-0001",
        cwd: "/work/repo",
        workspaceSalt: getOrMintWorkspaceSalt(workDir)!,
        toolCalls: [
          { toolName: "Read", toolInput: { file_path: "/work/repo/src/auth.ts" } },
        ],
      });
      const id = result.ids[0]!;
      const row = store.rawDb
        .prepare("SELECT arg_key FROM tool_observations WHERE id = ?")
        .get(id) as { arg_key: string };
      return row.arg_key;
    } finally {
      store.close();
    }
  }

  it("duplicate Read in cache + same Read in stdin → warn badge", () => {
    // The fixture's session_id is `session-deadbeef-0001` and the
    // tool_input is `{ file_path: "/work/repo/src/auth.ts" }`.
    // We need the matching argKey — workspace salt is per-init,
    // so we ask the store what it computed.
    const argKey = readArgKey();
    seedCache([
      { argKey, toolName: "Read", sessionId: "session-deadbeef-0001" },
      { argKey, toolName: "Read", sessionId: "session-deadbeef-0001" },
      { argKey, toolName: "Read", sessionId: "session-deadbeef-0001" },
    ]);

    const out = runCapturePreToolUse({ path: workDir }, loadFixture("read.json"));
    // 3 prior + 1 synthetic → 4 of the same argKey → duplicate.
    expect(out.warned).toBe(true);
    expect(out.signalKind === "duplicate" || out.signalKind === "straight").toBe(true);

    const env = JSON.parse(out.envelope) as { systemMessage?: string; decision?: string };
    // 0.7.1 — first hit on a safe-read in default mode emits the
    // "reused" hint (actionable) but does NOT block — gives the
    // agent a chance to read its own prior output.
    expect(env.systemMessage).toMatch(/▣ TB TOOL\s+reused: Read/);
    expect(env.decision).toBeUndefined();

    const events = readEvents("tool_supervision.warned");
    expect(events.length).toBe(1);
    expect(events[0]!.argKey).toBe(argKey);
    expect(events[0]!.toolName).toBe("Read");
    expect(events[0]!.mode).toBe("warn");
  });

  it("warn-once: second duplicate on same arg_key in same session → suppressed (0.7.1: now blocks too)", () => {
    const argKey = readArgKey();
    seedCache([
      { argKey, toolName: "Read", sessionId: "session-deadbeef-0001" },
      { argKey, toolName: "Read", sessionId: "session-deadbeef-0001" },
      { argKey, toolName: "Read", sessionId: "session-deadbeef-0001" },
    ]);
    const first = runCapturePreToolUse({ path: workDir }, loadFixture("read.json"));
    // First hit: reused hint, no block.
    expect(first.warned).toBe(true);
    expect(first.blocked).toBe(false);
    expect(JSON.parse(first.envelope).decision).toBeUndefined();

    const second = runCapturePreToolUse({ path: workDir }, loadFixture("read.json"));
    // 0.7.1 — second hit on a safe-read in default mode now ESCALATES
    // to block. The agent ignored the first reuse hint; we change
    // trajectory ourselves.
    expect(second.warned).toBe(false); // dedupe silences the warned bit
    expect(second.blocked).toBe(true);
    const secondEnv = JSON.parse(second.envelope) as { decision?: string; reason?: string };
    expect(secondEnv.decision).toBe("block");
    expect(secondEnv.reason).toMatch(/blocked duplicate Read/);

    expect(readEvents("tool_supervision.warned").length).toBe(1);
    const suppressed = readEvents("tool_supervision.suppressed");
    expect(suppressed.length).toBe(1);
    // 0.7.1 — escalation block records `blocked: true` so mechanism
    // savings can credit the avoided read.
    expect(suppressed[0]!.blocked).toBe(true);
  });

  // 0.7.1 — search family (Grep) gets the same escalation as read
  // family because both produce "context the agent already has".
  // Fixture: tests/fixtures/pre-tool-use/grep.json carries
  // { session_id: "session-deadbeef-0002", tool_input:
  //   { pattern: "TODO", glob: "**/*.ts", path: "src" } }.
  it("0.7.1 — duplicate Grep escalates: first hit reused, second hit blocked", () => {
    const cfg = loadConfig(workDir);
    const db = new Database(cfg.storagePath);
    const store = new BlockStore(db);
    let argKey: string;
    try {
      const res = observeToolBatch(store, {
        sessionId: "session-deadbeef-0002",
        cwd: "/work/repo",
        workspaceSalt: getOrMintWorkspaceSalt(workDir)!,
        toolCalls: [
          {
            toolName: "Grep",
            toolInput: { pattern: "TODO", glob: "**/*.ts", path: "src" },
          },
        ],
      });
      argKey = (
        store.rawDb
          .prepare("SELECT arg_key FROM tool_observations WHERE id = ?")
          .get(res.ids[0]!) as { arg_key: string }
      ).arg_key;
    } finally {
      store.close();
    }
    seedCache([
      { argKey, toolName: "Grep", sessionId: "session-deadbeef-0002" },
      { argKey, toolName: "Grep", sessionId: "session-deadbeef-0002" },
      { argKey, toolName: "Grep", sessionId: "session-deadbeef-0002" },
    ]);
    const first = runCapturePreToolUse({ path: workDir }, loadFixture("grep.json"));
    expect(first.blocked).toBe(false);
    expect(JSON.parse(first.envelope).systemMessage).toMatch(/reused: Grep/);
    const second = runCapturePreToolUse({ path: workDir }, loadFixture("grep.json"));
    expect(second.blocked).toBe(true);
    expect(JSON.parse(second.envelope).decision).toBe("block");
  });

  // 0.7.1 — Bash / Edit / Write must NEVER block by default,
  // regardless of repeat count. The "you already have this in
  // context" framing only applies to safe-read families.
  // Fixture: tests/fixtures/pre-tool-use/bash.json carries
  // { session_id: "session-deadbeef-0004", tool_input:
  //   { command: "npm run build && cat dist/index.js | head -50",
  //     description: "Build and inspect output" } }.
  it("0.7.1 — duplicate Bash NEVER blocks by default, even on repeat hits", () => {
    const cfg = loadConfig(workDir);
    const db = new Database(cfg.storagePath);
    const store = new BlockStore(db);
    let argKey: string;
    try {
      const res = observeToolBatch(store, {
        sessionId: "session-deadbeef-0004",
        cwd: "/work/repo",
        workspaceSalt: getOrMintWorkspaceSalt(workDir)!,
        toolCalls: [
          {
            toolName: "Bash",
            toolInput: {
              command: "npm run build && cat dist/index.js | head -50",
              description: "Build and inspect output",
            },
          },
        ],
      });
      argKey = (
        store.rawDb
          .prepare("SELECT arg_key FROM tool_observations WHERE id = ?")
          .get(res.ids[0]!) as { arg_key: string }
      ).arg_key;
    } finally {
      store.close();
    }
    seedCache([
      { argKey, toolName: "Bash", sessionId: "session-deadbeef-0004" },
      { argKey, toolName: "Bash", sessionId: "session-deadbeef-0004" },
      { argKey, toolName: "Bash", sessionId: "session-deadbeef-0004" },
    ]);
    const first = runCapturePreToolUse({ path: workDir }, loadFixture("bash.json"));
    expect(first.blocked).toBe(false);
    expect(JSON.parse(first.envelope).systemMessage).toMatch(/repeated Bash/);
    const second = runCapturePreToolUse({ path: workDir }, loadFixture("bash.json"));
    // Even on the second hit Bash must NOT escalate.
    expect(second.blocked).toBe(false);
    expect(JSON.parse(second.envelope).decision).toBeUndefined();
    // No mechanism-savings credit either way.
    const suppressed = readEvents("tool_supervision.suppressed");
    expect(suppressed.every((e) => e.blocked === false)).toBe(true);
  });

  it("first call (cache empty for this arg_key) does NOT warn", () => {
    const out = runCapturePreToolUse({ path: workDir }, loadFixture("read.json"));
    expect(out.warned).toBe(false);
    expect(out.signalKind).toBe("none");
    expect(readEvents("tool_supervision.warned").length).toBe(0);
  });

  it("--capture off → pure no-op (no parse, no cache, no events)", () => {
    const out = runCapturePreToolUse(
      { path: workDir, capture: "off" },
      loadFixture("read.json"),
    );
    expect(out.envelope).toBe("{}");
    expect(readEvents("tool_supervision.warned").length).toBe(0);
  });

  it("env TRACEBASE_CAPTURE_PRE_TOOL=off wins over flag", () => {
    process.env.TRACEBASE_CAPTURE_PRE_TOOL = "off";
    const out = runCapturePreToolUse(
      { path: workDir, capture: "warn" },
      loadFixture("read.json"),
    );
    expect(out.envelope).toBe("{}");
  });
});

// ---------------------------------------------------------------------------
// rc.4d — strict mode (config-only, off by default)
// ---------------------------------------------------------------------------

describe("capture-pre-tool-use — rc.4d strict mode", () => {
  function readArgKeyFor(toolName: string, toolInput: Record<string, unknown>): string {
    const cfg = loadConfig(workDir);
    const db = new Database(cfg.storagePath);
    const store = new BlockStore(db);
    try {
      const result = observeToolBatch(store, {
        sessionId: "session-deadbeef-0001",
        cwd: "/work/repo",
        workspaceSalt: getOrMintWorkspaceSalt(workDir)!,
        toolCalls: [{ toolName, toolInput }],
      });
      const row = store.rawDb
        .prepare("SELECT arg_key FROM tool_observations WHERE id = ?")
        .get(result.ids[0]!) as { arg_key: string };
      return row.arg_key;
    } finally {
      store.close();
    }
  }

  function enableStrictViaConfig(): void {
    const path = join(workDir, ".tracebase", "config.json");
    const cfg = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    cfg.toolSupervision = { strict: true };
    writeFileSync(path, JSON.stringify(cfg, null, 2));
  }

  it("strict mode + duplicate Read → emits decision:'block'", () => {
    enableStrictViaConfig();
    const argKey = readArgKeyFor("Read", { file_path: "/work/repo/src/auth.ts" });
    seedCache([
      { argKey, toolName: "Read", sessionId: "session-deadbeef-0001" },
      { argKey, toolName: "Read", sessionId: "session-deadbeef-0001" },
      { argKey, toolName: "Read", sessionId: "session-deadbeef-0001" },
    ]);
    const out = runCapturePreToolUse({ path: workDir }, loadFixture("read.json"));
    expect(out.blocked).toBe(true);
    const env = JSON.parse(out.envelope) as { decision?: string; reason?: string };
    expect(env.decision).toBe("block");
    // 0.7.1 — block reason copy is "blocked duplicate <Tool>" now.
    expect(env.reason).toMatch(/blocked duplicate Read/);

    const events = readEvents("tool_supervision.warned");
    expect(events[0]!.mode).toBe("block");
  });

  it("strict mode + duplicate Bash → does NOT block (Bash is not a safe-read tool)", () => {
    enableStrictViaConfig();
    const argKey = readArgKeyFor("Bash", { command: "npm run build && cat dist/index.js | head -50" });
    seedCache([
      { argKey, toolName: "Bash", sessionId: "session-deadbeef-0004" },
      { argKey, toolName: "Bash", sessionId: "session-deadbeef-0004" },
      { argKey, toolName: "Bash", sessionId: "session-deadbeef-0004" },
    ]);
    const out = runCapturePreToolUse({ path: workDir }, loadFixture("bash.json"));
    expect(out.blocked).toBe(false);
    expect(out.warned).toBe(true);
    const env = JSON.parse(out.envelope) as { decision?: string; systemMessage?: string };
    expect(env.decision).toBeUndefined();
    // 0.7.1 — non-safe-read families use the "repeated" verb, not
    // "duplicate" — same advisory weight as before but the copy
    // matches the post-0.7.1 vocabulary.
    expect(env.systemMessage).toMatch(/▣ TB TOOL\s+repeated Bash/);
  });

  it("strict mode + duplicate Edit → does NOT block", () => {
    enableStrictViaConfig();
    const argKey = readArgKeyFor("Edit", {
      file_path: "/work/repo/src/auth.ts",
      old_string: "export function authenticate()",
      new_string: "export async function authenticate()",
    });
    seedCache([
      { argKey, toolName: "Edit", sessionId: "session-deadbeef-0005" },
      { argKey, toolName: "Edit", sessionId: "session-deadbeef-0005" },
      { argKey, toolName: "Edit", sessionId: "session-deadbeef-0005" },
    ]);
    const out = runCapturePreToolUse({ path: workDir }, loadFixture("edit.json"));
    expect(out.blocked).toBe(false);
  });

  it("strict mode opts in via env (TRACEBASE_TOOL_STRICT=on) without config edit", () => {
    process.env.TRACEBASE_TOOL_STRICT = "on";
    const argKey = readArgKeyFor("Read", { file_path: "/work/repo/src/auth.ts" });
    seedCache([
      { argKey, toolName: "Read", sessionId: "session-deadbeef-0001" },
      { argKey, toolName: "Read", sessionId: "session-deadbeef-0001" },
      { argKey, toolName: "Read", sessionId: "session-deadbeef-0001" },
    ]);
    const out = runCapturePreToolUse({ path: workDir }, loadFixture("read.json"));
    expect(out.blocked).toBe(true);
  });

  it("default mode (no config, no env) does NOT block — warn-only", () => {
    const argKey = readArgKeyFor("Read", { file_path: "/work/repo/src/auth.ts" });
    seedCache([
      { argKey, toolName: "Read", sessionId: "session-deadbeef-0001" },
      { argKey, toolName: "Read", sessionId: "session-deadbeef-0001" },
      { argKey, toolName: "Read", sessionId: "session-deadbeef-0001" },
    ]);
    const out = runCapturePreToolUse({ path: workDir }, loadFixture("read.json"));
    expect(out.blocked).toBe(false);
    expect(out.warned).toBe(true);
  });

  // 0.7.0-rc.4 hardening — P1 regression. Strict mode MUST block
  // every duplicate read attempt, not just the first one. The
  // warn-once-per-arg-per-session dedupe controls only analytics
  // + visible badge text — the security decision (decision:"block")
  // is independent of dedupe.
  it("strict mode blocks every duplicate Read — dedupe does NOT silence the block decision", () => {
    enableStrictViaConfig();
    const argKey = readArgKeyFor("Read", { file_path: "/work/repo/src/auth.ts" });
    seedCache([
      { argKey, toolName: "Read", sessionId: "session-deadbeef-0001" },
      { argKey, toolName: "Read", sessionId: "session-deadbeef-0001" },
      { argKey, toolName: "Read", sessionId: "session-deadbeef-0001" },
    ]);

    // First duplicate Read — block fires + warned event emits.
    const first = runCapturePreToolUse({ path: workDir }, loadFixture("read.json"));
    expect(first.blocked).toBe(true);
    expect(JSON.parse(first.envelope).decision).toBe("block");
    expect(first.warned).toBe(true);

    // Second duplicate Read on the same argKey — dedupe says
    // "we already warned about this", so the analytics event is
    // SUPPRESSED, but the security decision MUST stay block.
    const second = runCapturePreToolUse({ path: workDir }, loadFixture("read.json"));
    expect(second.blocked, "second duplicate Read must still block in strict mode").toBe(true);
    expect(JSON.parse(second.envelope).decision).toBe("block");
    expect(second.warned).toBe(false); // dedupe silences the warned bit

    // Third duplicate Read — same: still blocked.
    const third = runCapturePreToolUse({ path: workDir }, loadFixture("read.json"));
    expect(third.blocked).toBe(true);
    expect(JSON.parse(third.envelope).decision).toBe("block");

    // Analytics: ONE warned event, ONE suppressed event minimum
    // (actual count of suppressed = total duplicate calls past
    // the first). Importantly the dedupe never converts a block
    // into a no-op envelope.
    const warnedEvents = readEvents("tool_supervision.warned");
    const suppressedEvents = readEvents("tool_supervision.suppressed");
    expect(warnedEvents.length).toBe(1);
    expect(suppressedEvents.length).toBeGreaterThanOrEqual(2);
    expect(warnedEvents[0]!.mode).toBe("block");
  });

  it("default mode badge gates: first hit shows reuse hint, second hit suppresses badge but escalates to block", () => {
    // 0.7.1 — the badge dedupe still gates the visible
    // systemMessage so the operator's view doesn't get spammed.
    // What CHANGED is the second hit's decision — pre-0.7.1 it
    // was a no-op envelope; post-0.7.1 it carries
    // decision:"block" because the agent ignored the hint.
    const argKey = readArgKeyFor("Read", { file_path: "/work/repo/src/auth.ts" });
    seedCache([
      { argKey, toolName: "Read", sessionId: "session-deadbeef-0001" },
      { argKey, toolName: "Read", sessionId: "session-deadbeef-0001" },
      { argKey, toolName: "Read", sessionId: "session-deadbeef-0001" },
    ]);

    const first = runCapturePreToolUse({ path: workDir }, loadFixture("read.json"));
    expect(JSON.parse(first.envelope).systemMessage).toMatch(/reused: Read/);
    expect(first.blocked).toBe(false);

    const second = runCapturePreToolUse({ path: workDir }, loadFixture("read.json"));
    // Badge silenced (dedupe).
    expect(JSON.parse(second.envelope).systemMessage).toBeUndefined();
    // 0.7.1 — block decision now fires on the escalation path.
    expect(second.blocked).toBe(true);
    expect(JSON.parse(second.envelope).decision).toBe("block");
  });
});

// ---------------------------------------------------------------------------
// Privacy regression — argSummary / tool_input never leak through events
// ---------------------------------------------------------------------------

describe("capture-pre-tool-use — privacy invariants", () => {
  it("planted secret_arg in tool_input never appears in any persisted event", () => {
    // Pre-warm the schema by running an observation through the
    // canonical PostToolBatch path. This way analytics_events
    // exists before we walk it.
    const cfgPre = loadConfig(workDir);
    {
      const db = new Database(cfgPre.storagePath);
      const store = new BlockStore(db);
      try {
        observeToolBatch(store, {
          sessionId: "warmup",
          cwd: workDir,
          workspaceSalt: getOrMintWorkspaceSalt(workDir)!,
          toolCalls: [{ toolName: "Read", toolInput: { file_path: "src/x.ts" } }],
        });
      } finally {
        store.close();
      }
    }

    // Inject a planted secret into a Read fixture.
    const planted = JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: "session-deadbeef-secret",
      cwd: "/work/repo",
      tool_name: "Read",
      tool_input: {
        file_path: "/work/repo/src/auth.ts",
        secret_arg: "sk-ant-DO-NOT-LEAK-1234567890ab",
      },
    });
    runCapturePreToolUse({ path: workDir }, Buffer.from(planted));

    // Walk every analytics row and assert the planted secret
    // never made it into any payload.
    const cfg = loadConfig(workDir);
    const db = new Database(cfg.storagePath);
    try {
      const rows = db
        .prepare("SELECT payload FROM analytics_events")
        .all() as Array<{ payload: string }>;
      for (const r of rows) {
        expect(r.payload).not.toContain("sk-ant-DO-NOT-LEAK");
      }
    } finally {
      db.close();
    }
  });

  it("tool_warn_dedupe table stores argKey HMAC only — never raw paths or summaries", () => {
    // Drive a warn so dedupe is populated.
    const cfg = loadConfig(workDir);
    const db1 = new Database(cfg.storagePath);
    const store = new BlockStore(db1);
    let argKey: string;
    try {
      const result = observeToolBatch(store, {
        sessionId: "session-deadbeef-0001",
        cwd: "/work/repo",
        workspaceSalt: getOrMintWorkspaceSalt(workDir)!,
        toolCalls: [
          { toolName: "Read", toolInput: { file_path: "/work/repo/src/auth.ts" } },
        ],
      });
      argKey = (
        store.rawDb
          .prepare("SELECT arg_key FROM tool_observations WHERE id = ?")
          .get(result.ids[0]!) as { arg_key: string }
      ).arg_key;
    } finally {
      store.close();
    }
    seedCache([
      { argKey, toolName: "Read", sessionId: "session-deadbeef-0001" },
      { argKey, toolName: "Read", sessionId: "session-deadbeef-0001" },
      { argKey, toolName: "Read", sessionId: "session-deadbeef-0001" },
    ]);
    runCapturePreToolUse({ path: workDir }, loadFixture("read.json"));

    const db = new Database(cfg.storagePath);
    try {
      const rows = db
        .prepare("SELECT * FROM tool_warn_dedupe")
        .all() as Array<Record<string, unknown>>;
      expect(rows.length).toBeGreaterThanOrEqual(1);
      const serialized = JSON.stringify(rows);
      expect(serialized).not.toContain("/work/repo/src/auth.ts");
      expect(serialized).not.toContain("file_path");
    } finally {
      db.close();
    }
  });
});
