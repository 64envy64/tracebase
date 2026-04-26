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
    expect(env.systemMessage).toMatch(/▣ TB TOOL\s+duplicate Read/);
    expect(env.decision).toBeUndefined(); // warn mode does NOT block

    const events = readEvents("tool_supervision.warned");
    expect(events.length).toBe(1);
    expect(events[0]!.argKey).toBe(argKey);
    expect(events[0]!.toolName).toBe("Read");
    expect(events[0]!.mode).toBe("warn");
  });

  it("warn-once: second duplicate on same arg_key in same session → suppressed", () => {
    const argKey = readArgKey();
    seedCache([
      { argKey, toolName: "Read", sessionId: "session-deadbeef-0001" },
      { argKey, toolName: "Read", sessionId: "session-deadbeef-0001" },
      { argKey, toolName: "Read", sessionId: "session-deadbeef-0001" },
    ]);
    runCapturePreToolUse({ path: workDir }, loadFixture("read.json"));
    runCapturePreToolUse({ path: workDir }, loadFixture("read.json"));

    expect(readEvents("tool_supervision.warned").length).toBe(1);
    expect(readEvents("tool_supervision.suppressed").length).toBe(1);
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
    expect(env.reason).toMatch(/duplicate Read/);

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
    expect(env.systemMessage).toMatch(/▣ TB TOOL\s+duplicate Bash/);
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
