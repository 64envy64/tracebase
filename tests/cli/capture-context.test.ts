/**
 * `tracebase capture-context` — 0.5.2 PreCompact hook backend.
 *
 * Five coverage axes:
 *
 *   1. Digest extraction. A substantive transcript yields a bounded
 *      deterministic digest of last user questions + assistant
 *      section headers + bullet first-items, ≤ 1200 chars, never
 *      paraphrased.
 *   2. Storage. `runCaptureContext` writes the digest as a
 *      `session_digest` fact with the canonical `project.session.<sha>`
 *      scope and a 14-day TTL. Sweeper retires expired rows.
 *   3. Mode switches. `--capture compact|silent|off` map cleanly to
 *      "saved badge" / "saved no badge" / "no write no badge".
 *      Env override `TRACEBASE_CAPTURE_CONTEXT` wins over the flag.
 *   4. Failure isolation. Trivial / missing transcript / missing
 *      session id / store unavailable / leaky digest each emit a
 *      well-shaped envelope; no path ever throws.
 *   5. `--dump-stdin` dev-only diagnostic still works in isolation
 *      and is NEVER fired from the default path.
 *
 * Tests drive `runCaptureContext` directly so the CLI wrapping
 * layer (argv, stdin reader) is bypassed; the helper is what
 * production runs after the stdin read, so behaviour is identical.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { initConfig, loadConfig } from "../../src/core/config.js";
import { BlockStore } from "../../src/core/block-store.js";
import {
  extractDigest,
  parseStdinPayload,
  runCaptureContext,
  sessionScope,
} from "../../src/cli/commands/capture-context.js";

let projectDir: string;
let homeDir: string;
let transcriptPath: string;
const origHome = process.env.HOME;
const origCaptureCtx = process.env.TRACEBASE_CAPTURE_CONTEXT;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "tb-capture-ctx-"));
  homeDir = mkdtempSync(join(tmpdir(), "tb-capture-ctx-home-"));
  process.env.HOME = homeDir;
  delete process.env.TRACEBASE_CAPTURE_CONTEXT;
  transcriptPath = join(projectDir, "transcript.jsonl");
});

afterEach(() => {
  process.env.HOME = origHome;
  if (origCaptureCtx === undefined) delete process.env.TRACEBASE_CAPTURE_CONTEXT;
  else process.env.TRACEBASE_CAPTURE_CONTEXT = origCaptureCtx;
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

function envelope(out: { envelope: string }): { systemMessage?: string } {
  return JSON.parse(out.envelope);
}

/** Minimal substantive transcript that exercises every digest source. */
function writeSubstantiveTranscript(): void {
  const lines = [
    { type: "file-history-snapshot", messageId: "snap-1" },
    {
      type: "user",
      message: { role: "user", content: "How do I fix the pytest shadow issue in this monorepo?" },
      timestamp: new Date().toISOString(),
    },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: `## Diagnosis

The shadowing helper module sits earlier in sys.path than the intended package.

## Fix

- Remove the shadow directory from sys.path
- Or rename the helper module so it stops competing

## Verify

Run pytest --collect-only and confirm only the intended package is listed.`,
          },
        ],
      },
      timestamp: new Date().toISOString(),
    },
    {
      type: "user",
      message: { role: "user", content: "Why does that happen on a fresh clone but not in CI?" },
      timestamp: new Date().toISOString(),
    },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: `### Root cause

CI's PYTHONPATH wipes user dotfiles, so the local shadow never appears.

- Local sys.path inherits from your shell
- CI's sys.path is hermetic

OK so the fix is environment-aware.`,
          },
        ],
      },
      timestamp: new Date().toISOString(),
    },
  ];
  writeFileSync(transcriptPath, lines.map((l) => JSON.stringify(l)).join("\n"));
}

