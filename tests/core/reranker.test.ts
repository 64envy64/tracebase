import { describe, it, expect, vi } from "vitest";
import {
  NoopReranker,
  CloudReranker,
  withRerankerFallback,
  type Reranker,
  type RerankerCandidate,
} from "../../src/core/reranker.js";

const cand = (id: string, text: string): RerankerCandidate => ({ blockId: id, triggerText: text });

describe("NoopReranker", () => {
  it("returns equal scores for every candidate", async () => {
    const r = new NoopReranker();
    const scores = await r.score("query", [cand("a", "x"), cand("b", "y")]);
    expect(scores).toEqual([0.5, 0.5]);
  });

  it("handles an empty candidate list", async () => {
    const r = new NoopReranker();
    const scores = await r.score("query", []);
    expect(scores).toEqual([]);
  });
});

describe("CloudReranker", () => {
  it("POSTs to the endpoint and parses the response", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ scores: [0.9, 0.1, 0.5] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const r = new CloudReranker({
      endpoint: "https://example.test/rerank",
      apiKey: "secret-token",
      model: "test-model",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const scores = await r.score("q", [cand("a", "x"), cand("b", "y"), cand("c", "z")]);
    expect(scores).toEqual([0.9, 0.1, 0.5]);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const call = fetchImpl.mock.calls[0]!;
    expect(call[0]).toBe("https://example.test/rerank");
    const init = call[1] as RequestInit;
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer secret-token");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(init.body as string) as { query: string; candidates: string[]; model?: string };
    expect(body.query).toBe("q");
    expect(body.candidates).toEqual(["x", "y", "z"]);
    expect(body.model).toBe("test-model");
  });

  it("clamps response scores into [0, 1]", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ scores: [1.5, -0.5, 0.5] }), { status: 200 }),
    );
    const r = new CloudReranker({
      endpoint: "https://example.test/rerank",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const scores = await r.score("q", [cand("a", "x"), cand("b", "y"), cand("c", "z")]);
    expect(scores).toEqual([1, 0, 0.5]);
  });

  it("returns null when fetch rejects (network error)", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    const r = new CloudReranker({
      endpoint: "https://example.test/rerank",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const scores = await r.score("q", [cand("a", "x")]);
    expect(scores).toBeNull();
  });

  it("returns null on non-200 status", async () => {
    const fetchImpl = vi.fn(async () => new Response("rate limited", { status: 429 }));
    const r = new CloudReranker({
      endpoint: "https://example.test/rerank",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const scores = await r.score("q", [cand("a", "x")]);
    expect(scores).toBeNull();
  });

  it("returns null when response is not JSON", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("not json", { status: 200 }),
    );
    const r = new CloudReranker({
      endpoint: "https://example.test/rerank",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const scores = await r.score("q", [cand("a", "x")]);
    expect(scores).toBeNull();
  });

  it("returns null when response length mismatches input", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ scores: [0.5] }), { status: 200 }),
    );
    const r = new CloudReranker({
      endpoint: "https://example.test/rerank",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const scores = await r.score("q", [cand("a", "x"), cand("b", "y")]);
    expect(scores).toBeNull();
  });

  it("returns null when a score is NaN or non-numeric", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ scores: [0.5, "high"] }), { status: 200 }),
    );
    const r = new CloudReranker({
      endpoint: "https://example.test/rerank",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const scores = await r.score("q", [cand("a", "x"), cand("b", "y")]);
    expect(scores).toBeNull();
  });
});

describe("withRerankerFallback", () => {
  it("reorders by score (DESC) on success", async () => {
    const reranker: Reranker = {
      name: "test",
      async score() { return [0.2, 0.9, 0.5]; },
    };
    const items = [cand("a", "x"), cand("b", "y"), cand("c", "z")];
    const { reranked, fellBack } = await withRerankerFallback(reranker, "q", items);
    expect(fellBack).toBe(false);
    expect(reranked.map((r) => r.blockId)).toEqual(["b", "c", "a"]);
  });

  it("preserves input order as the stable tie-break for equal scores", async () => {
    const reranker: Reranker = {
      name: "test",
      async score() { return [0.5, 0.5, 0.5]; },
    };
    const items = [cand("first", "1"), cand("second", "2"), cand("third", "3")];
    const { reranked } = await withRerankerFallback(reranker, "q", items);
    expect(reranked.map((r) => r.blockId)).toEqual(["first", "second", "third"]);
  });

  it("falls back gracefully when the reranker times out", async () => {
    const reranker: Reranker = {
      name: "slow",
      async score() {
        await new Promise((r) => setTimeout(r, 200));
        return [0.9, 0.1];
      },
    };
    const items = [cand("a", "x"), cand("b", "y")];
    const fallbackReasons: string[] = [];
    const { reranked, fellBack, reason } = await withRerankerFallback(reranker, "q", items, {
      timeoutMs: 50,
      onFallback: (r) => fallbackReasons.push(r),
    });
    expect(fellBack).toBe(true);
    expect(reason).toBe("timeout");
    // Falls back to original order — no reorder happened.
    expect(reranked.map((r) => r.blockId)).toEqual(["a", "b"]);
    expect(fallbackReasons).toEqual(["timeout"]);
  });

  it("falls back when the reranker returns null", async () => {
    const reranker: Reranker = {
      name: "broken",
      async score() { return null; },
    };
    const items = [cand("a", "x"), cand("b", "y")];
    const { reranked, fellBack, reason } = await withRerankerFallback(reranker, "q", items);
    expect(fellBack).toBe(true);
    expect(reason).toBe("null");
    expect(reranked.map((r) => r.blockId)).toEqual(["a", "b"]);
  });

  it("falls back when the reranker throws (graceful, never propagates)", async () => {
    const reranker: Reranker = {
      name: "throws",
      async score() { throw new Error("model crashed"); },
    };
    const items = [cand("a", "x"), cand("b", "y")];
    const { reranked, fellBack, reason } = await withRerankerFallback(reranker, "q", items);
    expect(fellBack).toBe(true);
    expect(reason).toBe("error");
    expect(reranked.map((r) => r.blockId)).toEqual(["a", "b"]);
  });

  it("falls back when output length mismatches input", async () => {
    const reranker: Reranker = {
      name: "buggy",
      async score() { return [0.5]; },
    };
    const items = [cand("a", "x"), cand("b", "y")];
    const { reranked, fellBack, reason } = await withRerankerFallback(reranker, "q", items);
    expect(fellBack).toBe(true);
    expect(reason).toBe("empty");
    expect(reranked.map((r) => r.blockId)).toEqual(["a", "b"]);
  });

  it("returns the empty array unchanged when no candidates given", async () => {
    const reranker = new NoopReranker();
    const { reranked, fellBack } = await withRerankerFallback(reranker, "q", []);
    expect(reranked).toEqual([]);
    expect(fellBack).toBe(false);
  });
});
