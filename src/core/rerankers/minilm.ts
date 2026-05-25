/**
 * MiniLMReranker — May-2026 B1.3.
 *
 * Local cross-encoder reranker wrapping `@xenova/transformers` in a
 * `worker_threads` Worker so ONNX inference can't block the host
 * event loop. The Reranker interface (timeout, AbortSignal, never-
 * throws contract) defined in `src/core/reranker.ts` is preserved
 * verbatim — this is just a concrete implementation that earns
 * `kind: "minilm"` in cascade config.
 *
 * Why a worker
 * ------------
 * ONNX kernels are CPU-bound, can take 50-500ms per batch on a
 * laptop, and offer no in-process pre-emption. Running them on the
 * main thread blocks every hook / middleware / MCP call concurrently
 * waiting. The worker boundary means:
 *
 *   1. The main thread stays responsive — other recalls keep flowing
 *      through the sync `recall()` path while inference is in flight.
 *   2. AbortSignal from `withRerankerFallback` can call
 *      `worker.terminate()` — the ONLY way to stop ONNX from outside
 *      its tensor kernel. Without termination the kernel would burn
 *      CPU until completion, undoing the timeout contract from B1.1.
 *   3. A crashed worker (model file corrupt, native binary mismatch)
 *      doesn't take down the MCP server. We catch the exit event,
 *      null out the reference, and the next call respawns or — if
 *      the failure repeats — falls back through `withRerankerFallback`.
 *
 * Why @xenova/transformers
 * ------------------------
 * It's the JS port of HuggingFace transformers — ONNX inference,
 * WordPiece tokenization, model cache, and weight format all in one
 * package. Hand-rolling a WordPiece tokenizer + ONNX session setup
 * is ~1500 LOC of code that would not give product-visible lift over
 * "we use the standard library". Optional peer dep — users only pay
 * the ~30MB native dep when they opt into `kind: "minilm"`.
 *
 * Model
 * -----
 * Default: `Xenova/ms-marco-MiniLM-L-6-v2` (Apache-2.0, quantized
 * int8, ~80MB on first download). On first use @xenova/transformers
 * downloads to `~/.cache/huggingface/` (or `TRANSFORMERS_CACHE` env
 * override); `tracebase doctor --fix` pre-warms this so the first
 * production query doesn't see the download latency.
 *
 * Tests
 * -----
 * The worker is injected through `WorkerFactory` so tests can
 * substitute a mock worker. Real ONNX is exercised end-to-end only
 * under `TRACEBASE_E2E_MINILM=1` — CI doesn't load 80MB of weights
 * just to verify the message protocol.
 */

import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Reranker, RerankerCandidate } from "../reranker.js";

export interface MiniLMRerankerOptions {
  /**
   * HuggingFace model id understood by @xenova/transformers. Default
   * is the public Apache-2.0 cross-encoder. Override only if you've
   * vetted an alternative for licensing and quality.
   */
  modelId?: string;
  /**
   * Whether to load the int8-quantized variant (default true). Cuts
   * model size by ~4× with negligible relevance loss for the
   * top-K-rerank use case.
   */
  quantized?: boolean;
  /**
   * Injectable factory so tests can substitute a mock worker without
   * spawning a real Worker process. Production code never passes
   * this; the default factory points at the worker entry script
   * sitting next to this file.
   */
  workerFactory?: WorkerFactory;
}

/**
 * Minimal Worker-shaped surface — the subset of `node:worker_threads`
 * Worker that MiniLMReranker actually uses. Mock workers in tests
 * implement this shape without the full Worker contract.
 */
export interface WorkerLike {
  postMessage(value: unknown): void;
  on(event: "message", listener: (msg: unknown) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: "exit", listener: (code: number) => void): this;
  terminate(): Promise<number>;
}

export type WorkerFactory = (init: WorkerInit) => WorkerLike;

export interface WorkerInit {
  modelId: string;
  quantized: boolean;
}

/**
 * Default factory — spawns the real worker script. Resolves the
 * sibling `minilm-worker.js` next to this module after build, so
 * the relative path works in both dev (.ts via tsx) and production
 * (.js via tsup). Uses `import.meta.url` so the resolution survives
 * any CWD shift.
 */
const defaultWorkerFactory: WorkerFactory = (init) => {
  const here = typeof __dirname === "string"
    ? __dirname
    : dirname(fileURLToPath(import.meta.url));
  const entry = join(here, "minilm-worker.js");
  return new Worker(entry, { workerData: init }) as unknown as WorkerLike;
};

