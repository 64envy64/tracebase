/**
 * `src/runtime/observe-tools.ts` — direct coverage of the pure
 * tool-observation core extracted from `capture-tool-use` in
 * PLAN-0.5.4 §8.3.
 *
 * The CLI hook tests in `tests/cli/capture-tool-use.test.ts`
 * already exercise this code through the PostToolBatch envelope.
 * These tests pin the function's contract directly, since the SDK
 * runtime (§8.6) will call it without going through the CLI envelope.
 */
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import {
  observeToolBatch,
  MAX_CALLS_PER_BATCH,
  type ObserveToolBatchCall,
} from "../../src/runtime/observe-tools.js";

const SALT = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const CWD = "/work/repo";

function freshStore(): { store: BlockStore; close: () => void } {
  const db = new Database(":memory:");
  const store = new BlockStore(db);
  return { store, close: () => store.close() };
}

describe("observeToolBatch — happy path", () => {
  it("persists one row per call and returns ids in input order", () => {
    const { store, close } = freshStore();
    try {
      const out = observeToolBatch(store, {
        sessionId: "s1",
        cwd: CWD,
        workspaceSalt: SALT,
        toolCalls: [
          { toolName: "Read", toolInput: { file_path: "/work/repo/src/foo.ts" } },
          { toolName: "Bash", toolInput: { command: "npm run build && cat /etc/passwd" } },
        ],
      });
      expect(out.recorded).toBe(2);
      expect(out.ids).toHaveLength(2);
      expect(out.truncated).toBe(false);

      const rows = store.recentToolObservations("s1", 10);
      expect(rows.map((r) => r.argSummary)).toEqual([
        "Read(src/foo.ts)",
        "Bash(npm)",
      ]);
      // Critical: Bash arguments NEVER reach storage.
      const all = rows.map((r) => `${r.argSummary}|${r.argKey}`).join("|");
      expect(all).not.toContain("/etc/passwd");
      expect(all).not.toContain("npm run build");
    } finally {
      close();
    }
  });

  it("default outcome is `unknown` (live PostToolBatch lacks an outcome field)", () => {
    const { store, close } = freshStore();
    try {
      observeToolBatch(store, {
        sessionId: "s2",
        cwd: CWD,
        workspaceSalt: SALT,
        toolCalls: [
          { toolName: "Read", toolInput: { file_path: "/work/repo/x.ts" } },
        ],
      });
      const rows = store.recentToolObservations("s2", 1);
      expect(rows[0]?.outcome).toBe("unknown");
    } finally {
      close();
    }
  });
});

describe("observeToolBatch — guards", () => {
  it("empty input is a no-op", () => {
    const { store, close } = freshStore();
    try {
      const out = observeToolBatch(store, {
        sessionId: "s-empty",
        cwd: CWD,
        workspaceSalt: SALT,
        toolCalls: [],
      });
      expect(out).toEqual({ recorded: 0, ids: [], truncated: false });
      expect(store.countToolObservations("s-empty")).toBe(0);
    } finally {
      close();
    }
  });

  it(`truncates batches above MAX_CALLS_PER_BATCH (=${MAX_CALLS_PER_BATCH}) and reports it`, () => {
    const { store, close } = freshStore();
    try {
      const calls: ObserveToolBatchCall[] = Array.from({ length: 200 }, (_, i) => ({
        toolName: "Read",
        toolInput: { file_path: `/work/repo/f${i}.ts` },
      }));
      const out = observeToolBatch(store, {
        sessionId: "s-flood",
        cwd: CWD,
        workspaceSalt: SALT,
        toolCalls: calls,
      });
      expect(out.recorded).toBe(MAX_CALLS_PER_BATCH);
      expect(out.truncated).toBe(true);
      expect(store.countToolObservations("s-flood")).toBe(MAX_CALLS_PER_BATCH);
    } finally {
      close();
    }
  });
});

describe("observeToolBatch — privacy hard guards", () => {
  it("Edit / Write / TodoWrite collapse to <name>(arg-hidden); bodies never stored", () => {
    const { store, close } = freshStore();
    try {
      observeToolBatch(store, {
        sessionId: "s-hidden",
        cwd: CWD,
        workspaceSalt: SALT,
        toolCalls: [
          { toolName: "Edit", toolInput: { old_string: "secret-content", new_string: "x" } },
          { toolName: "Write", toolInput: { content: "another secret" } },
          { toolName: "TodoWrite", toolInput: { todos: [{ content: "x" }] } },
        ],
      });
      const rows = store.recentToolObservations("s-hidden", 10);
      expect(rows.map((r) => r.argSummary)).toEqual([
        "Edit(arg-hidden)",
        "Write(arg-hidden)",
        "TodoWrite(arg-hidden)",
      ]);
      const all = rows.map((r) => r.argSummary).join("|");
      expect(all).not.toContain("secret-content");
      expect(all).not.toContain("another secret");
    } finally {
      close();
    }
  });

  it("paths outside cwd never become repo-relative; collapse to arg-hidden", () => {
    const { store, close } = freshStore();
    try {
      observeToolBatch(store, {
        sessionId: "s-escape",
        cwd: CWD,
        workspaceSalt: SALT,
        toolCalls: [
          { toolName: "Read", toolInput: { file_path: "/etc/passwd" } },
          { toolName: "Read", toolInput: { file_path: "/Users/alice/.aws/credentials" } },
        ],
      });
      const rows = store.recentToolObservations("s-escape", 10);
      expect(rows.map((r) => r.argSummary)).toEqual([
        "Read(arg-hidden)",
        "Read(arg-hidden)",
      ]);
      const all = rows.map((r) => r.argSummary).join("|");
      expect(all).not.toContain("/etc");
      expect(all).not.toContain("/Users/alice");
    } finally {
      close();
    }
  });
});

describe("observeToolBatch — bucketing determinism", () => {
  it("same workspace + same projection → same arg_key (loop detector substrate)", () => {
    const { store, close } = freshStore();
    try {
      observeToolBatch(store, {
        sessionId: "s-det",
        cwd: CWD,
        workspaceSalt: SALT,
        toolCalls: [
          { toolName: "Read", toolInput: { file_path: "/work/repo/src/a.ts" } },
          { toolName: "Read", toolInput: { file_path: "/work/repo/src/a.ts" } },
          { toolName: "Read", toolInput: { file_path: "/work/repo/src/a.ts" } },
        ],
      });
      const rows = store.recentToolObservations("s-det", 10);
      const keys = new Set(rows.map((r) => r.argKey));
      expect(keys.size).toBe(1);
    } finally {
      close();
    }
  });
});
