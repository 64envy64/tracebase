/**
 * Guards for every write path into the local store (§4 PLAN-0.5).
 * Coverage: bounded fields, repo-relative path rejection, and the
 * extended leakage patterns that complement the existing gold-truth
 * scanner in `src/core/block.ts`.
 */
import { describe, it, expect } from "vitest";
import {
  boundField,
  detectLeakageExtended,
  isRepoRelative,
  toRepoRelative,
} from "../../src/core/guard.js";

describe("boundField", () => {
  it("trims and returns short input unchanged", () => {
    const r = boundField("  hello  ", 100, "test");
    expect(r.value).toBe("hello");
    expect(r.truncated).toBe(false);
  });

  it("clamps to max + flags truncation", () => {
    const r = boundField("x".repeat(500), 100, "test");
    expect(r.value.length).toBe(100);
    expect(r.truncated).toBe(true);
  });

  it("returns empty for non-string / empty input", () => {
    expect(boundField(undefined, 100, "test").value).toBe("");
    expect(boundField(null, 100, "test").value).toBe("");
    expect(boundField(42, 100, "test").value).toBe("");
    expect(boundField("", 100, "test").value).toBe("");
    expect(boundField("   ", 100, "test").value).toBe("");
  });
});

describe("isRepoRelative", () => {
  it("accepts clean repo-relative paths", () => {
    expect(isRepoRelative("src/foo.ts")).toBe(true);
    expect(isRepoRelative("tests/cli/*.test.ts")).toBe(true);
    expect(isRepoRelative("package.json")).toBe(true);
    expect(isRepoRelative("./src/foo.ts")).toBe(true);
  });

  it("rejects absolute POSIX paths", () => {
    expect(isRepoRelative("/Users/foo/project/src/a.ts")).toBe(false);
    expect(isRepoRelative("/etc/passwd")).toBe(false);
    expect(isRepoRelative("/tmp/scratch")).toBe(false);
  });

  it("rejects home-directory hints", () => {
    expect(isRepoRelative("~/project/a.ts")).toBe(false);
  });

  it("rejects Windows drive paths", () => {
    expect(isRepoRelative("C:\\Users\\foo\\a.ts")).toBe(false);
    expect(isRepoRelative("D:/project/a.ts")).toBe(false);
  });

  it("rejects escaping `..`", () => {
    expect(isRepoRelative("../outside.ts")).toBe(false);
    expect(isRepoRelative("../../etc/passwd")).toBe(false);
  });

  it("rejects empty / over-long / non-string input", () => {
    expect(isRepoRelative("")).toBe(false);
    expect(isRepoRelative("  ")).toBe(false);
    expect(isRepoRelative("x".repeat(300))).toBe(false);
    expect(isRepoRelative(undefined as unknown as string)).toBe(false);
  });
});

describe("toRepoRelative", () => {
  it("returns the relative form for a path inside basePath", () => {
    expect(toRepoRelative("/work/project/src/a.ts", "/work/project")).toBe("src/a.ts");
  });

  it("returns null for a path outside basePath", () => {
    expect(toRepoRelative("/etc/passwd", "/work/project")).toBeNull();
  });

  it("keeps already-relative paths when valid", () => {
    expect(toRepoRelative("src/a.ts", "/work/project")).toBe("src/a.ts");
  });

  it("rejects home-dir and drive-letter inputs", () => {
    expect(toRepoRelative("~/a.ts", "/work/project")).toBeNull();
    expect(toRepoRelative("C:\\a.ts", "/work/project")).toBeNull();
  });

  it("rejects empty / non-string", () => {
    expect(toRepoRelative("", "/work/project")).toBeNull();
    expect(toRepoRelative("   ", "/work/project")).toBeNull();
  });
});

describe("detectLeakageExtended", () => {
  it("returns null for clean prose", () => {
    expect(detectLeakageExtended("pytest is collecting the wrong package")).toBeNull();
    expect(detectLeakageExtended("run `npm run build` to compile")).toBeNull();
    expect(detectLeakageExtended("")).toBeNull();
  });

  it("flags absolute POSIX paths", () => {
    expect(detectLeakageExtended("see /Users/me/project/src/a.ts")).toBe("abs-path-posix");
    expect(detectLeakageExtended("in /etc/passwd")).toBe("abs-path-posix");
    expect(detectLeakageExtended("cat /tmp/scratch.log")).toBe("abs-path-posix");
  });

  it("flags Windows absolute paths", () => {
    expect(detectLeakageExtended("see C:\\Users\\me\\a.ts")).toBe("abs-path-windows");
  });

  it("flags bearer tokens", () => {
    expect(detectLeakageExtended("Authorization: Bearer abcd1234efgh5678ijkl")).toBe("bearer-token");
  });

  it("flags API keys", () => {
    expect(detectLeakageExtended("key: sk-abcdef0123456789abcdef0123")).toBe("api-key-sk");
    expect(detectLeakageExtended("sk-ant-abcdef0123456789abcdef0123abcdef0123")).toBe("api-key-anthropic");
    expect(detectLeakageExtended("ghp_abcdef0123456789abcdef0123456789ab")).toBe("api-key-github");
  });

  it("flags .env-line shapes", () => {
    expect(detectLeakageExtended("AWS_SECRET_ACCESS_KEY=abcdefghij1234")).toBe("env-line");
    expect(detectLeakageExtended("DATABASE_URL=postgres://user:pass@host/db")).toBe("env-line");
  });

  it("does not flag normal ALLCAPS prose with `=`", () => {
    // `X = 1` prose shouldn't trigger; the pattern requires no space
    // around `=` AND a longer value.
    expect(detectLeakageExtended("X = 1")).toBeNull();
    expect(detectLeakageExtended("const FOO = 42")).toBeNull();
  });
});
