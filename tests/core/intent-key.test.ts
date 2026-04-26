/**
 * `normalizeIntentKey` (PLAN-0.7 §rc.5) — semantic-equivalence
 * collapse for tool argSummaries.
 *
 * The load-bearing test is the spec'd cross-alias collapse:
 * `grep -r "auth_token"` and `rg "auth[_-]token"` must produce
 * the same intent_key after normalisation, even though their
 * HMAC argKeys are orthogonal.
 */
import { describe, it, expect } from "vitest";
import {
  normalizeIntentKey,
  intentKeyTokens,
} from "../../src/core/intent-key.js";

describe("normalizeIntentKey — family slot prefix", () => {
  it("uses the family slot, never the literal tool name", () => {
    expect(normalizeIntentKey("Grep('auth')", "Grep")).toMatch(/^search:/);
    expect(normalizeIntentKey("rg('auth')", "ripgrep")).toMatch(/^search:/);
    expect(normalizeIntentKey("ag('auth')", "ag")).toMatch(/^search:/);
    expect(normalizeIntentKey("findstr('auth')", "findstr")).toMatch(/^search:/);
    expect(normalizeIntentKey("Read('src/foo.ts')", "Read")).toMatch(/^read:/);
    expect(normalizeIntentKey("Bash('ls')", "Bash")).toMatch(/^shell:/);
  });

  it("unknown future tool names map to 'other:' — never echo the literal name", () => {
    const k = normalizeIntentKey("FuturisticMystery('foo')", "FuturisticMystery");
    expect(k).toMatch(/^other:/);
    expect(k).not.toContain("FuturisticMystery");
  });
});

describe("normalizeIntentKey — spec'd cross-alias collapse", () => {
  it("`grep -r \"auth_token\"` and `rg \"auth[_-]token\"` collapse to the same intent_key", () => {
    // The argSummary shapes the sanitiser produces for these.
    const grepSummary = "Grep(-r 'auth_token')";
    const rgSummary = "rg('auth[_-]token')";
    const a = normalizeIntentKey(grepSummary, "Grep");
    const b = normalizeIntentKey(rgSummary, "ripgrep");
    // Both produce the same family slot AND the same lexical
    // payload after metachar strip + `[_-]` collapse.
    expect(a).toBe(b);
    // Both contain the substantive token "auth token".
    expect(a).toContain("auth token");
  });

  it("collapses additional spec'd alias variants", () => {
    const variants = [
      ["Grep('auth_token')", "Grep"],
      ["Grep(-i 'auth_token')", "Grep"],
      ["rg('auth[_-]token')", "ripgrep"],
      ["ag('auth.token')", "ag"],
      ["findstr('AUTH_TOKEN')", "findstr"],
    ] as const;
    const keys = variants.map(([s, n]) => normalizeIntentKey(s, n));
    // Every variant collapses to the same intent_key.
    expect(new Set(keys).size).toBe(1);
  });
});

describe("normalizeIntentKey — flag drop", () => {
  it.each([
    ["Grep(-r 'foo')", "Grep(foo)"],
    ["Grep(-i 'foo')", "Grep(foo)"],
    ["Grep(--hidden 'foo')", "Grep(foo)"],
    ["Grep(--include 'foo')", "Grep(foo)"],
    ["Grep(-l 'foo')", "Grep(foo)"],
    ["Grep(-n 'foo')", "Grep(foo)"],
  ])("drops `%s` and matches `%s`", (with_flag, without_flag) => {
    const a = normalizeIntentKey(with_flag, "Grep");
    const b = normalizeIntentKey(without_flag, "Grep");
    expect(a).toBe(b);
  });

  it("does NOT drop semantically-meaningful flags like -w / -x", () => {
    const a = normalizeIntentKey("Grep(-w 'foo')", "Grep");
    const b = normalizeIntentKey("Grep('foo')", "Grep");
    expect(a).not.toBe(b);
  });
});

describe("normalizeIntentKey — regex metachar strip + whitespace collapse", () => {
  it("strips * ? [ ] ( ) \\ ^ $ + | . { }", () => {
    const a = normalizeIntentKey("Grep('auth.*token')", "Grep");
    const b = normalizeIntentKey("Grep('auth token')", "Grep");
    expect(a).toBe(b);
  });

  it("collapses underscores + dashes + whitespace into a single space", () => {
    const a = normalizeIntentKey("Grep('auth_token')", "Grep");
    const b = normalizeIntentKey("Grep('auth-token')", "Grep");
    const c = normalizeIntentKey("Grep('auth   token')", "Grep");
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("strips quotes (single, double, backtick)", () => {
    const a = normalizeIntentKey("Grep('foo')", "Grep");
    const b = normalizeIntentKey('Grep("foo")', "Grep");
    const c = normalizeIntentKey("Grep(`foo`)", "Grep");
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("lowercases", () => {
    const a = normalizeIntentKey("Grep('AUTH_TOKEN')", "Grep");
    const b = normalizeIntentKey("Grep('auth_token')", "Grep");
    expect(a).toBe(b);
  });
});

describe("normalizeIntentKey — edge cases", () => {
  it("empty argSummary returns family slot only", () => {
    expect(normalizeIntentKey("", "Read")).toBe("read:");
  });

  it("undefined / non-string argSummary does not throw", () => {
    expect(() => normalizeIntentKey(undefined as unknown as string, "Read")).not.toThrow();
    expect(normalizeIntentKey(undefined as unknown as string, "Read")).toBe("read:");
  });

  it("FTS5 metachar-injected argSummary does not crash", () => {
    expect(() =>
      normalizeIntentKey('Grep(\'foo*bar:"\')', "Grep"),
    ).not.toThrow();
  });
});

describe("intentKeyTokens — content-derivation audit helper", () => {
  it("returns the lowercase token set the redirect is allowed to draw from", () => {
    const tokens = intentKeyTokens("Grep(-r 'auth_token in src')");
    // Every word that survives normalisation is in the set.
    expect(tokens.has("grep")).toBe(true);
    expect(tokens.has("auth")).toBe(true);
    expect(tokens.has("token")).toBe(true);
    expect(tokens.has("in")).toBe(true);
    expect(tokens.has("src")).toBe(true);
    // Things that DROP are not in the set.
    expect(tokens.has("'")).toBe(false);
    expect(tokens.has("AUTH_TOKEN")).toBe(false); // lowercased
  });

  it("empty input returns empty set", () => {
    expect(intentKeyTokens("").size).toBe(0);
  });
});