function countActiveDigests(): number {
  const cfg = loadConfig(projectDir);
  if (!existsSync(cfg.storagePath)) return 0;
  const db = new Database(cfg.storagePath, { readonly: true });
  const store = new BlockStore(db, { skipMigrate: true });
  try {
    return store.searchFacts({
      text: "",
      status: "active",
      factTypes: ["session_digest"],
      limit: 100,
    }).length;
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// Digest extractor — pure, deterministic
// ---------------------------------------------------------------------------

describe("extractDigest — deterministic, bounded", () => {
  it("returns null for an empty / under-threshold transcript", () => {
    expect(extractDigest("")).toBeNull();
    expect(extractDigest("hi")).toBeNull();
  });

  it("captures last user questions + assistant headers + bullet first-items", () => {
    writeSubstantiveTranscript();
    const raw = readFileSync(transcriptPath, "utf-8");
    const digest = extractDigest(raw);
    expect(digest).not.toBeNull();
    const d = digest!;
    // Sections appear with their canonical markers.
    expect(d).toMatch(/Recent user questions:/);
    expect(d).toMatch(/Discussion topics:/);
    expect(d).toMatch(/Key points:/);
    // User questions kept verbatim.
    expect(d).toMatch(/pytest shadow/i);
    // Headers present.
    expect(d).toMatch(/Diagnosis|Fix|Verify|Root cause/);
    // Bounded.
    expect(d.length).toBeLessThanOrEqual(1200);
  });

  it("rejects digests that contain leakage shapes (absolute path)", () => {
    const transcript = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: "Why does the build fail on a fresh checkout? Walk me through the failure.",
      },
    }) + "\n" + JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "## Diagnosis\n\n- The error trace points at /Users/me/work/project/dist/cli.js line 42\n- The bootstrap script picks the wrong path",
          },
        ],
      },
    });
    expect(extractDigest(transcript)).toBeNull();
  });

  it("0.5.6 §5 — skips <local-command-stdout> / <local-command-output> meta-wrapper user lines", () => {
    // Two user turns: one is a legit question, the other is a
    // local slash-command output that shouldn't surface in the
    // digest's "Recent user questions:" section.
    const transcript =
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content:
            "<local-command-stdout>Login successful</local-command-stdout>",
        },
      }) +
      "\n" +
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content:
            "<local-command-output>some captured shell output that we definitely don't want in our digest</local-command-output>",
        },
      }) +
      "\n" +
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: "What's the right way to wire the migration runner here on a fresh clone?",
        },
      }) +
      "\n" +
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text:
                "## Diagnosis\n\nThe migration runner expects a clean schema baseline.\n\n## Fix\n\n- Drop the legacy users table\n- Apply 0042_user_schema\n\n## Verify\n\nRun the migration test suite end to end.",
            },
          ],
        },
      });
    const digest = extractDigest(transcript)!;
    expect(digest).not.toBeNull();
    expect(digest).toContain("migration runner");
    // Must NOT mention the meta-wrapper outputs.
    expect(digest).not.toContain("Login successful");
    expect(digest).not.toContain("captured shell output");
    expect(digest).not.toContain("local-command-stdout");
    expect(digest).not.toContain("local-command-output");
  });

  it("rejects digests that contain API-key shapes", () => {
    const transcript = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: "Pin the API key in the doctor diagnostics — what's the right format?",
      },
    }) + "\n" + JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "## Setup\n\n- Use the literal `sk-ant-abcdefghijklmnopqrstuvwxyz0123456789` token\n- Restart the daemon",
          },
        ],
      },
    });
    expect(extractDigest(transcript)).toBeNull();
  });

  it("strips code blocks before extraction", () => {
    const transcript = JSON.stringify({
      type: "user",
      message: { role: "user", content: "Show me the implementation" },
    }) + "\n" + JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text:
              "## Implementation\n\n```ts\nconst secret = \"sk-not-allowed-but-inside-code-block\";\nfunction f() { return 1; }\n```\n\n- The function returns 1 always",
          },
        ],
      },
    });
    const digest = extractDigest(transcript)!;
    // Code-block contents removed.
    expect(digest).not.toContain("sk-not-allowed");
    expect(digest).not.toContain("function f()");
    // Surrounding text preserved.
    expect(digest).toMatch(/Implementation/);
  });

  it("skips Claude Code meta wrappers as user content", () => {
    const transcript = JSON.stringify({
      type: "user",
      message: { role: "user", content: "<command-name>/resume</command-name>" },
    }) + "\n" + JSON.stringify({
      type: "user",
      message: { role: "user", content: "Real question — how do I make this faster?" },
    }) + "\n" + JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "## Speedup\n\n- Cache the result" }],
      },
    });
    const digest = extractDigest(transcript)!;
    expect(digest).toMatch(/how do I make this faster/);
    expect(digest).not.toMatch(/command-name/);
  });
});

