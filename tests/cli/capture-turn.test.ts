/**
 * `tracebase capture-turn` — Stop-hook background capture.
 *
 * The Stop hook is the production replacement for the MCP
 * `store_reasoning_pattern` foreground call. Users complained that
 * every novel task ended with a permission prompt and a full-payload
 * dump in the transcript; this command runs in the background at
 * agent-stop time and writes straight to the BlockStore.
 *
 * Test coverage tracks six properties:
 *
 *   1. Envelope shape is always a parseable JSON object (hook crashes
 *      would surface red in the transcript; we never want that).
 *   2. A substantive turn lands a new block + emits the `stored` badge.
 *   3. A trivial turn (short prompt / short reply) emits the
 *      `no reusable pattern` badge and touches nothing.
 *   4. Re-running on the same situation dedupes through the fingerprint
 *      path → emits the `reinforced` badge, block count unchanged.
 *   5. `--capture silent` writes but never emits a systemMessage.
 *   6. `--capture off` is a pure no-op: nothing written, no badge.
 *
 * Every test drives the pure helper `runCaptureTurn` directly so the
 * CLI wrapping layer (argv, stdin) is bypassed. The helper is what
 * production runs after reading the hook stdin, so behaviour is
 * identical.
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
import Database from "better-sqlite3";
import { initConfig, loadConfig } from "../../src/core/config.js";
import { BlockStore } from "../../src/core/block-store.js";
import {
  extractPattern,
  parseStdinPayload,
  parseTranscript,
  runCaptureTurn,
} from "../../src/cli/commands/capture-turn.js";

let projectDir: string;
let transcriptPath: string;
const origCaptureEnv = process.env.TRACEBASE_CAPTURE;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "tb-capture-"));
  transcriptPath = join(projectDir, "transcript.jsonl");
  // Keep the env clean so --capture flags in tests aren't shadowed by
  // a TRACEBASE_CAPTURE leaking in from the surrounding shell.
  delete process.env.TRACEBASE_CAPTURE;
});

afterEach(() => {
  if (origCaptureEnv === undefined) delete process.env.TRACEBASE_CAPTURE;
  else process.env.TRACEBASE_CAPTURE = origCaptureEnv;
  rmSync(projectDir, { recursive: true, force: true });
});

function envelope(out: { envelope: string }): { systemMessage?: string } {
  return JSON.parse(out.envelope);
}

/**
 * Write a minimal JSONL transcript with a final user turn and a final
 * assistant turn. Claude Code transcripts interleave many other
 * entries (file-history-snapshot, system, etc.); capture-turn's
 * parser only cares about the final text pair.
 */
function writeTranscript(
  user: string,
  assistant: string,
  extraBefore: Array<Record<string, unknown>> = [],
): void {
  const lines = [
    // Noise entries before the real content to prove the walker skips
    // them correctly.
    { type: "file-history-snapshot", messageId: "snap-1", snapshot: {} },
    { type: "system", subtype: "note" },
    ...extraBefore,
    {
      type: "user",
      message: { role: "user", content: user },
      timestamp: new Date().toISOString(),
    },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: assistant }],
      },
      timestamp: new Date().toISOString(),
    },
  ];
  writeFileSync(transcriptPath, lines.map((l) => JSON.stringify(l)).join("\n"));
}

function countBlocks(): number {
  const cfg = loadConfig(projectDir);
  // The DB file is created lazily on first write — absence means 0
  // blocks, not a test failure.
  if (!existsSync(cfg.storagePath)) return 0;
  const db = new Database(cfg.storagePath, { readonly: true });
  const store = new BlockStore(db, { skipMigrate: true });
  try {
    return store.countBlocks("active") + store.countBlocks("candidate");
  } finally {
    store.close();
  }
}

