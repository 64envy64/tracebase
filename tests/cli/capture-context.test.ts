/**
 * `tracebase capture-context` — 0.5.2 dump-first scaffold.
 *
 * Covers what this release ships and nothing more:
 *
 *   1. `--dump-stdin` writes bounded raw bytes to a known path under
 *      the user's home and echoes the parsed shape to stderr.
 *   2. Default mode is an intentional no-op — emits a valid empty
 *      envelope, touches no disk, returns `dumped: false`.
 *   3. `parseStdinPayload` collapses every malformed / primitive /
 *      oversized input to `{}` so the hook never throws.
 *
 * The real parser + digest extractor land in a follow-up release
 * after a live PreCompact payload has been captured and the shape
 * locked against ground truth.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseStdinPayload,
  runCaptureContext,
} from "../../src/cli/commands/capture-context.js";

let homeDir: string;
const origHome = process.env.HOME;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "tb-capture-ctx-home-"));
  process.env.HOME = homeDir;
});

afterEach(() => {
  process.env.HOME = origHome;
  rmSync(homeDir, { recursive: true, force: true });
});

describe("runCaptureContext — default mode (no-op)", () => {
  it("emits an empty envelope, writes no dump, returns dumped=false", () => {
    const rawStdin = Buffer.from(
      JSON.stringify({
        hook_event_name: "PreCompact",
        transcript_path: "/does/not/matter/here",
        session_id: "s-1",
        cwd: "/tmp/anywhere",
      }),
    );
    const out = runCaptureContext({}, rawStdin);
    expect(JSON.parse(out.envelope)).toEqual({});
    expect(out.dumped).toBe(false);
    expect(out.dumpPath).toBeNull();

    // No dump directory created.
    expect(existsSync(join(homeDir, ".tracebase", "precompact-dumps"))).toBe(false);
  });

  it("no-ops even when stdin is empty — hook-safe on misfires", () => {
    const out = runCaptureContext({}, Buffer.alloc(0));
    expect(JSON.parse(out.envelope)).toEqual({});
    expect(out.dumped).toBe(false);
  });
});

describe("runCaptureContext — --dump-stdin dev mode", () => {
  it("writes the raw bytes to ~/.tracebase/precompact-dumps/<ts>-<session>.jsonl", () => {
    const rawStdin = Buffer.from(
      JSON.stringify({
        hook_event_name: "PreCompact",
        transcript_path: "/tmp/transcript.jsonl",
        session_id: "sess-abc-123",
        cwd: "/tmp/proj",
        trigger: "manual",
      }),
    );
    const out = runCaptureContext({ dumpStdin: true }, rawStdin);
    expect(out.dumped).toBe(true);
    expect(out.dumpPath).toBeTruthy();
    expect(out.dumpPath!.startsWith(join(homeDir, ".tracebase", "precompact-dumps"))).toBe(true);

    // Envelope still valid — PreCompact proceeds unaffected.
    expect(JSON.parse(out.envelope)).toEqual({});

    // File on disk round-trips the raw bytes.
    const onDisk = readFileSync(out.dumpPath!);
    expect(onDisk.toString("utf-8")).toBe(rawStdin.toString("utf-8"));

    // Filename encodes both timestamp and a sanitised session tag.
    const dir = join(homeDir, ".tracebase", "precompact-dumps");
    const entries = readdirSync(dir);
    expect(entries.length).toBe(1);
    expect(entries[0]).toMatch(/sess-abc-123/);
    expect(entries[0]).toMatch(/\.jsonl$/);
  });

  it("filesystem-sanitises session ids containing path separators", () => {
    const rawStdin = Buffer.from(
      JSON.stringify({ session_id: "weird/session:value\\bad" }),
    );
    const out = runCaptureContext({ dumpStdin: true }, rawStdin);
    expect(out.dumped).toBe(true);
    // No raw slash / colon in the path basename — substitutions
    // must yield a filename-safe tag.
    const base = out.dumpPath!.split("/").pop()!;
    expect(base).not.toContain("/");
    expect(base).not.toContain(":");
    expect(base).not.toContain("\\");
  });

  it("falls back to `unknown-session` when the payload has no session id", () => {
    const rawStdin = Buffer.from("{}");
    const out = runCaptureContext({ dumpStdin: true }, rawStdin);
    expect(out.dumped).toBe(true);
    const base = out.dumpPath!.split("/").pop()!;
    expect(base).toMatch(/unknown-session/);
  });

  it("dumps empty stdin as an empty file without throwing", () => {
    const out = runCaptureContext({ dumpStdin: true }, Buffer.alloc(0));
    expect(out.dumped).toBe(true);
    const onDisk = readFileSync(out.dumpPath!);
    expect(onDisk.length).toBe(0);
  });

  it("emits an empty envelope even when the dump write fails", () => {
    // Point HOME at a file (not a directory) to force mkdir to fail.
    const badFile = join(homeDir, "blocker");
    require("node:fs").writeFileSync(badFile, "x");
    process.env.HOME = badFile;
    try {
      const out = runCaptureContext({ dumpStdin: true }, Buffer.from("{}"));
      expect(JSON.parse(out.envelope)).toEqual({});
      expect(out.dumped).toBe(false);
      expect(out.dumpPath).toBeNull();
    } finally {
      process.env.HOME = homeDir;
    }
  });
});

describe("parseStdinPayload — tolerant to every failure mode", () => {
  it("returns {} for empty / malformed / primitive / over-size input", () => {
    expect(parseStdinPayload("")).toEqual({});
    expect(parseStdinPayload(Buffer.alloc(0))).toEqual({});
    expect(parseStdinPayload("{not valid")).toEqual({});
    expect(parseStdinPayload("null")).toEqual({});
    expect(parseStdinPayload("42")).toEqual({});
    expect(parseStdinPayload('"a string"')).toEqual({});
    expect(parseStdinPayload("[1,2,3]")).toEqual({});
    const oversize = "{\"padding\":\"" + "x".repeat(300_000) + "\"}";
    expect(parseStdinPayload(oversize)).toEqual({});
  });

  it("parses a well-formed PreCompact-shaped payload", () => {
    const parsed = parseStdinPayload(
      JSON.stringify({
        hook_event_name: "PreCompact",
        transcript_path: "/x/tx.jsonl",
        session_id: "s-1",
        cwd: "/work",
        trigger: "auto",
        custom_instructions: "compress hard",
      }),
    );
    expect(parsed.hook_event_name).toBe("PreCompact");
    expect(parsed.transcript_path).toBe("/x/tx.jsonl");
    expect(parsed.session_id).toBe("s-1");
    expect(parsed.cwd).toBe("/work");
    expect(parsed.trigger).toBe("auto");
    expect(parsed.custom_instructions).toBe("compress hard");
  });

  it("preserves unknown fields (dump mode inspects everything)", () => {
    const parsed = parseStdinPayload(
      JSON.stringify({
        session_id: "s-1",
        futureField: "still visible in the dump",
        nested: { anything: [1, 2, 3] },
      }),
    ) as Record<string, unknown>;
    expect(parsed.futureField).toBe("still visible in the dump");
    expect(parsed.nested).toEqual({ anything: [1, 2, 3] });
  });
});