// ---------------------------------------------------------------------------
// runCaptureContext — default (compact) mode happy path
// ---------------------------------------------------------------------------

describe("runCaptureContext — default compact mode writes the digest", () => {
  it("saves a session_digest fact at project.session.<hash> scope with TTL", () => {
    initConfig(projectDir);
    writeSubstantiveTranscript();
    const out = runCaptureContext(
      { path: projectDir },
      Buffer.from(
        JSON.stringify({
          hook_event_name: "PreCompact",
          transcript_path: transcriptPath,
          cwd: projectDir,
          session_id: "sess-bench-1",
          trigger: "manual",
        }),
      ),
    );
    expect(out.captured).toBe(true);
    expect(out.factId).toBeTruthy();
    // 0.7.0-rc.6 hardening 2 — the substantive transcript now
    // produces chunks too, so the composite badge appends
    // `· folded N turns` after the digest token count. Both
    // shapes are valid: digest-only (no chunks) and digest+chunks.
    expect(envelope(out).systemMessage).toMatch(
      /^▣ TB CONTEXT  digest saved · \d+t( · folded \d+ turns)?$/,
    );

    // Round-trip the fact: scope, factType, TTL all set as designed.
    const cfg = loadConfig(projectDir);
    const db = new Database(cfg.storagePath, { readonly: true });
    const store = new BlockStore(db, { skipMigrate: true });
    try {
      const fact = store.getFact(out.factId!);
      expect(fact).not.toBeNull();
      expect(fact!.factType).toBe("session_digest");
      expect(fact!.scope).toBe(sessionScope("sess-bench-1"));
      expect(fact!.scope).toMatch(/^project\.session\.[0-9a-f]{12}$/);
      expect(fact!.ttlUntilAt).toBeDefined();
      // 14 days ≈ 14 * 86_400_000 ms ≈ 1.21e9 ms in the future.
      const horizon = Date.now() + 13 * 86_400_000;
      expect(fact!.ttlUntilAt!).toBeGreaterThan(horizon);
    } finally {
      store.close();
    }
  });

  it("emits skipped · no content for a transcript that yields no digest", () => {
    initConfig(projectDir);
    writeFileSync(transcriptPath, JSON.stringify({ type: "system", subtype: "noise" }) + "\n");
    const out = runCaptureContext(
      { path: projectDir },
      Buffer.from(
        JSON.stringify({
          hook_event_name: "PreCompact",
          transcript_path: transcriptPath,
          session_id: "sess-empty",
          cwd: projectDir,
        }),
      ),
    );
    expect(out.captured).toBe(false);
    expect(envelope(out).systemMessage).toBe("▣ TB CONTEXT  skipped · no content");
  });

  // 0.7.0-rc.6 hardening 2 — P2.3 regression. The PreCompact
  // status badge must reflect what ACTUALLY landed in the txn,
  // not always claim "digest saved · 0t" on a fall-through.
  // Four states:
  //   1. digest+chunks → "digest saved · Nt · folded N turns"
  //   2. chunks-only   → "folded N turns"
  //   3. digest-only   → "digest saved · Nt"
  //   4. nothing       → "skipped · no content"
  it("status: chunks-only outcome reports `folded N turns` (no fake digest claim)", () => {
    initConfig(projectDir);
    // Make legacy `extractDigest` return null while turns still
    // parse + produce chunks. The extractor skips:
    //   - user-line first-line outside [12, 200] chars
    //   - assistant text with no `^#+\s` headers AND no `^[-*•]\s`
    //     bullets
    // Long-line single-token user content (300 chars on one line)
    // exceeds 200 → userQuestions empty. Assistant text is
    // continuous prose with no markdown headers or bullets →
    // assistantHeaders / assistantBullets empty. extractDigest →
    // returns null.
    const lines: Array<Record<string, unknown>> = [];
    const longUserLine = "ok ".repeat(120); // 360 chars, single line
    const noStructureProse =
      "Continuous assistant prose without any markdown structure, no headers no bullets, " +
      "just paragraph content that goes on long enough to fold into chunks reliably ".repeat(4);
    for (let i = 0; i < 16; i++) {
      lines.push(
        i % 2 === 0
          ? {
              type: "user",
              message: { role: "user", content: longUserLine },
            }
          : {
              type: "assistant",
              message: {
                role: "assistant",
                content: [{ type: "text", text: noStructureProse }],
              },
            },
      );
    }
    writeFileSync(transcriptPath, lines.map((l) => JSON.stringify(l)).join("\n"));

    const out = runCaptureContext(
      { path: projectDir },
      Buffer.from(
        JSON.stringify({
          hook_event_name: "PreCompact",
          transcript_path: transcriptPath,
          session_id: "sess-folded-only",
          cwd: projectDir,
        }),
      ),
    );
    // factId is null (digest path didn't write), but the badge
    // MUST honestly report the chunk fold outcome.
    expect(out.factId).toBeNull();
    expect(envelope(out).systemMessage).toMatch(
      /^▣ TB CONTEXT  folded \d+ turns$/,
    );
    // And session_chunks did land for this session.
    const cfg = loadConfig(projectDir);
    const db = new Database(cfg.storagePath, { readonly: true });
    const store = new BlockStore(db, { skipMigrate: true });
    try {
      expect(store.countSessionChunks("sess-folded-only")).toBeGreaterThanOrEqual(1);
    } finally {
      store.close();
    }
  });

  it("status: digest+chunks outcome reports both 'digest saved · Nt · folded N turns'", () => {
    initConfig(projectDir);
    writeSubstantiveTranscript();
    const out = runCaptureContext(
      { path: projectDir },
      Buffer.from(
        JSON.stringify({
          hook_event_name: "PreCompact",
          transcript_path: transcriptPath,
          session_id: "sess-both-paths",
          cwd: projectDir,
        }),
      ),
    );
    expect(out.factId).toBeTruthy();
    expect(envelope(out).systemMessage).toMatch(
      /^▣ TB CONTEXT  digest saved · \d+t · folded \d+ turns$/,
    );
  });

  it("status: re-running on identical transcript no-ops cleanly (no false 'folded' claim)", () => {
    // Pre-hardening 2 risk: the second run could claim "folded N
    // turns" even though INSERT OR IGNORE accepted 0 new rows.
    // The hardening tracks `inserted` from recordSessionChunks
    // honestly so the badge only mentions chunks the txn actually
    // wrote.
    initConfig(projectDir);
    writeSubstantiveTranscript();
    const env = (sid: string) => ({
      hook_event_name: "PreCompact",
      transcript_path: transcriptPath,
      session_id: sid,
      cwd: projectDir,
    });
    runCaptureContext(
      { path: projectDir },
      Buffer.from(JSON.stringify(env("sess-idem"))),
    );
    const second = runCaptureContext(
      { path: projectDir },
      Buffer.from(JSON.stringify(env("sess-idem"))),
    );
    // Second run inserts 0 new chunks (same turn_hash) AND
    // storeFact dedupes the digest, so factId may be present
    // or null depending on dedupe behaviour. Either way, the
    // badge must NOT claim a fresh fold count.
    const msg = envelope(second).systemMessage;
    expect(msg).not.toMatch(/folded [1-9]\d* turns/);
  });

  // 0.7.0-rc.6 hardening — P2.1 regression. Chunk fold MUST run
  // even when the legacy digest extractor returns null. Pre-
  // hardening, the chunk path was gated on `if (!digest) return`,
  // so a transcript whose turns parse but produce no markdown-
  // header digest left zero session_chunks rows.
  it("chunk fold runs independently of digest: turns parse + no digest → chunks land", () => {
    initConfig(projectDir);
    // Write a transcript whose turns parse fine (user + assistant
    // text blocks) but whose user content is too short for the
    // legacy digest extractor's MIN length gate (12 chars). Combined
    // with assistant text that has no markdown headers / bullets,
    // extractDigest returns null. But the FoldTurns path should
    // STILL produce ≥1 chunk because there's enough total content.
    const lines: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 16; i++) {
      lines.push(
        i % 2 === 0
          ? {
              type: "user",
              message: { role: "user", content: "ok" + " padding".repeat(20) },
            }
          : {
              type: "assistant",
              message: {
                role: "assistant",
                content: [
                  {
                    type: "text",
                    text:
                      "Plain prose without markdown headers or bullets, just continuous content " +
                      "that the legacy digest extractor will not extract any structured ".repeat(3),
                  },
                ],
              },
            },
      );
    }
    writeFileSync(transcriptPath, lines.map((l) => JSON.stringify(l)).join("\n"));

    const out = runCaptureContext(
      { path: projectDir },
      Buffer.from(
        JSON.stringify({
          hook_event_name: "PreCompact",
          transcript_path: transcriptPath,
          session_id: "sess-fold-only",
          cwd: projectDir,
        }),
      ),
    );
    // Digest may or may not have written (depends on how much
    // header / bullet structure the assistant text carries). The
    // load-bearing assertion is that session_chunks rows exist
    // for this session regardless.
    const cfg = loadConfig(projectDir);
    const db = new Database(cfg.storagePath, { readonly: true });
    const store = new BlockStore(db, { skipMigrate: true });
    try {
      const chunkCount = store.countSessionChunks("sess-fold-only");
      expect(chunkCount).toBeGreaterThanOrEqual(1);
    } finally {
      store.close();
    }
    // Envelope still resolves — captured may be false (digest path
    // null) but the rc.6 capability landed.
    void out;
  });

  it("emits skipped · no content when transcript_path is missing or unreadable", () => {
    initConfig(projectDir);
    const out = runCaptureContext(
      { path: projectDir },
      Buffer.from(JSON.stringify({ session_id: "s", cwd: projectDir })),
    );
    expect(out.captured).toBe(false);
    expect(envelope(out).systemMessage).toBe("▣ TB CONTEXT  skipped · no content");
  });

  it("emits skipped · no content when the project is uninitialised", () => {
    writeSubstantiveTranscript();
    const out = runCaptureContext(
      { path: projectDir },
      Buffer.from(
        JSON.stringify({
          transcript_path: transcriptPath,
          session_id: "s",
          cwd: projectDir,
        }),
      ),
    );
    expect(out.captured).toBe(false);
    // Uninitialised + no-content collapse to the same user-facing
    // message; both signal "nothing to do".
    expect(envelope(out).systemMessage).toBe("▣ TB CONTEXT  skipped · no content");
  });
});