describe("runCaptureTurn — envelope contract", () => {
  it("always returns a valid JSON envelope (never throws, hook-safe)", () => {
    const out = runCaptureTurn({}, { transcript_path: "/does/not/exist" });
    expect(() => JSON.parse(out.envelope)).not.toThrow();
    expect(out.captured).toBe(false);
    expect(out.blockId).toBeNull();
  });

  it("degrades to `no reusable pattern` when the project is uninitialised", () => {
    writeTranscript(
      "How do I fix the pytest shadowing issue in this monorepo?",
      "The fix is to remove the shadowing helper — here's why and how.".repeat(8),
    );
    const out = runCaptureTurn(
      { path: projectDir },
      { transcript_path: transcriptPath, cwd: projectDir },
    );
    expect(out.captured).toBe(false);
    expect(envelope(out).systemMessage).toBe("▣ TB MEMORY  no reusable pattern");
  });

  it("degrades to `no reusable pattern` when transcript_path is missing", () => {
    initConfig(projectDir);
    const out = runCaptureTurn({ path: projectDir }, { cwd: projectDir });
    expect(out.captured).toBe(false);
    expect(envelope(out).systemMessage).toBe("▣ TB MEMORY  no reusable pattern");
  });
});

describe("runCaptureTurn — substantive turn → stored", () => {
  it("writes a block and emits the `stored` badge for a plausible problem-solution pair", () => {
    initConfig(projectDir);
    writeTranscript(
      "pytest is collecting the wrong package in my monorepo — it picks up the sibling helper instead of the package I wanted, and I think sys.path has a shadowing module because I've seen this shape of error before in other repos.",
      `The symptom is that pytest's collection picks up a shadowing helper module earlier in sys.path than the intended package, which is why \`pytest --collect-only\` reports the wrong tree even though the directory layout looks right on paper.

Remove the shadowing helper directory from sys.path, or rename the helper module so it stops competing with the intended namespace package. In practice the cleanest fix is to delete or move the helper outside the collected package tree so the resolver has no ambiguity left.

Verify by running \`pytest --collect-only\` and confirming it only lists modules under the intended package — the failing test names should be gone from the output and the correct ones should show up.`,
    );

    const out = runCaptureTurn(
      { path: projectDir },
      { transcript_path: transcriptPath, cwd: projectDir },
    );
    expect(out.captured).toBe(true);
    expect(out.blockId).toBeTruthy();
    const msg = envelope(out).systemMessage;
    expect(msg).toMatch(/^▣ TB MEMORY  stored #[0-9a-f]+/i);
    expect(msg!.length).toBeLessThan(100);
    expect(countBlocks()).toBe(1);
  });
});

describe("runCaptureTurn — trivial turn → no reusable pattern", () => {
  it("skips the write for a short user prompt", () => {
    initConfig(projectDir);
    writeTranscript(
      "hi",
      `The symptom is that pytest's collection picks up a shadowing helper module earlier in sys.path than the intended package, which is why \`pytest --collect-only\` reports the wrong tree.

Remove the shadowing helper directory from sys.path, or rename the helper module so it stops competing with the intended namespace package.

Verify by running pytest --collect-only.`,
    );

    const out = runCaptureTurn(
      { path: projectDir },
      { transcript_path: transcriptPath, cwd: projectDir },
    );
    expect(out.captured).toBe(false);
    expect(envelope(out).systemMessage).toBe("▣ TB MEMORY  no reusable pattern");
    expect(countBlocks()).toBe(0);
  });

  it("skips the write for a short assistant reply", () => {
    initConfig(projectDir);
    writeTranscript(
      "pytest is collecting the wrong package in my monorepo — it picks up the sibling helper instead of the package I wanted.",
      "Yeah that's tricky.",
    );

    const out = runCaptureTurn(
      { path: projectDir },
      { transcript_path: transcriptPath, cwd: projectDir },
    );
    expect(out.captured).toBe(false);
    expect(envelope(out).systemMessage).toBe("▣ TB MEMORY  no reusable pattern");
    expect(countBlocks()).toBe(0);
  });
});

describe("runCaptureTurn — dedupe via fingerprint → reinforced", () => {
  it("running twice on the same transcript collapses to one block and emits `reinforced` the second time", () => {
    initConfig(projectDir);
    writeTranscript(
      "pytest is collecting the wrong package in my monorepo — it picks up the sibling helper instead of the package I wanted, and I think sys.path has a shadowing module issue here because of duplicated helpers across sibling packages.",
      `The symptom is that pytest's collection picks up a shadowing helper module earlier in sys.path than the intended package, which is why \`pytest --collect-only\` reports the wrong tree even though the directory layout looks right on paper.

Remove the shadowing helper directory from sys.path, or rename the helper module so it stops competing with the intended namespace package. The cleanest fix is to delete or move the helper outside the collected package tree so the resolver has no ambiguity left.

Verify by running pytest --collect-only and confirming the output lists only modules under the intended package.`,
    );

    const first = runCaptureTurn(
      { path: projectDir },
      { transcript_path: transcriptPath, cwd: projectDir },
    );
    expect(first.captured).toBe(true);
    expect(envelope(first).systemMessage).toMatch(/^▣ TB MEMORY  stored /);
    const afterFirst = countBlocks();
    expect(afterFirst).toBe(1);

    const second = runCaptureTurn(
      { path: projectDir },
      { transcript_path: transcriptPath, cwd: projectDir },
    );
    expect(second.captured).toBe(true);
    // Same blockId on the return — fingerprint dedupe points at the
    // existing block rather than minting a new one.
    expect(second.blockId).toBe(first.blockId);
    expect(envelope(second).systemMessage).toMatch(/^▣ TB MEMORY  reinforced /);
    expect(countBlocks()).toBe(afterFirst);
  });
});

describe("runCaptureTurn — capture modes", () => {
  const SUBSTANTIVE_USER =
    "pytest is collecting the wrong package in my monorepo — it picks up the sibling helper instead of the package I wanted, which points at a sys.path shadowing module issue.";
  const SUBSTANTIVE_ASSISTANT =
    `The symptom is that pytest's collection picks up a shadowing helper module earlier in sys.path than the intended package, which is why \`pytest --collect-only\` reports the wrong tree.

Remove the shadowing helper directory from sys.path, or rename the helper module so it stops competing with the intended namespace package.

Verify by running pytest --collect-only and confirming the output lists only modules under the intended package.`;

  it("`silent` mode writes the block but suppresses the systemMessage", () => {
    initConfig(projectDir);
    writeTranscript(SUBSTANTIVE_USER, SUBSTANTIVE_ASSISTANT);
    const out = runCaptureTurn(
      { path: projectDir, capture: "silent" },
      { transcript_path: transcriptPath, cwd: projectDir },
    );
    expect(out.captured).toBe(true);
    expect(envelope(out).systemMessage).toBeUndefined();
    expect(countBlocks()).toBe(1);
  });

  it("`off` mode writes nothing and emits no systemMessage", () => {
    initConfig(projectDir);
    writeTranscript(SUBSTANTIVE_USER, SUBSTANTIVE_ASSISTANT);
    const out = runCaptureTurn(
      { path: projectDir, capture: "off" },
      { transcript_path: transcriptPath, cwd: projectDir },
    );
    expect(out.captured).toBe(false);
    expect(envelope(out).systemMessage).toBeUndefined();
    expect(countBlocks()).toBe(0);
  });

  it("`TRACEBASE_CAPTURE=off` env wins over `--capture compact`", () => {
    initConfig(projectDir);
    writeTranscript(SUBSTANTIVE_USER, SUBSTANTIVE_ASSISTANT);
    process.env.TRACEBASE_CAPTURE = "off";
    const out = runCaptureTurn(
      { path: projectDir, capture: "compact" },
      { transcript_path: transcriptPath, cwd: projectDir },
    );
    expect(out.captured).toBe(false);
    expect(envelope(out).systemMessage).toBeUndefined();
  });

  it("`TRACEBASE_CAPTURE=compact` env wins over `--capture silent`", () => {
    initConfig(projectDir);
    writeTranscript(SUBSTANTIVE_USER, SUBSTANTIVE_ASSISTANT);
    process.env.TRACEBASE_CAPTURE = "compact";
    const out = runCaptureTurn(
      { path: projectDir, capture: "silent" },
      { transcript_path: transcriptPath, cwd: projectDir },
    );
    expect(envelope(out).systemMessage).toMatch(/^▣ TB MEMORY  stored /);
  });

  it("invalid --capture value falls back to compact default (not an error)", () => {
    initConfig(projectDir);
    writeTranscript(SUBSTANTIVE_USER, SUBSTANTIVE_ASSISTANT);
    const out = runCaptureTurn(
      { path: projectDir, capture: "loud" },
      { transcript_path: transcriptPath, cwd: projectDir },
    );
    expect(envelope(out).systemMessage).toMatch(/^▣ TB MEMORY  stored /);
  });
});

describe("parseTranscript — tolerant parser", () => {
  it("picks the final user + assistant pair, skipping noise entries", () => {
    const lines = [
      { type: "file-history-snapshot", messageId: "a" },
      {
        type: "user",
        message: {
          role: "user",
          content: "<command-name>/resume</command-name>",
        },
      }, // meta, must be skipped
      {
        type: "user",
        message: {
          role: "user",
          content: "real question about pytest collecting the wrong package shape",
        },
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "Edit", input: {} }, // must be skipped
            { type: "text", text: "assistant reply with real content" },
          ],
        },
      },
      { type: "system" },
    ];
    const summary = parseTranscript(lines.map((l) => JSON.stringify(l)).join("\n"));
    expect(summary).not.toBeNull();
    expect(summary!.lastUserText).toBe(
      "real question about pytest collecting the wrong package shape",
    );
    expect(summary!.lastAssistantText).toBe("assistant reply with real content");
  });

  it("returns null when only one side of the pair is present", () => {
    const onlyUser = JSON.stringify({
      type: "user",
      message: { role: "user", content: "just me" },
    });
    expect(parseTranscript(onlyUser)).toBeNull();
  });

  it("tolerates malformed lines and keeps scanning", () => {
    const lines = [
      "{not valid json",
      JSON.stringify({ type: "user", message: { role: "user", content: "real user text here with enough chars" } }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "real assistant reply with enough chars" }] },
      }),
      "", // empty line
    ];
    const summary = parseTranscript(lines.join("\n"));
    expect(summary).not.toBeNull();
    expect(summary!.lastAssistantText).toContain("real assistant reply");
  });
});

