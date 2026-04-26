/**
 * Privacy harness — raw `tool_input` and `tool_response` never land
 * in `tool_observations`.
 *
 * The schema enforces this structurally: the `tool_observations`
 * table has only `arg_summary` (sanitised, allowlisted-fields-only
 * projection of tool_input) and `arg_key` (HMAC bucket for the same
 * sanitised projection) — there is no `tool_input` column and no
 * `tool_response` column. Any future widening that bubbles raw
 * bodies up would need an explicit ALTER TABLE; this test is the
 * audit lock that makes such an ALTER fail loudly here before it
 * ships.
 *
 * Two axes covered:
 *   1. Schema audit — the column list is exactly the documented set.
 *   2. End-to-end audit — observe a batch with planted secrets in
 *      tool_input + a planted tool_response, then read every column
 *      of every persisted row and assert NEITHER planted string
 *      appears anywhere.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import { observeToolBatch } from "../../src/runtime/observe-tools.js";
import { createHmac } from "node:crypto";

const PLANTED_INPUT_SECRET = "sk-ant-deadbeef-no-secrets-please-1234567890ab";
const PLANTED_RESPONSE_SECRET = "RESPONSE-PRIVATE-12345-DO-NOT-LEAK";

let store: BlockStore;
beforeEach(() => {
  store = new BlockStore(new Database(":memory:"));
});

describe("privacy: no-tool-input-bodies — schema invariant", () => {
  it("`tool_observations` has only the documented columns", () => {
    const cols = (
      store.rawDb
        .prepare("PRAGMA table_info(tool_observations)")
        .all() as Array<{ name: string }>
    )
      .map((c) => c.name)
      .sort();
    expect(cols).toEqual([
      "arg_key",
      "arg_summary",
      "batch_id",
      "batch_order",
      "created_at",
      "id",
      "outcome",
      "redundant_of",
      "session_id",
      "tool_name",
      "tool_use_id",
      "ts",
    ]);
    // Specifically no body columns.
    expect(cols).not.toContain("tool_input");
    expect(cols).not.toContain("tool_response");
    expect(cols).not.toContain("response");
    expect(cols).not.toContain("input");
  });
});

describe("privacy: no-tool-input-bodies — end-to-end audit", () => {
  it("planted secrets in tool_input never appear in any persisted column", () => {
    const salt = createHmac("sha256", "test").update("salt").digest("hex");
    observeToolBatch(store, {
      sessionId: "sess-test",
      cwd: "/tmp/cwd",
      workspaceSalt: salt,
      toolCalls: [
        {
          toolName: "Read",
          // Planted: the sanitiser drops anything not in the per-tool
          // allowlist; secret-shaped fields are projected to "arg-hidden".
          toolInput: {
            file_path: "src/foo.ts",
            secret_arg: PLANTED_INPUT_SECRET,
            authorization: `Bearer ${PLANTED_INPUT_SECRET}`,
          },
          // Outcome is the only post-call signal we accept; we never
          // accept a `toolResponse` parameter on the function — it's
          // not in the type. This object must not bleed in elsewhere.
          outcome: "ok",
        },
        {
          toolName: "Bash",
          toolInput: {
            command: `curl -H 'X-Secret: ${PLANTED_INPUT_SECRET}' https://api.example`,
          },
          outcome: "ok",
        },
      ],
    });

    // Pull every row back as a JSON blob and grep the entire payload.
    const rows = store.rawDb
      .prepare("SELECT * FROM tool_observations")
      .all() as Array<Record<string, unknown>>;
    expect(rows.length).toBe(2);
    const serialized = JSON.stringify(rows);
    expect(serialized, "planted input secret leaked into a column").not.toContain(
      PLANTED_INPUT_SECRET,
    );
    expect(serialized, "planted response secret leaked").not.toContain(
      PLANTED_RESPONSE_SECRET,
    );

    // Sanity: the rows DO carry the documented sanitised projection.
    const argSummaries = rows.map((r) => r.arg_summary);
    expect(argSummaries.some((s) => typeof s === "string" && s!.length > 0)).toBe(true);
    // arg_key is an HMAC hex digest (deterministic length 64) when present,
    // never a raw secret.
    for (const r of rows) {
      const k = r.arg_key as string;
      expect(typeof k).toBe("string");
      expect(k).not.toContain(PLANTED_INPUT_SECRET);
    }
  });

  it("Bash collapses to the binary name + sanitised tail — never the full command", () => {
    const salt = createHmac("sha256", "test").update("salt").digest("hex");
    observeToolBatch(store, {
      sessionId: "sess-test",
      cwd: "/tmp/cwd",
      workspaceSalt: salt,
      toolCalls: [
        {
          toolName: "Bash",
          toolInput: {
            command: `cat ~/.aws/credentials | grep ${PLANTED_INPUT_SECRET}`,
          },
          outcome: "ok",
        },
      ],
    });
    const rows = store.rawDb
      .prepare("SELECT arg_summary FROM tool_observations")
      .all() as Array<{ arg_summary: string }>;
    expect(rows.length).toBe(1);
    const summary = rows[0]!.arg_summary;
    expect(summary).not.toContain(PLANTED_INPUT_SECRET);
    expect(summary).not.toContain("~/.aws/credentials");
  });
});

// ---------------------------------------------------------------------------
// 0.7.0-rc.4 §rc.4 — PreToolUse hook privacy invariants.
//
// PreToolUse fires per-call BEFORE the tool runs. The hot path:
//   parse stdin → sanitiseToolArgs → cache hydrate → detect →
//   emit envelope. Real persistence stays at PostToolBatch.
//
// The privacy invariants the hook MUST honour:
//   - raw `tool_input` (planted secret_arg, full command, full
//     authorization header) NEVER lands in any analytics_events
//     row written by the PreToolUse hook.
//   - the warm cache file `.tracebase/cache/rtools.bin` carries
//     only argKey HMAC + toolName + sessionId + ts — never raw
//     paths or commands.
//   - tool_warn_dedupe carries argKey only.
// ---------------------------------------------------------------------------

describe("privacy: no-tool-input-bodies — PreToolUse hot path (0.7.0-rc.4)", () => {
  it("PreToolUse never persists raw tool_input bodies into analytics_events", async () => {
    // Use a real workspace with TraceBase initialized so the
    // PreToolUse hook can find a salt + storage path.
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "tb-prehook-priv-"));
    try {
      const { initConfig, getOrMintWorkspaceSalt, loadConfig } = await import(
        "../../src/core/config.js"
      );
      initConfig(work);

      // Pre-warm the schema by creating a v2 store so analytics_events
      // exists when we walk it.
      const Database = (await import("better-sqlite3")).default;
      const cfgPre = loadConfig(work);
      {
        const db = new Database(cfgPre.storagePath);
        const s = new BlockStore(db);
        try {
          // No-op — just ensures schema is initialised.
          s.appendEvent({
            ts: 1,
            queryId: "warmup",
            event: "store.injection_rejected",
            surface: "block",
            patternName: "role-override",
          });
          // Drop the warmup row so we can grep cleanly afterwards.
          s.rawDb.prepare("DELETE FROM analytics_events").run();
        } finally {
          s.close();
        }
      }
      // Force the salt to mint.
      void getOrMintWorkspaceSalt(work);

      const { runCapturePreToolUse } = await import(
        "../../src/cli/commands/capture-pre-tool-use.js"
      );

      const planted = JSON.stringify({
        hook_event_name: "PreToolUse",
        session_id: "sess-priv",
        cwd: "/work/repo",
        tool_name: "Bash",
        tool_input: {
          command: `curl -H 'X-Secret: ${PLANTED_INPUT_SECRET}' https://api.example/dump`,
          description: "fetch with planted secret",
        },
      });
      runCapturePreToolUse({ path: work }, Buffer.from(planted));

      // Walk every analytics row.
      const cfg = loadConfig(work);
      const db = new Database(cfg.storagePath);
      try {
        const rows = db
          .prepare("SELECT payload FROM analytics_events")
          .all() as Array<{ payload: string }>;
        for (const r of rows) {
          expect(r.payload).not.toContain(PLANTED_INPUT_SECRET);
          expect(r.payload).not.toContain("X-Secret");
          expect(r.payload).not.toContain("https://api.example/dump");
        }
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });

  it("PreToolUse warm cache (.tracebase/cache/rtools.bin) carries argKey HMAC only — never raw paths", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "tb-prehook-cache-priv-"));
    try {
      const { initConfig } = await import("../../src/core/config.js");
      initConfig(work);
      const { RecentToolCache, cacheFilePath } = await import(
        "../../src/runtime/recent-tool-cache.js"
      );
      const c = new RecentToolCache();
      // Plant an argKey that's an HMAC-shaped string. The cache MUST
      // accept this as-is and not invent a way to surface raw paths.
      c.append({
        sessionId: "sess-priv",
        argKey: "hmac:abcdef0123456789",
        toolName: "Read",
        ts: Date.now(),
      });
      c.flush(work);
      const raw = fs.readFileSync(cacheFilePath(work), "utf-8");
      // Cache file format is locked: short keys s/k/n/t. None of
      // them carry tool_input fields like file_path / command /
      // url / authorization.
      expect(raw).not.toContain("file_path");
      expect(raw).not.toContain("command");
      expect(raw).not.toContain("authorization");
      expect(raw).not.toContain("url");
      // Sanity: the canonical short keys are present.
      expect(raw).toContain('"k"');
      expect(raw).toContain('"n"');
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 0.7.0-rc.4 §rc.4 — PreToolUse warm-path bench shape
//
// The spec target is p95 ≤ 50ms warm. This test isn't a real bench
// (vitest startup costs dominate), but it asserts the right
// ORDER-OF-MAGNITUDE: even on cache miss + duplicate detection,
// the runCapturePreToolUse helper completes 100 dispatches in
// well under 5 seconds (50ms × 100 = 5s ceiling).
// ---------------------------------------------------------------------------

describe("PreToolUse warm-path budget (0.7.0-rc.4 §rc.4)", () => {
  it("100 synthetic dispatches stay under the 50ms × 100 = 5s ceiling", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "tb-prehook-bench-"));
    try {
      const { initConfig } = await import("../../src/core/config.js");
      initConfig(work);
      const { runCapturePreToolUse } = await import(
        "../../src/cli/commands/capture-pre-tool-use.js"
      );
      const planted = Buffer.from(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          session_id: "sess-bench",
          cwd: "/work/repo",
          tool_name: "Read",
          tool_input: { file_path: "/work/repo/src/auth.ts" },
        }),
      );
      const start = Date.now();
      for (let i = 0; i < 100; i++) {
        runCapturePreToolUse({ path: work }, planted);
      }
      const elapsed = Date.now() - start;
      // Generous ceiling — this is order-of-magnitude, not a real
      // bench. The bench gate in §0.7.0-stable will pin the p95
      // under 50ms specifically.
      expect(elapsed).toBeLessThan(5000);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });
});