// ---------------------------------------------------------------------------
// Mode switches: silent / off / env override
// ---------------------------------------------------------------------------

describe("runCaptureContext — capture mode switches", () => {
  it("`silent` writes the digest but suppresses the systemMessage", () => {
    initConfig(projectDir);
    writeSubstantiveTranscript();
    const out = runCaptureContext(
      { path: projectDir, capture: "silent" },
      Buffer.from(
        JSON.stringify({
          transcript_path: transcriptPath,
          session_id: "sess-silent",
          cwd: projectDir,
        }),
      ),
    );
    expect(out.captured).toBe(true);
    expect(envelope(out).systemMessage).toBeUndefined();
    expect(countActiveDigests()).toBe(1);
  });

  it("`off` writes nothing, emits no systemMessage", () => {
    initConfig(projectDir);
    writeSubstantiveTranscript();
    const out = runCaptureContext(
      { path: projectDir, capture: "off" },
      Buffer.from(
        JSON.stringify({
          transcript_path: transcriptPath,
          session_id: "sess-off",
          cwd: projectDir,
        }),
      ),
    );
    expect(out.captured).toBe(false);
    expect(envelope(out).systemMessage).toBeUndefined();
    expect(countActiveDigests()).toBe(0);
  });

  it("`TRACEBASE_CAPTURE_CONTEXT=off` env wins over `--capture compact`", () => {
    initConfig(projectDir);
    writeSubstantiveTranscript();
    process.env.TRACEBASE_CAPTURE_CONTEXT = "off";
    const out = runCaptureContext(
      { path: projectDir, capture: "compact" },
      Buffer.from(
        JSON.stringify({
          transcript_path: transcriptPath,
          session_id: "sess-env",
          cwd: projectDir,
        }),
      ),
    );
    expect(out.captured).toBe(false);
    expect(envelope(out).systemMessage).toBeUndefined();
  });

  it("`TRACEBASE_CAPTURE_CONTEXT=compact` env wins over `--capture silent`", () => {
    initConfig(projectDir);
    writeSubstantiveTranscript();
    process.env.TRACEBASE_CAPTURE_CONTEXT = "compact";
    const out = runCaptureContext(
      { path: projectDir, capture: "silent" },
      Buffer.from(
        JSON.stringify({
          transcript_path: transcriptPath,
          session_id: "sess-env-2",
          cwd: projectDir,
        }),
      ),
    );
    expect(envelope(out).systemMessage).toMatch(/^▣ TB CONTEXT  digest saved /);
  });
});