describe("extractPattern — heuristic gate", () => {
  it("returns null when task or outcome is too short", () => {
    expect(extractPattern("short", "x".repeat(500))).toBeNull();
    expect(extractPattern("x".repeat(100), "short")).toBeNull();
  });

  it("extracts situation + mechanism + unlock when structure is present", () => {
    const p = extractPattern(
      "pytest is picking up the wrong package when sys.path has a shadowing helper module across siblings.",
      `The symptom is that pytest's collection picks up a shadowing helper module earlier in sys.path than the intended package, which is why \`pytest --collect-only\` reports the wrong tree.

Remove the shadowing helper directory from sys.path, or rename the helper module so it stops competing with the intended namespace package.

Verify by running pytest --collect-only.`,
    );
    expect(p).not.toBeNull();
    expect(p!.situation).toMatch(/pytest is picking up the wrong package/);
    expect(p!.mechanism.length).toBeGreaterThan(0);
    expect(p!.unlock.length).toBeGreaterThan(0);
    expect(p!.verification.length).toBeGreaterThan(0);
  });
});

describe("parseStdinPayload — collapses errors to {}", () => {
  it("returns {} on empty / malformed / primitive inputs", () => {
    expect(parseStdinPayload("")).toEqual({});
    expect(parseStdinPayload("{nope")).toEqual({});
    expect(parseStdinPayload("null")).toEqual({});
    expect(parseStdinPayload("42")).toEqual({});
  });

  it("parses a well-formed object", () => {
    expect(parseStdinPayload('{"transcript_path":"/x"}')).toEqual({
      transcript_path: "/x",
    });
  });
});
