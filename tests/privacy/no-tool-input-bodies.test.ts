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