// ---------------------------------------------------------------------------
// TTL sweeper — used by doctor at command time
// ---------------------------------------------------------------------------

describe("BlockStore.sweepExpiredFacts — retires past-TTL session digests", () => {
  it("retires a digest whose ttl_until_at is past, leaves durable facts alone", () => {
    initConfig(projectDir);
    const cfg = loadConfig(projectDir);
    const db = new Database(cfg.storagePath);
    const store = new BlockStore(db);
    // Durable fact (no TTL).
    store.storeFact({
      scope: "project",
      factType: "file_semantic",
      statement: "tests live under tests/cli/*.test.ts",
      invariants: {},
      source: { origin: "observed" },
    });
    // Session digest with a 1-day TTL we'll then rewind.
    const digest = store.storeFact({
      scope: sessionScope("expiring"),
      factType: "session_digest",
      statement: "Recent user questions:\n- expired session sample for tests",
      invariants: {},
      source: { origin: "observed", reference: "expiring" },
      ttlDays: 1,
    });
    // Force the row's ttl_until_at into the past.
    db.prepare("UPDATE project_facts SET ttl_until_at = ? WHERE id = ?")
      .run(Date.now() - 1, digest.id);

    const swept = store.sweepExpiredFacts();
    expect(swept).toBe(1);

    const stillThere = store.searchFacts({
      text: "tests live",
      status: "active",
      limit: 10,
    });
    expect(stillThere.length).toBeGreaterThan(0);

    const expired = store.getFact(digest.id);
    expect(expired?.status).toBe("retired");
    store.close();
  });
});

