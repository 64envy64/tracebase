/**
 * `src/core/tool-arg.ts` — per-tool sanitizer.
 *
 * Three concerns this test pins down:
 *   1. The HMAC arg_key is deterministic for the same projected
 *      input within a workspace, and divergent across workspaces.
 *      Loop detection in inject-context relies on this — without
 *      determinism the bucket counts collapse to noise.
 *   2. Each known tool's projection only reads the listed fields
 *      and never copies anything else. New tools land at
 *      `arg-hidden` until an explicit projection is added.
 *   3. Leakage patterns surfaced through any of the projections
 *      (a Bash command that smuggles a secret token; a Read of a
 *      file inside `~/.aws`) downgrade to `arg-hidden` rather than
 *      letting the literal land in storage.
 */
import { describe, expect, it } from "vitest";
import { computeArgKey, sanitizeToolArgs } from "../../src/core/tool-arg.js";

const SALT_A = "a".repeat(64);
const SALT_B = "b".repeat(64);
const CWD = "/work/repo";

describe("sanitizeToolArgs — Read", () => {
  it("normalises absolute paths inside cwd to repo-relative form", () => {
    const out = sanitizeToolArgs({
      toolName: "Read",
      toolInput: { file_path: "/work/repo/src/foo.ts" },
      cwd: CWD,
      workspaceSalt: SALT_A,
    });
    expect(out.argSummary).toBe("Read(src/foo.ts)");
    expect(out.argKey).toMatch(/^[0-9a-f]{16}$/);
  });

  it("collapses paths outside cwd to arg-hidden — never stores absolute prefixes", () => {
    const out = sanitizeToolArgs({
      toolName: "Read",
      toolInput: { file_path: "/etc/passwd" },
      cwd: CWD,
      workspaceSalt: SALT_A,
    });
    expect(out.argSummary).toBe("Read(arg-hidden)");
  });

  it("collapses missing / non-string file_path to arg-hidden", () => {
    const out = sanitizeToolArgs({
      toolName: "Read",
      toolInput: { file_path: null },
      cwd: CWD,
      workspaceSalt: SALT_A,
    });
    expect(out.argSummary).toBe("Read(arg-hidden)");
  });
});

describe("sanitizeToolArgs — Grep / Glob", () => {
  it("clips long Grep patterns, normalises path", () => {
    const long = "x".repeat(200);
    const out = sanitizeToolArgs({
      toolName: "Grep",
      toolInput: { pattern: long, path: "/work/repo/src" },
      cwd: CWD,
      workspaceSalt: SALT_A,
    });
    // 80-char clip + bracketed path.
    expect(out.argSummary).toBe(`Grep("${"x".repeat(80)}")[src]`);
  });

  it("rejects Grep pattern that itself looks like a secret", () => {
    const out = sanitizeToolArgs({
      toolName: "Grep",
      toolInput: { pattern: "Bearer abcdefghijklmnop1234" },
      cwd: CWD,
      workspaceSalt: SALT_A,
    });
    expect(out.argSummary).toBe("Grep(arg-hidden)");
  });

  it("Glob without a path emits a path-less summary", () => {
    const out = sanitizeToolArgs({
      toolName: "Glob",
      toolInput: { pattern: "**/*.ts" },
      cwd: CWD,
      workspaceSalt: SALT_A,
    });
    expect(out.argSummary).toBe('Glob("**/*.ts")');
  });
});

describe("sanitizeToolArgs — Bash", () => {
  it("keeps only the binary name; arguments never leave the projection", () => {
    const out = sanitizeToolArgs({
      toolName: "Bash",
      toolInput: { command: "npm run build && cat /etc/passwd" },
      cwd: CWD,
      workspaceSalt: SALT_A,
    });
    expect(out.argSummary).toBe("Bash(npm)");
  });

  it("strips ./ and / prefixes to bucket on the basename", () => {
    const a = sanitizeToolArgs({
      toolName: "Bash",
      toolInput: { command: "./foo --bar" },
      cwd: CWD,
      workspaceSalt: SALT_A,
    });
    const b = sanitizeToolArgs({
      toolName: "Bash",
      toolInput: { command: "node_modules/.bin/foo --bar" },
      cwd: CWD,
      workspaceSalt: SALT_A,
    });
    expect(a.argSummary).toBe("Bash(foo)");
    expect(b.argSummary).toBe("Bash(foo)");
    // Same projection → same bucket within a workspace.
    expect(a.argKey).toBe(b.argKey);
  });

  it("hidden when command is empty", () => {
    const out = sanitizeToolArgs({
      toolName: "Bash",
      toolInput: { command: "   " },
      cwd: CWD,
      workspaceSalt: SALT_A,
    });
    expect(out.argSummary).toBe("Bash(arg-hidden)");
  });
});

describe("sanitizeToolArgs — sensitive / unknown tools collapse to hidden", () => {
  it.each(["Edit", "Write", "NotebookEdit", "TodoWrite", "WebFetch", "WebSearch", "Task", "Skill", "FuturisticUnknownTool"])(
    "%s collapses to <name>(arg-hidden)",
    (tool) => {
      const out = sanitizeToolArgs({
        toolName: tool,
        toolInput: { file_path: "/work/repo/src/foo.ts", anything: "secret" },
        cwd: CWD,
        workspaceSalt: SALT_A,
      });
      expect(out.argSummary).toBe(`${tool}(arg-hidden)`);
    },
  );
});

describe("computeArgKey — determinism + cross-workspace divergence", () => {
  it("same workspace + same projection → same bucket", () => {
    const k1 = computeArgKey(SALT_A, "Read", { file_path: "src/foo.ts" });
    const k2 = computeArgKey(SALT_A, "Read", { file_path: "src/foo.ts" });
    expect(k1).toBe(k2);
  });

  it("key order in the projection object is canonicalised — not part of the bucket id", () => {
    const k1 = computeArgKey(SALT_A, "Grep", { pattern: "x", path: "src" });
    const k2 = computeArgKey(SALT_A, "Grep", { path: "src", pattern: "x" });
    expect(k1).toBe(k2);
  });

  it("different workspace salts produce different bucket ids for the same projection", () => {
    const a = computeArgKey(SALT_A, "Read", { file_path: "src/foo.ts" });
    const b = computeArgKey(SALT_B, "Read", { file_path: "src/foo.ts" });
    expect(a).not.toBe(b);
  });

  it("different tools can never collide on an empty projection", () => {
    // The canonical form prefixes the tool name, so {} from Read
    // and {} from Write hash to different buckets.
    const a = computeArgKey(SALT_A, "Read", { hidden: true });
    const b = computeArgKey(SALT_A, "Write", { hidden: true });
    expect(a).not.toBe(b);
  });
});

describe("sanitizeToolArgs — defensive parsing", () => {
  it("collapses non-object tool_input to hidden", () => {
    const out = sanitizeToolArgs({
      toolName: "Read",
      toolInput: "string-not-object",
      cwd: CWD,
      workspaceSalt: SALT_A,
    });
    expect(out.argSummary).toBe("Read(arg-hidden)");
  });

  it("collapses empty toolName to Unknown(arg-hidden)", () => {
    const out = sanitizeToolArgs({
      toolName: "",
      toolInput: { anything: 1 },
      cwd: CWD,
      workspaceSalt: SALT_A,
    });
    expect(out.argSummary).toBe("Unknown(arg-hidden)");
  });
});