type Pending = {
  resolve: (scores: number[]) => void;
  reject: (err: Error) => void;
};

type WorkerMessage =
  | { type: "scores"; seq: number; scores: number[] }
  | { type: "error"; seq: number; error: string }
  | { type: "ready" };

export class MiniLMReranker implements Reranker {
  readonly name = "minilm";

  private worker: WorkerLike | null = null;
  private readonly pending = new Map<number, Pending>();
  private seq = 0;
  private readonly modelId: string;
  private readonly quantized: boolean;
  private readonly workerFactory: WorkerFactory;

  constructor(opts: MiniLMRerankerOptions = {}) {
    this.modelId = opts.modelId ?? "Xenova/ms-marco-MiniLM-L-6-v2";
    this.quantized = opts.quantized ?? true;
    this.workerFactory = opts.workerFactory ?? defaultWorkerFactory;
  }

  async score(
    query: string,
    candidates: RerankerCandidate[],
    options?: { signal?: AbortSignal },
  ): Promise<number[] | null> {
    if (candidates.length === 0) return [];

    // Honour AbortSignal — terminate the worker entirely on abort.
    // ONNX inference isn't externally pre-emptible, so termination
    // is the only way to stop CPU burn. Next call spawns a fresh
    // worker; warm cache makes this cheap after first load.
    let abortHandler: (() => void) | null = null;
    if (options?.signal) {
      if (options.signal.aborted) return null;
      abortHandler = () => this.terminate();
      options.signal.addEventListener("abort", abortHandler);
    }

    try {
      const worker = await this.ensureWorker();
      const seq = ++this.seq;
      return await new Promise<number[]>((resolve, reject) => {
        this.pending.set(seq, { resolve, reject });
        worker.postMessage({
          type: "score",
          seq,
          query,
          candidates: candidates.map((c) => c.triggerText),
        });
      });
    } catch {
      // Honesty contract: never throw. The caller's
      // `withRerankerFallback` wrapper sees null and falls back to
      // the pre-rerank order, with telemetry stamped accordingly.
      return null;
    } finally {
      if (abortHandler && options?.signal) {
        options.signal.removeEventListener("abort", abortHandler);
      }
    }
  }

  /**
   * Tear the worker down explicitly. Safe to call multiple times —
   * the first call terminates and clears state; subsequent calls are
   * no-ops. Used by `withRerankerFallback`'s abort path and by
   * BlockServer shutdown.
   */
  terminate(): void {
    if (this.worker) {
      // Fire-and-forget. We deliberately don't await — termination
      // races with the timeout in withRerankerFallback and we want
      // to release the worker reference NOW so the next score()
      // call can spawn a fresh one. Reject every pending request.
      void this.worker.terminate().catch(() => {});
      this.worker = null;
    }
    const err = new Error("worker terminated");
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }

  /**
   * Lazy worker spawn. Reused across score() calls so the model
   * stays cached in worker memory — first call pays the model-load
   * cost (~500ms for quantized MiniLM after weights are local),
   * subsequent calls pay only the inference time.
   */
  private async ensureWorker(): Promise<WorkerLike> {
    if (this.worker) return this.worker;

    const worker = this.workerFactory({
      modelId: this.modelId,
      quantized: this.quantized,
    });

    worker.on("message", (raw: unknown) => {
      const msg = raw as WorkerMessage;
      if (!msg || typeof msg !== "object" || !("type" in msg)) return;
      if (msg.type === "scores") {
        const p = this.pending.get(msg.seq);
        if (!p) return;
        this.pending.delete(msg.seq);
        p.resolve(msg.scores);
      } else if (msg.type === "error") {
        const p = this.pending.get(msg.seq);
        if (!p) return;
        this.pending.delete(msg.seq);
        p.reject(new Error(msg.error));
      }
      // "ready" is informational — no pending to resolve.
    });

    worker.on("error", (err: Error) => {
      // Native binary mismatch, OOM, etc. Reject every pending and
      // null the reference; next call respawns or falls through to
      // the wrapper's fallback if respawn also fails.
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
      this.worker = null;
    });

    worker.on("exit", () => {
      for (const { reject } of this.pending.values()) {
        reject(new Error("worker exited"));
      }
      this.pending.clear();
      this.worker = null;
    });

    this.worker = worker;
    return worker;
  }
}
