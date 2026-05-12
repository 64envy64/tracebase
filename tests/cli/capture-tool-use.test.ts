/**
 * `tracebase capture-tool-use` — 0.5.3 dump-first scaffold.
 *
 * Covers what this release ships and nothing more:
 *
 *   1. `--dump-stdin` writes bounded raw bytes to a known path under
 *      the user's home and echoes the parsed shape to stderr. Path
 *      is `~/.tracebase/posttoolbatch-dumps/<iso-ts>-<session>.jsonl`
 *      to keep dumps from PostToolBatch (and PostToolUse fallback)
 *      separate from PreCompact dumps that already live under
 *      `~/.tracebase/precompact-dumps/`.
 *
 *   2. Default mode is an intentional no-op — emits a valid empty
 *      envelope, touches no disk, returns `dumped: false`. This
 *      stays true until the parser, `tool_observations` schema
 *      (V2_MIGRATIONS[8]), and the duplicate / loop detector land
 *      in a follow-up release.
 *
 *   3. `parseStdinPayload` collapses every malformed / primitive /
 *      array-at-root / oversized input to `{}` so the hook never
 *      throws. Unknown fields are preserved verbatim — that's the
 *      whole point of dump-first.
 *
 * The real detector and observation table land in a follow-up
 * release after a live PostToolBatch payload has been captured and
 * the shape locked against ground truth.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import Database from "better-sqlite3";
import {
  parseStdinPayload,
  runCaptureToolUse,
} from "../../src/cli/commands/capture-tool-use.js";
import { BlockStore } from "../../src/core/block-store.js";
import { initConfig } from "../../src/core/config.js";

let homeDir: string;
const origHome = process.env.HOME;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "tb-capture-tool-home-"));
  process.env.HOME = homeDir;
});

afterEach(() => {
  process.env.HOME = origHome;
  rmSync(homeDir, { recursive: true, force: true });
});

describe("runCaptureToolUse — default mode (no-op)", () => {
  it("emits an empty envelope, writes no dump, returns dumped=false", () => {
    const rawStdin = Buffer.from(
      JSON.stringify({
        hook_event_name: "PostToolBatch",
        session_id: "s-1",
        cwd: "/tmp/anywhere",
        tool_calls: [
          { tool_name: "Read", tool_input: { file_path: "/abs/should/be/ignored.ts" } },
        ],
      }),
    );
    const out = runCaptureToolUse({}, rawStdin);
    expect(JSON.parse(out.envelope)).toEqual({});
    expect(out.dumped).toBe(false);
    expect(out.dumpPath).toBeNull();
    // No dump dir created, so installing this command as a hook
    // today is genuinely inert.
    expect(existsSync(join(homeDir, ".tracebase", "posttoolbatch-dumps"))).toBe(false);
  });

  it("no-ops on empty stdin — hook-safe on misfires", () => {
    const out = runCaptureToolUse({}, Buffer.alloc(0));
    expect(JSON.parse(out.envelope)).toEqual({});
    expect(out.dumped).toBe(false);
  });

  it("no-ops on malformed stdin — never throws", () => {
    const out = runCaptureToolUse({}, Buffer.from("{not valid json"));
    expect(JSON.parse(out.envelope)).toEqual({});
    expect(out.dumped).toBe(false);
  });
});

describe("runCaptureToolUse — --dump-stdin dev mode", () => {
  it("writes raw bytes to ~/.tracebase/posttoolbatch-dumps/<iso-ts>-<session>.jsonl", () => {
    const raw = Buffer.from(
      JSON.stringify({
        hook_event_name: "PostToolBatch",
        session_id: "sess-abc-123",
        cwd: "/tmp/proj",
        transcript_path: "/tmp/transcript.jsonl",
        tool_calls: [
          { tool_use_id: "tu-1", tool_name: "Read", tool_input: { file_path: "src/a.ts" }, outcome: "ok" },
          { tool_use_id: "tu-2", tool_name: "Grep", tool_input: { pattern: "foo" }, outcome: "ok" },
        ],
      }),
    );
    const out = runCaptureToolUse({ dumpStdin: true }, raw);
    expect(out.dumped).toBe(true);
    expect(out.dumpPath).toBeTruthy();
    expect(out.dumpPath!.startsWith(join(homeDir, ".tracebase", "posttoolbatch-dumps"))).toBe(true);

    // Envelope still empty — PostToolBatch proceeds unaffected.
    expect(JSON.parse(out.envelope)).toEqual({});

    // File on disk round-trips raw bytes.
    const onDisk = readFileSync(out.dumpPath!);
    expect(onDisk.toString("utf-8")).toBe(raw.toString("utf-8"));

    // Filename encodes both timestamp and a sanitised session tag.
    const dir = join(homeDir, ".tracebase", "posttoolbatch-dumps");
    const entries = readdirSync(dir);
    expect(entries.length).toBe(1);
    expect(entries[0]).toMatch(/sess-abc-123/);
    expect(entries[0]).toMatch(/\.jsonl$/);
  });

  it("filesystem-sanitises session ids containing path separators", () => {
    const raw = Buffer.from(
      JSON.stringify({ session_id: "weird/session:value\\bad" }),
    );
    const out = runCaptureToolUse({ dumpStdin: true }, raw);
    expect(out.dumped).toBe(true);
    const base = basename(out.dumpPath!);
    expect(base).not.toContain("/");
    expect(base).not.toContain(":");
    expect(base).not.toContain("\\");
  });

  it("falls back to `unknown-session` when the payload has no session id", () => {
    const out = runCaptureToolUse({ dumpStdin: true }, Buffer.from("{}"));
    expect(out.dumped).toBe(true);
    expect(out.dumpPath!.split("/").pop()).toMatch(/unknown-session/);
  });

  it("dumps an empty payload as an empty file without throwing", () => {
    const out = runCaptureToolUse({ dumpStdin: true }, Buffer.alloc(0));
    expect(out.dumped).toBe(true);
    const onDisk = readFileSync(out.dumpPath!);
    expect(onDisk.length).toBe(0);
  });

  it("emits an empty envelope even when the dump write fails", () => {
    // Force HOME at a regular file so mkdir fails with ENOTDIR.
    const blocker = join(homeDir, "blocker");
    writeFileSync(blocker, "x");
    process.env.HOME = blocker;
    try {
      const out = runCaptureToolUse({ dumpStdin: true }, Buffer.from("{}"));
      expect(JSON.parse(out.envelope)).toEqual({});
      expect(out.dumped).toBe(false);
      expect(out.dumpPath).toBeNull();
    } finally {
      process.env.HOME = homeDir;
    }
  });

  it("dump dir is separate from PreCompact dumps (no cross-pollution)", () => {
    const raw = Buffer.from('{"session_id":"s"}');
    runCaptureToolUse({ dumpStdin: true }, raw);
    expect(existsSync(join(homeDir, ".tracebase", "posttoolbatch-dumps"))).toBe(true);
    // PreCompact dumps live under their own directory; this hook
    // never touches it.
    expect(existsSync(join(homeDir, ".tracebase", "precompact-dumps"))).toBe(false);
  });
});

describe("parseStdinPayload — tolerant to every failure mode", () => {
  it("returns {} for empty / malformed / primitive / array / over-size", () => {
    expect(parseStdinPayload("")).toEqual({});
    expect(parseStdinPayload(Buffer.alloc(0))).toEqual({});
    expect(parseStdinPayload("{not valid")).toEqual({});
    expect(parseStdinPayload("null")).toEqual({});
    expect(parseStdinPayload("42")).toEqual({});
    expect(parseStdinPayload('"a string"')).toEqual({});
    // Arrays at root are common-enough host bugs that we explicitly
    // refuse them rather than mis-typing as ToolBatchHookStdin.
    expect(parseStdinPayload("[1,2,3]")).toEqual({});
    const oversize = "{\"padding\":\"" + "x".repeat(300_000) + "\"}";
    expect(parseStdinPayload(oversize)).toEqual({});
  });

  it("parses a well-formed PostToolBatch-shaped payload", () => {
    const parsed = parseStdinPayload(
      JSON.stringify({
        hook_event_name: "PostToolBatch",
        session_id: "s-1",
        cwd: "/work",
        transcript_path: "/x/tx.jsonl",
        tool_calls: [
          { tool_use_id: "tu-1", tool_name: "Read", tool_input: {}, outcome: "ok" },
        ],
      }),
    );
    expect(parsed.hook_event_name).toBe("PostToolBatch");
    expect(parsed.session_id).toBe("s-1");
    expect(parsed.cwd).toBe("/work");
    expect(parsed.transcript_path).toBe("/x/tx.jsonl");
    expect(parsed.tool_calls).toHaveLength(1);
  });

  it("parses a PostToolUse-shaped fallback payload (single tool call at root)", () => {
    const parsed = parseStdinPayload(
      JSON.stringify({
        hook_event_name: "PostToolUse",
        session_id: "s-1",
        tool_use_id: "tu-1",
        tool_name: "Read",
        tool_input: { file_path: "src/a.ts" },
        outcome: "ok",
      }),
    );
    expect(parsed.hook_event_name).toBe("PostToolUse");
    expect(parsed.tool_use_id).toBe("tu-1");
    expect(parsed.tool_name).toBe("Read");
  });

  it("preserves unknown fields verbatim (dump mode inspects everything)", () => {
    const parsed = parseStdinPayload(
      JSON.stringify({
        session_id: "s-1",
        future_field: "should round-trip into the dump",
        nested: { anything: [1, 2, 3] },
      }),
    ) as Record<string, unknown>;
    expect(parsed.future_field).toBe("should round-trip into the dump");
    expect(parsed.nested).toEqual({ anything: [1, 2, 3] });
  });
});

// ---------------------------------------------------------------------------
// 0.5.3 real observation path — replaces the dump-only scaffold's no-op.
// Uses a properly-initialised project so isInitialized + workspaceSalt are
// both present; the DB path comes back through `loadConfig`.
// ---------------------------------------------------------------------------

describe("runCaptureToolUse — default mode writes tool_observations rows", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "tb-tool-obs-"));
    initConfig(projectDir);
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  function readObservations(sessionId: string) {
    const dbPath = join(projectDir, ".tracebase", "memory.db");
    // The off-mode / empty-batch paths short-circuit before any
    // SQLite write, so the DB file may not exist yet — that's
    // semantically equivalent to "no observations".
    if (!existsSync(dbPath)) return [];
    const db = new Database(dbPath, { readonly: true });
    const store = new BlockStore(db, { skipMigrate: true });
    try {
      return store.recentToolObservations(sessionId, 256);
    } finally {
      store.close();
    }
  }

  it("writes one row per tool_call with sanitised arg_summary + HMAC arg_key", () => {
    const stdin = Buffer.from(
      JSON.stringify({
        hook_event_name: "PostToolBatch",
        session_id: "sess-real",
        cwd: projectDir,
        permission_mode: "default",
        tool_calls: [
          {
            tool_name: "Read",
            tool_input: { file_path: join(projectDir, "src/foo.ts") },
            tool_use_id: "toolu_01",
            tool_response: "should never be read",
          },
          {
            tool_name: "Bash",
            tool_input: { command: "npm run build && cat /etc/passwd" },
            tool_use_id: "toolu_02",
            tool_response: "ignored",
          },
        ],
      }),
    );
    const out = runCaptureToolUse({}, stdin);
    expect(out.recorded).toBe(2);
    expect(JSON.parse(out.envelope)).toEqual({});
    expect(out.dumped).toBe(false);

    const rows = readObservations("sess-real");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.toolName).toBe("Read");
    expect(rows[0]?.argSummary).toBe("Read(src/foo.ts)");
    expect(rows[0]?.toolUseId).toBe("toolu_01");
    expect(rows[0]?.argKey).toMatch(/^[0-9a-f]{16}$/);

    expect(rows[1]?.toolName).toBe("Bash");
    // Critical: only the binary name lands in storage, never the
    // pipeline / arguments. The `cat /etc/passwd` tail must not
    // appear anywhere in the row.
    expect(rows[1]?.argSummary).toBe("Bash(npm)");
    const allText = rows.map((r) => `${r.argSummary}|${r.argKey}`).join("/");
    expect(allText).not.toContain("/etc/passwd");
    expect(allText).not.toContain("npm run build");
  });

  it("Edit / Write / TodoWrite collapse to <name>(arg-hidden) — bodies never stored", () => {
    const stdin = Buffer.from(
      JSON.stringify({
        session_id: "sess-hidden",
        cwd: projectDir,
        tool_calls: [
          { tool_name: "Edit", tool_input: { old_string: "secret-content", new_string: "x" }, tool_use_id: "tu-e" },
          { tool_name: "Write", tool_input: { content: "another secret" }, tool_use_id: "tu-w" },
          { tool_name: "TodoWrite", tool_input: { todos: [{ content: "x" }] }, tool_use_id: "tu-t" },
        ],
      }),
    );
    runCaptureToolUse({}, stdin);
    const rows = readObservations("sess-hidden");
    expect(rows.map((r) => r.argSummary)).toEqual([
      "Edit(arg-hidden)",
      "Write(arg-hidden)",
      "TodoWrite(arg-hidden)",
    ]);
    const allText = rows.map((r) => r.argSummary).join("|");
    expect(allText).not.toContain("secret-content");
    expect(allText).not.toContain("another secret");
  });

  it("--capture off skips the write entirely (and pure no-op envelope)", () => {
    const stdin = Buffer.from(
      JSON.stringify({
        session_id: "sess-off",
        cwd: projectDir,
        tool_calls: [
          { tool_name: "Read", tool_input: { file_path: join(projectDir, "x.ts") } },
        ],
      }),
    );
    const out = runCaptureToolUse({ capture: "off" }, stdin);
    expect(out.recorded).toBe(0);
    expect(JSON.parse(out.envelope)).toEqual({});
    expect(readObservations("sess-off")).toHaveLength(0);
  });

  it("empty / missing tool_calls is a no-op even on an initialised project", () => {
    const stdin = Buffer.from(
      JSON.stringify({
        session_id: "sess-empty",
        cwd: projectDir,
        tool_calls: [],
      }),
    );
    const out = runCaptureToolUse({}, stdin);
    expect(out.recorded).toBe(0);
    expect(readObservations("sess-empty")).toHaveLength(0);
  });

  it("falls through to the PostToolUse single-call shape when tool_calls is absent", () => {
    const stdin = Buffer.from(
      JSON.stringify({
        hook_event_name: "PostToolUse",
        session_id: "sess-single",
        cwd: projectDir,
        tool_name: "Grep",
        tool_use_id: "tu-g",
        tool_input: { pattern: "foo", path: join(projectDir, "src") },
      }),
    );
    const out = runCaptureToolUse({}, stdin);
    expect(out.recorded).toBe(1);
    const rows = readObservations("sess-single");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.toolName).toBe("Grep");
    expect(rows[0]?.argSummary).toBe('Grep("foo")[src]');
  });

  it("uninitialised cwd → empty envelope, no rows written, no crash", () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "tb-not-init-"));
    try {
      const stdin = Buffer.from(
        JSON.stringify({
          session_id: "sess-noinit",
          cwd: elsewhere,
          tool_calls: [
            { tool_name: "Read", tool_input: { file_path: join(elsewhere, "x.ts") } },
          ],
        }),
      );
      const out = runCaptureToolUse({}, stdin);
      expect(out.recorded).toBe(0);
      expect(JSON.parse(out.envelope)).toEqual({});
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("MAX_CALLS_PER_BATCH guards against pathologically large batches", () => {
    const calls = Array.from({ length: 200 }, (_, i) => ({
      tool_name: "Read",
      tool_input: { file_path: join(projectDir, `f${i}.ts`) },
      tool_use_id: `tu-${i}`,
    }));
    const stdin = Buffer.from(
      JSON.stringify({
        session_id: "sess-flood",
        cwd: projectDir,
        tool_calls: calls,
      }),
    );
    const out = runCaptureToolUse({}, stdin);
    expect(out.recorded).toBe(64);
    expect(readObservations("sess-flood")).toHaveLength(64);
  });
});
