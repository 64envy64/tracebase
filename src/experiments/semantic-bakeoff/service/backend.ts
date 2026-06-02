/**
 * Rerank backends behind ONE interface (R&D): a deterministic fake (for $0 tests)
 * and a Qwen-local backend (wraps the persistent worker). The service is
 * backend-agnostic — it speaks only this interface.
 */
import { PersistentWorkerProvider } from "../worker-adapter.js";
import type { WireQuery, WireCandidate, WireResult } from "../worker-protocol.js";
import type { ModelAttestation } from "./protocol.js";

export interface RerankBackend {
  readonly attestation: ModelAttestation;
  start?(): Promise<void>;
  /** Return verdicts, or null on any failure/timeout. `signal` aborts on the
   *  server deadline OR client disconnect — backends should honour it. */
  rerank(query: WireQuery, candidates: WireCandidate[], deadlineMs: number, signal?: AbortSignal): Promise<WireResult[] | null>;
  close?(): Promise<void>;
}

function stableUnit(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0xffffffff;
}

export interface FakeBackendOptions {
  revision?: string;
  featureVersion?: number;
  delayMs?: number;
  throwErr?: boolean;
  returnNull?: boolean;
}

/** Deterministic fake backend — stable verdicts; configurable failure modes. */
export class FakeRerankBackend implements RerankBackend {
  readonly attestation: ModelAttestation;
  constructor(private readonly opts: FakeBackendOptions = {}) {
    this.attestation = { model: "fake", revision: opts.revision ?? "fake-rev-1", featureVersion: opts.featureVersion ?? 1, backend: "fake" };
  }
  async rerank(_q: WireQuery, candidates: WireCandidate[], _deadlineMs: number, signal?: AbortSignal): Promise<WireResult[] | null> {
    if (this.opts.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, this.opts.delayMs);
        signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); }, { once: true });
      });
    }
    if (this.opts.throwErr) throw new Error("fake backend crash");
    if (this.opts.returnNull) return null;
    return candidates.map((c) => {
      const u = stableUnit(c.blockId);
      return { blockId: c.blockId, verdict: u > 0.66 ? "applicable" : u > 0.33 ? "uncertain" : "inapplicable", confidence: u };
    });
  }
}

/**
 * Qwen local backend — wraps the persistent worker (qwen-worker.py). Only used
 * when the pinned weights are present; tests use the fake. Maps the wire DTO
 * through the ApplicabilityProvider contract the worker adapter implements.
 */
export class QwenRerankBackend implements RerankBackend {
  readonly attestation: ModelAttestation;
  private readonly provider: PersistentWorkerProvider;
  constructor(opts: { command: string; modelDir: string; revision: string; featureVersion?: number }) {
    this.attestation = { model: "Qwen/Qwen3-Reranker-0.6B", revision: opts.revision, featureVersion: opts.featureVersion ?? 1, backend: "qwen-local" };
    this.provider = new PersistentWorkerProvider({
      command: opts.command,
      args: [new URL("../../../../scripts/semantic-bakeoff/qwen-worker.py", import.meta.url).pathname.replace(/^\//, "")],
      name: "qwen-local",
      handshakeTimeoutMs: 240_000,
      concurrency: 4,
      env: { TB_QWEN_MODEL_DIR: opts.modelDir },
    });
  }
  async rerank(query: WireQuery, candidates: WireCandidate[], deadlineMs: number, signal?: AbortSignal): Promise<WireResult[] | null> {
    // E.2.3 — propagate the AbortSignal into the worker provider so a client
    // disconnect (the server aborts on `res.close`) triggers cancel→grace→recycle,
    // releasing the GPU instead of waiting for the deadline.
    const r = await this.provider.rank(
      { literalText: query.literalText, ...(query.causalText ? { causalText: query.causalText } : {}) },
      candidates.map((c) => ({ blockId: c.blockId, tokens: { situation: c.situation, mechanism: c.mechanism, unlock: c.unlock, invariants: [] }, signals: { isPitfall: false, helpful: 0, harmful: 0, unresolved: 0, familySupport: 0, sourceDiversity: 0 } })),
      { deadlineMs, now: Date.now, ...(signal ? { signal } : {}) },
    );
    return r ? r.map((x) => ({ blockId: x.blockId, verdict: x.verdict, confidence: x.confidence })) : null;
  }
  async close(): Promise<void> {
    await this.provider.close();
  }
}
