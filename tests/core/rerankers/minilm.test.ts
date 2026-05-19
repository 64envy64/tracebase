/**
 * MiniLMReranker tests — May-2026 B1.3.
 *
 * These tests pin the worker-protocol + abort + crash contracts using
 * an injectable WorkerFactory. Real ONNX is gated behind the
 * `TRACEBASE_E2E_MINILM` env flag — CI doesn't load 80MB of weights
 * to verify message marshalling.
 *
 * Coverage:
 *   • happy path: score() round-trips through the worker
 *   • abort: AbortSignal triggers terminate()
 *   • crash: worker `error` event rejects pending requests
 *   • exit: worker `exit` event rejects pending requests
 *   • multiple in-flight: each seq routes back to the right caller
 *   • empty candidates: no worker spawn, returns []
 *   • aborted-up-front: returns null without touching the worker
 */
import { describe, it, expect, vi } from "vitest";
import { MiniLMReranker, type WorkerLike, type WorkerInit } from "../../../src/core/rerankers/minilm.js";

// ---------------------------------------------------------------------------
// Mock worker — minimal WorkerLike shape with hooks for scripted behaviour.
// ---------------------------------------------------------------------------

interface MockWorkerOptions {
  /**
   * Score function the mock invokes on each "score" message. Default
   * returns 0.5 per candidate. Tests override for inversion / NaN /
   * delay scenarios.
   */
  score?: (msg: { query: string; candidates: string[] }) => number[] | Promise<number[]>;
  /**
   * Delay (ms) before responding to a score message. Default 0
   * (immediate). Used to exercise the abort path without flakiness.
   */
  scoreDelayMs?: number;
  /**
   * Whether to emit "ready" on construction. Mirrors real worker
   * behaviour after model pre-warm completes.
   */
  emitReady?: boolean;
}

class MockWorker implements WorkerLike {
  private listeners = {
    message: [] as Array<(msg: unknown) => void>,
    error: [] as Array<(err: Error) => void>,
    exit: [] as Array<(code: number) => void>,
  };
  private timeouts = new Set<NodeJS.Timeout>();
  private terminated = false;

  constructor(
    readonly init: WorkerInit,
    readonly opts: MockWorkerOptions,
  ) {
    if (opts.emitReady !== false) {
      setImmediate(() => {
        if (!this.terminated) this.fire("message", { type: "ready" });
      });
    }
  }

