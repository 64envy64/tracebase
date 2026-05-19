/**
 * MiniLMReranker worker entry — May-2026 B1.3.
 *
 * Runs inside a Node `worker_threads` Worker. Lazy-imports
 * `@xenova/transformers` so a project that never enables `kind: "minilm"`
 * pays zero dep cost. The dynamic import means missing-dep failures
 * surface as a structured error message rather than a process crash —
 * the host `MiniLMReranker` translates that into the standard
 * `Reranker.score() → null` fallback path.
 *
 * Wire format
 * -----------
 *   in:  { type: "score", seq: number, query: string, candidates: string[] }
 *   out: { type: "scores", seq: number, scores: number[] }
 *   out: { type: "error",  seq: number, error: string }
 *   out: { type: "ready" }   (informational; emitted once the model loads)
 *
 * Score normalisation
 * -------------------
 * `@xenova/transformers` `text-classification` pipeline on a
 * cross-encoder returns `[{ label, score }]` where `score` is already
 * sigmoid'd to [0, 1] — no extra math needed. We clamp defensively
 * because a misbehaving pipeline could conceivably overflow.
 */

import { parentPort, workerData } from "node:worker_threads";

interface ScoreMessage {
  type: "score";
  seq: number;
  query: string;
  candidates: string[];
}

interface WorkerInit {
  modelId: string;
  quantized: boolean;
}

type Pipeline = (
  pairs: Array<{ text: string; text_pair: string }> | Array<{ text: string; text_pair: string }>,
) => Promise<Array<{ label: string; score: number }>>;

let pipelinePromise: Promise<Pipeline> | null = null;

async function getPipeline(): Promise<Pipeline> {
  if (pipelinePromise) return pipelinePromise;
  pipelinePromise = (async () => {
    // Dynamic import keeps the dep optional: a project that never
    // enables MiniLM never resolves this module, so installs without
    // @xenova/transformers in node_modules continue to work.
    const tf = (await import("@xenova/transformers" as string).catch(() => null)) as
      | { pipeline: (task: string, model: string, opts: { quantized: boolean }) => Promise<Pipeline> }
      | null;
    if (!tf) {
      throw new Error(
        "@xenova/transformers is not installed. " +
          "Install it as an opt-in dep to enable the MiniLM reranker: " +
          "npm install @xenova/transformers",
      );
    }
    const init = (workerData ?? {}) as WorkerInit;
    const pipeline = await tf.pipeline("text-classification", init.modelId, {
      quantized: init.quantized,
    });
    return pipeline;
  })();
  return pipelinePromise;
}

// Pre-warm: kick off the model load as soon as the worker boots so
// the first score() call doesn't pay the full cold-start latency.
// Errors here surface on the next message round-trip; we don't
// crash the worker on prewarm failure (the host can still fall
// back gracefully).
void getPipeline()
  .then(() => parentPort?.postMessage({ type: "ready" }))
  .catch(() => {
    // The next score() call will surface the same error to the host
    // via the seq-tagged error envelope — no need to crash here.
  });

parentPort?.on("message", async (raw: unknown) => {
  const msg = raw as ScoreMessage;
  if (!msg || typeof msg !== "object" || msg.type !== "score") return;
  try {
    const pipeline = await getPipeline();
    const pairs = msg.candidates.map((c) => ({ text: msg.query, text_pair: c }));
    const results = await pipeline(pairs);
    const scores = results.map((r) => clamp01(r.score));
    parentPort?.postMessage({ type: "scores", seq: msg.seq, scores });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    parentPort?.postMessage({ type: "error", seq: msg.seq, error: message });
  }
});

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
