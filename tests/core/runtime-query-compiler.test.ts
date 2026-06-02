/**
 * Phase D.1 — RuntimeQueryCompiler (two-view) contract + deterministic default.
 *
 * Verifies the structural symbol/prose split, privacy scrubbing BEFORE
 * classification, length bounding, the causal-omitted-when-thin rule, and pure
 * determinism. No keyword lists, no chain-of-thought, no raw-prompt persistence.
 */
import { describe, it, expect } from "vitest";
import {
  StructuredQueryCompiler,
  isSymbolToken,
  MAX_VIEW_CHARS,
  MIN_CAUSAL_TOKENS,
} from "../../src/core/runtime-query-compiler.js";

const compiler = new StructuredQueryCompiler();

describe("isSymbolToken (structural, no keyword list)", () => {
  it("classifies code identifiers / paths / typed errors as symbols", () => {
    for (const s of ["foo.bar", "src/api/handler.ts", "snake_case", "camelCase", "TypeError", "ECONNRESET", "v2", "handleRequest()"]) {
      expect(isSymbolToken(s)).toBe(true);
    }
  });
  it("classifies natural-language words as prose", () => {
    for (const w of ["undefined", "rounding", "dereferenced", "stale", "deadlock", "because", "absent"]) {
      expect(isSymbolToken(w)).toBe(false);
    }
  });
});

describe("StructuredQueryCompiler", () => {
  it("routes symbols to the literal view and mechanism prose to the causal view", () => {
    const c = compiler.compile(
      "TypeError: Cannot read property foo of undefined at Service.handleRequest in src/api/handler.ts because the optional was absent",
    );
    // Literal view carries the symbol-shaped tokens.
    expect(c.literal.text).toMatch(/TypeError/);
    expect(c.literal.text).toMatch(/src\/api\/handler\.ts/);
    // Causal view carries mechanism prose, NOT the symbols.
    expect(c.causal).toBeDefined();
    expect(c.causal!.text).toMatch(/undefined/);
    expect(c.causal!.text).toMatch(/absent/);
    expect(c.causal!.text).not.toMatch(/handler\.ts/);
    expect(c.causal!.text).not.toMatch(/TypeError/);
    expect(c.provenance.hasCausal).toBe(true);
    expect(c.provenance.symbolTokenCount).toBeGreaterThan(0);
  });

  it("scrubs leakage/secrets BEFORE classification (never in a view or its hash)", () => {
    const c = compiler.compile(
      "auth fails at /Users/alice/svc/main.ts when Bearer abcdef0123456789ABCDEF is rejected and key sk-ant-0123456789abcdefghij leaks",
    );
    const all = JSON.stringify(c);
    expect(all).not.toContain("/Users/");
    expect(all).not.toContain("Bearer abcdef");
    expect(all).not.toContain("sk-ant-0123");
  });

  it("omits the causal view when there is too little mechanism prose", () => {
    const c = compiler.compile("TypeError foo.bar src/api/handler.ts v2 ECONNRESET");
    expect(c.provenance.hasCausal).toBe(false);
    expect(c.causal).toBeUndefined();
    // A pure-symbol query still yields a usable literal view.
    expect(c.literal.informativeTokenCount).toBeGreaterThan(0);
  });

  it("a symptom-only (no symbol) query yields a causal view and a non-empty literal fallback", () => {
    const text = "after I save my settings the page still shows the old values until it eventually refreshes";
    const c = compiler.compile(text);
    expect(c.provenance.symbolTokenCount).toBe(0);
    expect(c.causal).toBeDefined();
    expect(c.causal!.informativeTokenCount).toBeGreaterThanOrEqual(MIN_CAUSAL_TOKENS);
    // Literal falls back to the full scrubbed text (never empty) so the sparse
    // lane keeps a genuinely-literal query.
    expect(c.literal.text.length).toBeGreaterThan(0);
  });

  it("bounds every view to MAX_VIEW_CHARS", () => {
    // Many DISTINCT prose words (the tokenizer dedupes) + many symbol tokens, so
    // both views exceed the cap before bounding.
    const prose = "absent optional dereferenced undefined propagates null guard mishandled crashes downstream serializer caller boundary unchecked nullable coalesce default fallback sentinel ".repeat(4);
    const syms = "a.b c/d/e f_g hJ Kx Lm.n o.p.q r/s t.u v.w x.y z.a ".repeat(8);
    const c = compiler.compile(`${prose} ${syms}`);
    expect(c.literal.text.length).toBeLessThanOrEqual(MAX_VIEW_CHARS);
    expect(c.causal).toBeDefined();
    expect(c.causal!.text.length).toBeLessThanOrEqual(MAX_VIEW_CHARS);
  });

  it("is pure + deterministic: identical input → identical views + hashes", () => {
    const q = "two threads each hold one mutex and block forever waiting for the other at Lock.acquire()";
    const a = compiler.compile(q);
    const b = compiler.compile(q);
    expect(a).toEqual(b);
    expect(a.literal.viewHash).toBe(b.literal.viewHash);
    expect(a.causal!.viewHash).toBe(b.causal!.viewHash);
  });
});
