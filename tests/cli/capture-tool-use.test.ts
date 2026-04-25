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
import { join } from "node:path";
import {
  parseStdinPayload,
  runCaptureToolUse,
} from "../../src/cli/commands/capture-tool-use.js";

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
    const base = out.dumpPath!.split("/").pop()!;
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