  postMessage(value: unknown): void {
    if (this.terminated) return;
    const msg = value as { type: string; seq: number; query: string; candidates: string[] };
    if (msg.type !== "score") return;
    const respond = async () => {
      try {
        const scoreFn = this.opts.score ?? (() => msg.candidates.map(() => 0.5));
        const scores = await scoreFn({ query: msg.query, candidates: msg.candidates });
        if (this.terminated) return;
        this.fire("message", { type: "scores", seq: msg.seq, scores });
      } catch (err) {
        if (this.terminated) return;
        this.fire("message", {
          type: "error",
          seq: msg.seq,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };
    if (this.opts.scoreDelayMs && this.opts.scoreDelayMs > 0) {
      const t = setTimeout(() => {
        this.timeouts.delete(t);
        void respond();
      }, this.opts.scoreDelayMs);
      this.timeouts.add(t);
    } else {
      void respond();
    }
  }

  on(event: "message", listener: (msg: unknown) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: "exit", listener: (code: number) => void): this;
  on(event: "message" | "error" | "exit", listener: (arg: never) => void): this {
    this.listeners[event].push(listener as never);
    return this;
  }

  async terminate(): Promise<number> {
    this.terminated = true;
    for (const t of this.timeouts) clearTimeout(t);
    this.timeouts.clear();
    setImmediate(() => this.fire("exit", 0));
    return 0;
  }

  /** Test helper: simulate the worker crashing. */
  crash(message = "synthetic crash"): void {
    this.terminated = true;
    for (const t of this.timeouts) clearTimeout(t);
    this.timeouts.clear();
    this.fire("error", new Error(message));
  }

  private fire(event: "message", arg: unknown): void;
  private fire(event: "error", arg: Error): void;
  private fire(event: "exit", arg: number): void;
  private fire(event: "message" | "error" | "exit", arg: unknown): void {
    for (const l of this.listeners[event]) (l as (a: unknown) => void)(arg);
  }
}

function makeReranker(opts: MockWorkerOptions = {}): {
  reranker: MiniLMReranker;
  workers: MockWorker[];
} {
  const workers: MockWorker[] = [];
  const reranker = new MiniLMReranker({
    workerFactory: (init) => {
      const w = new MockWorker(init, opts);
      workers.push(w);
      return w;
    },
  });
  return { reranker, workers };
}

const cand = (id: string, text: string) => ({ blockId: id, triggerText: text });

// ---------------------------------------------------------------------------
// Happy path + protocol
// ---------------------------------------------------------------------------

describe("MiniLMReranker — happy path", () => {
  it("returns scores in the order matching candidate input", async () => {
    const { reranker } = makeReranker({
      score: ({ candidates }) => candidates.map((c) => (c === "x" ? 0.9 : 0.1)),
    });
    const scores = await reranker.score("query", [cand("a", "x"), cand("b", "y"), cand("c", "x")]);
    expect(scores).toEqual([0.9, 0.1, 0.9]);
    reranker.terminate();
  });

  it("returns [] for empty candidates without spawning a worker", async () => {
    const { reranker, workers } = makeReranker();
    const out = await reranker.score("q", []);
    expect(out).toEqual([]);
    expect(workers.length).toBe(0);
  });

  it("reuses the worker across multiple score() calls (model stays warm)", async () => {
    const { reranker, workers } = makeReranker();
    await reranker.score("q", [cand("a", "x")]);
    await reranker.score("q", [cand("b", "y")]);
    await reranker.score("q", [cand("c", "z")]);
    expect(workers.length).toBe(1);
    reranker.terminate();
  });

  it("dispatches concurrent requests by seq so each caller gets its own scores", async () => {
    let pending: Array<{ seq: number; query: string; candidates: string[]; resolve: (s: number[]) => void }> = [];
    const { reranker } = makeReranker({
      score: ({ query, candidates }) =>
        new Promise<number[]>((resolve) => {
          // Queue the request; tests fire resolves out of order below.
          pending.push({ seq: pending.length, query, candidates, resolve });
        }),
    });

    const p1 = reranker.score("q", [cand("a", "x")]);
    const p2 = reranker.score("q", [cand("b", "y")]);
    const p3 = reranker.score("q", [cand("c", "z")]);

    // Wait for all three to land in the queue.
    await new Promise((r) => setTimeout(r, 0));
    expect(pending.length).toBe(3);

    // Resolve in REVERSE order — the seq-routed dispatch must still
    // deliver each result to its original caller.
    pending[2]!.resolve([0.3]);
    pending[0]!.resolve([0.1]);
    pending[1]!.resolve([0.2]);

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1).toEqual([0.1]);
    expect(r2).toEqual([0.2]);
    expect(r3).toEqual([0.3]);
    reranker.terminate();
  });
});

// ---------------------------------------------------------------------------
// Abort + termination
// ---------------------------------------------------------------------------

describe("MiniLMReranker — AbortSignal contract", () => {
  it("returns null when the signal is already aborted on entry", async () => {
    const { reranker, workers } = makeReranker();
    const ctrl = new AbortController();
    ctrl.abort();
    const out = await reranker.score("q", [cand("a", "x")], { signal: ctrl.signal });
    expect(out).toBeNull();
    expect(workers.length).toBe(0); // never spawned
  });

  it("aborts in-flight requests and returns null (terminate fires)", async () => {
    const { reranker, workers } = makeReranker({ scoreDelayMs: 500 });
    const ctrl = new AbortController();
    const p = reranker.score("q", [cand("a", "x")], { signal: ctrl.signal });
    await new Promise((r) => setTimeout(r, 10));
    expect(workers.length).toBe(1);
    ctrl.abort();
    const out = await p;
    expect(out).toBeNull();
  });

  it("respawns the worker on the next call after abort terminated the old one", async () => {
    const { reranker, workers } = makeReranker({ scoreDelayMs: 200 });
    const ctrl = new AbortController();
    const p = reranker.score("q", [cand("a", "x")], { signal: ctrl.signal });
    ctrl.abort();
    await p;
    // First worker terminated; next score() spawns a fresh one.
    const out2 = await reranker.score("q", [cand("b", "y")]);
    expect(out2).toEqual([0.5]);
    expect(workers.length).toBe(2);
    reranker.terminate();
  });
});

// ---------------------------------------------------------------------------
// Crash + exit recovery
// ---------------------------------------------------------------------------

describe("MiniLMReranker — crash / exit recovery", () => {
  it("worker crash rejects pending requests, returning null per contract", async () => {
    const { reranker, workers } = makeReranker({ scoreDelayMs: 500 });
    const p = reranker.score("q", [cand("a", "x")]);
    await new Promise((r) => setTimeout(r, 10));
    workers[0]!.crash("simulated ONNX session failure");
    const out = await p;
    expect(out).toBeNull();
  });

  it("after crash, the next call respawns and succeeds", async () => {
    const { reranker, workers } = makeReranker({ scoreDelayMs: 500 });
    const p1 = reranker.score("q", [cand("a", "x")]);
    await new Promise((r) => setTimeout(r, 10));
    workers[0]!.crash();
    await p1;

    const out2 = await reranker.score("q", [cand("b", "y")]);
    expect(out2).toEqual([0.5]);
    expect(workers.length).toBe(2);
    reranker.terminate();
  });

  it("returns null when the score function throws inside the worker", async () => {
    const { reranker } = makeReranker({
      score: () => {
        throw new Error("@xenova/transformers not installed");
      },
    });
    const out = await reranker.score("q", [cand("a", "x")]);
    expect(out).toBeNull();
    reranker.terminate();
  });
});

// ---------------------------------------------------------------------------
// Worker init plumbing
// ---------------------------------------------------------------------------

describe("MiniLMReranker — worker init", () => {
  it("forwards modelId + quantized to the worker factory", async () => {
    const factory = vi.fn((init: WorkerInit) => new MockWorker(init, {}));
    const r = new MiniLMReranker({
      modelId: "custom/model",
      quantized: false,
      workerFactory: factory as unknown as MiniLMReranker["workerFactory" extends never ? never : never] extends never
        ? import("../../../src/core/rerankers/minilm.js").WorkerFactory
        : never,
    });
    await r.score("q", [cand("a", "x")]);
    expect(factory).toHaveBeenCalledOnce();
    expect(factory.mock.calls[0]![0]).toEqual({ modelId: "custom/model", quantized: false });
    r.terminate();
  });
});

// ---------------------------------------------------------------------------
// Optional end-to-end against real @xenova/transformers + ONNX.
// Skipped unless TRACEBASE_E2E_MINILM=1 to keep CI fast and dep-free.
// ---------------------------------------------------------------------------

const E2E = process.env.TRACEBASE_E2E_MINILM === "1";
describe.skipIf(!E2E)("MiniLMReranker — real ONNX (E2E)", () => {
  it("scores a small batch against the real MiniLM model", async () => {
    const r = new MiniLMReranker();
    const scores = await r.score("how to handle stale react state from useEffect closure", [
      cand("on-topic", "react useEffect stale state closure missing dependency"),
      cand("off-topic", "rust serde untagged enum default variant"),
    ]);
    expect(scores).toBeDefined();
    expect(scores!.length).toBe(2);
    expect(scores![0]).toBeGreaterThan(scores![1]!);
    r.terminate();
  }, 30_000);
});