// ---------------------------------------------------------------------------
// --dump-stdin dev-only diagnostic
// ---------------------------------------------------------------------------

describe("runCaptureContext — --dump-stdin (dev-only)", () => {
  it("writes raw bytes to ~/.tracebase/precompact-dumps/<ts>-<session>.jsonl", () => {
    const raw = Buffer.from(
      JSON.stringify({
        hook_event_name: "PreCompact",
        session_id: "dev-dump-session",
        cwd: "/anywhere",
      }),
    );
    const out = runCaptureContext({ dumpStdin: true }, raw);
    expect(out.dumped).toBe(true);
    expect(out.dumpPath).toBeTruthy();
    expect(envelope(out).systemMessage).toBeUndefined(); // dump never emits a badge

    const onDisk = readFileSync(out.dumpPath!);
    expect(onDisk.toString("utf-8")).toBe(raw.toString("utf-8"));

    const dir = join(homeDir, ".tracebase", "precompact-dumps");
    const entries = readdirSync(dir);
    expect(entries.length).toBe(1);
    expect(entries[0]).toMatch(/dev-dump-session/);
  });

  it("dump mode short-circuits BEFORE any digest extraction or fact write", () => {
    initConfig(projectDir);
    writeSubstantiveTranscript();
    const raw = Buffer.from(
      JSON.stringify({
        hook_event_name: "PreCompact",
        session_id: "dump-no-write",
        transcript_path: transcriptPath,
        cwd: projectDir,
      }),
    );
    const out = runCaptureContext({ dumpStdin: true, path: projectDir }, raw);
    expect(out.captured).toBe(false);
    expect(out.factId).toBeNull();
    expect(out.dumped).toBe(true);
    expect(countActiveDigests()).toBe(0);
  });

  it("falls back to `unknown-session` when the payload has no session id", () => {
    const out = runCaptureContext({ dumpStdin: true }, Buffer.from("{}"));
    expect(out.dumped).toBe(true);
    expect(out.dumpPath!.split("/").pop()).toMatch(/unknown-session/);
  });

  it("never throws when the dump dir cannot be created", () => {
    const blocker = join(homeDir, "blocker");
    writeFileSync(blocker, "x"); // file with the name our mkdir wants → ENOTDIR
    process.env.HOME = blocker;
    try {
      const out = runCaptureContext({ dumpStdin: true }, Buffer.from("{}"));
      expect(out.dumped).toBe(false);
      expect(out.dumpPath).toBeNull();
      expect(envelope(out).systemMessage).toBeUndefined();
    } finally {
      process.env.HOME = homeDir;
    }
  });
});

