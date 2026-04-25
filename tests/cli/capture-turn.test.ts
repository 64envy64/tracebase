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
  extractFacts,
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
    expect(envelope(out).systemMessage).toBe("▣ TB TRACE  no reusable pattern");
  });

  it("degrades to `no reusable pattern` when transcript_path is missing", () => {
    initConfig(projectDir);
    const out = runCaptureTurn({ path: projectDir }, { cwd: projectDir });
    expect(out.captured).toBe(false);
    expect(envelope(out).systemMessage).toBe("▣ TB TRACE  no reusable pattern");
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
    expect(msg).toMatch(/^▣ TB TRACE  stored #[0-9a-f]+/i);
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
    expect(envelope(out).systemMessage).toBe("▣ TB TRACE  no reusable pattern");
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
    expect(envelope(out).systemMessage).toBe("▣ TB TRACE  no reusable pattern");
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
    expect(envelope(first).systemMessage).toMatch(/^▣ TB TRACE  stored /);
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
    expect(envelope(second).systemMessage).toMatch(/^▣ TB TRACE  reinforced /);
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
    expect(envelope(out).systemMessage).toMatch(/^▣ TB TRACE  stored /);
  });

  it("invalid --capture value falls back to compact default (not an error)", () => {
    initConfig(projectDir);
    writeTranscript(SUBSTANTIVE_USER, SUBSTANTIVE_ASSISTANT);
    const out = runCaptureTurn(
      { path: projectDir, capture: "loud" },
      { transcript_path: transcriptPath, cwd: projectDir },
    );
    expect(envelope(out).systemMessage).toMatch(/^▣ TB TRACE  stored /);
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

  // 0.5.6 §4 — noise-reduction tightenings.
  it("returns null when a single-paragraph assistant has no action line (degenerate unlock fallback)", () => {
    // Long enough to clear MIN_OUTCOME_CHARS but only ONE
    // paragraph — used to produce an "unlock" that was just the
    // back half of the mechanism. Now correctly rejected.
    const userText = "we keep hitting the same issue with the migration runner across every fresh clone of this repo apparently";
    const oneBigParagraph =
      "The migration runner keeps tripping over the legacy users table that was supposed to be dropped two releases ago. Several teammates have hit this; the symptom is the same — a duplicate-column error from the runner's first ALTER. Nobody picked an action item, the issue keeps coming back, and the runner doesn't dry-run cleanly. The mechanism appears to be a stale schema baseline rather than the runner itself but no concrete next step has been identified yet.";
    expect(extractPattern(userText, oneBigParagraph)).toBeNull();
  });
});

describe("extractUserText — meta-wrapper handling (0.5.6 §4 / §5)", () => {
  // Internal helper isn't exported; we exercise it through
  // parseTranscript above. This describe block's value is
  // documenting the gate intent, with one focused regression
  // case wired through the runtime.
  it("strips inline <local-command-stdout> wrappers from user text before length gate", async () => {
    // A user paste that would clear MIN_TASK_CHARS on raw length
    // but degrades to a short prompt once the meta wrapper is
    // stripped. The pattern extractor should NOT fire.
    const userTextWithWrapper =
      "ok\n<local-command-stdout>" +
      "x".repeat(500) +
      "</local-command-stdout>\nplease continue";
    // The wrapper-stripped form is "ok please continue" → 18 chars
    // → below MIN_TASK_CHARS. extractPattern receives the cleaned
    // text from extractUserText, so we test through parseTranscript
    // by running a transcript JSONL through the public surface.
    const { parseTranscript } = await import("../../src/cli/commands/capture-turn.js");
    const transcript = [
      JSON.stringify({
        type: "user",
        message: { role: "user", content: userTextWithWrapper },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text:
                "First paragraph mechanism that's substantial enough to clear MIN_OUTCOME_CHARS so we know the gate is firing on the user text length, not the assistant text length. " +
                "Adding more body so the assistant clears all gates. " +
                "Even more body to be safe. " +
                "And one more sentence so we definitely have 300+ chars in the assistant slot.\n\n" +
                "Run npm test to verify the fix.",
            },
          ],
        },
      }),
    ].join("\n");
    const summary = parseTranscript(transcript);
    expect(summary).not.toBeNull();
    // After stripping the <local-command-stdout> wrapper, the user
    // text is short — extractPattern called with this user text
    // should reject.
    const cleanedUserText = summary!.lastUserText;
    expect(cleanedUserText).not.toMatch(/local-command-stdout/);
    expect(cleanedUserText.length).toBeLessThan(80);
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

// ---------------------------------------------------------------------------
// TB MEMORY — semantic fact extraction (0.5.0)
// ---------------------------------------------------------------------------

describe("extractFacts — deterministic extraction", () => {
  it("returns [] on trivial input", () => {
    expect(extractFacts("hi", "ok")).toEqual([]);
    expect(extractFacts("", "")).toEqual([]);
  });

  it("picks a repo command from an assistant reply", () => {
    const userText = "How do I build and test this monorepo from a fresh clone?";
    const assistantText =
      "For this project the canonical workflow is: Run `npm run build` to compile the TypeScript bundle, then run `npm test` to execute the vitest suite. Both commands have to succeed before opening a PR, so treat them as the gate.";
    const facts = extractFacts(userText, assistantText);
    const stmts = facts.map((f) => f.statement);
    expect(stmts.some((s) => /npm run build/.test(s))).toBe(true);
    expect(facts.every((f) => f.factType === "file_semantic")).toBe(true);
    expect(facts.every((f) => f.scope === "project")).toBe(true);
    expect(facts.length).toBeLessThanOrEqual(3);
  });

  it("picks a repo-relative file role, ignores absolute paths", () => {
    const userText = "Where do the CLI integration tests live and which runner are they built for?";
    const assistantText =
      "For this repo `tests/cli/init-e2e.test.ts` holds the end-to-end CLI suite, which runs under vitest. The absolute tree `/Users/me/project/tests/cli/a.ts` is an aside you shouldn't reference.";
    const facts = extractFacts(userText, assistantText);
    expect(facts.some((f) => f.statement.includes("tests/cli/init-e2e.test.ts"))).toBe(true);
    // Absolute-path candidate rejected.
    expect(facts.every((f) => !f.statement.includes("/Users/"))).toBe(true);
  });

  it("rejects candidates containing secrets", () => {
    const userText = "How do I set the API key and call the service?";
    const assistantText =
      "Run `npm run build` to compile. Also set `ANTHROPIC_API_KEY=sk-ant-abcdef0123456789abcdef0123abcdef0123` in your environment before launching.";
    const facts = extractFacts(userText, assistantText);
    // The `npm run build` line might still land — but nothing containing
    // the secret should pass the leakage scanner.
    expect(facts.every((f) => !/sk-ant-/.test(f.statement))).toBe(true);
    expect(facts.every((f) => !/ANTHROPIC_API_KEY=/.test(f.statement))).toBe(true);
  });

  it("picks env requirements", () => {
    const userText = "What runtime versions does this project need on a fresh machine?";
    const assistantText =
      "For this repo Node >= 18 and Python >= 3.11 are hard requirements. A Node 16 install won't bundle the native modules correctly, and 3.10 fails the pytest fixtures for the integrations test suite.";
    const facts = extractFacts(userText, assistantText);
    expect(facts.some((f) => /Node >= 18/.test(f.statement))).toBe(true);
    expect(facts.some((f) => /Python >= 3\.11/.test(f.statement))).toBe(true);
  });

  it("caps at 3 facts per turn", () => {
    const userText = "Describe every convention and build command this project uses in detail.";
    const assistantText = `
Run \`npm run build\` first.
Run \`npm test\` second.
Run \`npm run lint\` third.
Uses Vitest for the test runner.
Uses ESLint for linting.
Uses Prettier for formatting.
Node >= 18 is required.
Python >= 3.11 is required.
`.trim();
    const facts = extractFacts(userText, assistantText);
    expect(facts.length).toBeLessThanOrEqual(3);
  });

  it("dedupes duplicate candidates within the turn", () => {
    const userText = "Remind me how to build and test this project once more, please.";
    const assistantText =
      "Run `npm run build` to compile. Run `npm run build` again if it fails the first time. Run `npm test` to verify.";
    const facts = extractFacts(userText, assistantText);
    const buildCount = facts.filter((f) => /npm run build/.test(f.statement)).length;
    expect(buildCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// runCaptureTurn — composite TB TRACE + TB MEMORY badge (0.5.0)
// ---------------------------------------------------------------------------

function writeTranscriptFacts(user: string, assistant: string): void {
  const path = transcriptPath;
  const lines = [
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
  require("node:fs").writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n"));
  void path;
}

describe("runCaptureTurn — composite TB TRACE + TB MEMORY badge", () => {
  it("emits composite badge when pattern stored AND facts noted", () => {
    initConfig(projectDir);
    writeTranscriptFacts(
      "pytest is collecting the wrong package in my monorepo — the helper module shadows sys.path.",
      `The symptom is that pytest's collection picks up a shadowing helper earlier in sys.path than the intended package, which is why pytest --collect-only reports the wrong tree.

Remove the shadowing helper directory from sys.path, or rename the helper module so it stops competing with the intended namespace package.

Verify by running \`npm test\` to confirm the pytest fixtures now find the intended package. Node >= 18 is required.`,
    );
    const out = runCaptureTurn(
      { path: projectDir },
      { transcript_path: transcriptPath, cwd: projectDir },
    );
    expect(out.captured).toBe(true);
    const msg = JSON.parse(out.envelope).systemMessage as string;
    expect(msg).toMatch(/^▣ TB TRACE  stored #[0-9a-f]+/);
    expect(msg).toMatch(/· ▣ TB MEMORY  noted \d+ fact\(s\)/);
    expect(msg.length).toBeLessThan(100);
  });

  it("emits only TB MEMORY when no pattern stored but facts noted", () => {
    initConfig(projectDir);
    // Transcript where the assistant's answer is too short to pass
    // the pattern-extractor gate (< MIN_OUTCOME_CHARS) but still
    // contains extractable facts.
    writeTranscriptFacts(
      "What runtime does this project require on a fresh clone? Which test runner is used?",
      "Node >= 18 is required for this repo, and the test runner is Vitest.",
    );
    const out = runCaptureTurn(
      { path: projectDir },
      { transcript_path: transcriptPath, cwd: projectDir },
    );
    const msg = JSON.parse(out.envelope).systemMessage as string;
    expect(msg).toMatch(/^▣ TB MEMORY  noted \d+ fact\(s\)/);
    expect(msg).not.toContain("TB TRACE");
  });

  it("falls back to `no reusable pattern` when neither side extracts", () => {
    initConfig(projectDir);
    writeTranscriptFacts(
      "how do I fix the pytest shadow — short question without enough detail to trigger extraction",
      "hmm",
    );
    const out = runCaptureTurn(
      { path: projectDir },
      { transcript_path: transcriptPath, cwd: projectDir },
    );
    const msg = JSON.parse(out.envelope).systemMessage as string;
    expect(msg).toBe("▣ TB TRACE  no reusable pattern");
  });
});