// ---------------------------------------------------------------------------
// parseStdinPayload — tolerant
// ---------------------------------------------------------------------------

describe("parseStdinPayload — collapses every error to {}", () => {
  it("returns {} for empty / malformed / primitive / over-size", () => {
    expect(parseStdinPayload("")).toEqual({});
    expect(parseStdinPayload(Buffer.alloc(0))).toEqual({});
    expect(parseStdinPayload("{not valid")).toEqual({});
    expect(parseStdinPayload("null")).toEqual({});
    expect(parseStdinPayload("42")).toEqual({});
    expect(parseStdinPayload("[1,2]")).toEqual({});
    const oversize = '{"x":"' + "y".repeat(300_000) + '"}';
    expect(parseStdinPayload(oversize)).toEqual({});
  });

  it("preserves unknown fields", () => {
    const parsed = parseStdinPayload(
      JSON.stringify({
        session_id: "s",
        future_field: "still here",
        nested: { a: 1 },
      }),
    ) as Record<string, unknown>;
    expect(parsed.future_field).toBe("still here");
    expect(parsed.nested).toEqual({ a: 1 });
  });
});

// ---------------------------------------------------------------------------
// sessionScope — regression for the project.session.<sha> hierarchy
// ---------------------------------------------------------------------------

describe("sessionScope — hierarchical scope key", () => {
  it("returns project.session.<12-hex-char-sha>", () => {
    const s = sessionScope("any-session-id-string");
    expect(s).toMatch(/^project\.session\.[0-9a-f]{12}$/);
  });

  it("is deterministic for the same input", () => {
    expect(sessionScope("sess-1")).toBe(sessionScope("sess-1"));
  });

  it("different sessions hash to different leaves", () => {
    expect(sessionScope("sess-A")).not.toBe(sessionScope("sess-B"));
  });
});

// Quiet helpers that vitest may not reach but typescript still needs.
void mkdirSync;
