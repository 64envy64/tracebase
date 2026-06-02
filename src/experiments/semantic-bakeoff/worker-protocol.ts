/**
 * Typed JSONL protocol for the persistent local-process semantic worker (R&D).
 *
 * Provider-AGNOSTIC: any worker (the deterministic fake, a Python Qwen worker, a
 * future ONNX worker) speaks this same newline-delimited JSON contract over its
 * stdin/stdout. One JSON object per line. The host (PersistentWorkerProvider)
 * never assumes a specific model — it only speaks this protocol.
 *
 * Bounded by construction: requests carry capped, already-scanned token fields
 * (no raw paths/secrets — the host scans before transport and the worker only
 * ever sees opaque blockIds + bounded tokens). The worker returns only a verdict +
 * a bounded confidence per candidate — never free text.
 */
export const WORKER_PROTOCOL_VERSION = 1 as const;

/** Bounded candidate sent over the wire — opaque id + capped token lists. */
export interface WireCandidate {
  blockId: string;
  mechanism: string[];
  situation: string[];
  unlock: string[];
}
export interface WireQuery {
  literalText: string;
  causalText?: string;
}

export type WorkerRequest =
  | { v: typeof WORKER_PROTOCOL_VERSION; id: string; type: "hello" }
  | { v: typeof WORKER_PROTOCOL_VERSION; id: string; type: "rank"; query: WireQuery; candidates: WireCandidate[] }
  | { v: typeof WORKER_PROTOCOL_VERSION; id: string; type: "cancel"; cancelId: string }
  | { v: typeof WORKER_PROTOCOL_VERSION; id: string; type: "shutdown" };

export type WireVerdict = "applicable" | "uncertain" | "inapplicable";
export interface WireResult {
  blockId: string;
  verdict: WireVerdict;
  /** Bounded applicability confidence ∈ [0,1]. */
  confidence: number;
}

export type WorkerResponse =
  | { v: typeof WORKER_PROTOCOL_VERSION; id: string; type: "ready"; model: string; featureVersion: number }
  | { v: typeof WORKER_PROTOCOL_VERSION; id: string; type: "result"; results: WireResult[] }
  | { v: typeof WORKER_PROTOCOL_VERSION; id: string; type: "error"; message: string }
  | { v: typeof WORKER_PROTOCOL_VERSION; id: string; type: "cancelled" };

/** Parse one stdout line into a typed response, or null if it isn't a valid one. */
export function parseWorkerLine(line: string): WorkerResponse | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed[0] !== "{") return null; // ignore the worker's own logging
  let o: unknown;
  try {
    o = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object") return null;
  const r = o as Partial<WorkerResponse>;
  if (r.v !== WORKER_PROTOCOL_VERSION || typeof r.id !== "string" || typeof r.type !== "string") return null;
  if (r.type === "ready" || r.type === "result" || r.type === "error" || r.type === "cancelled") return r as WorkerResponse;
  return null;
}

export function serializeRequest(req: WorkerRequest): string {
  return JSON.stringify(req) + "\n";
}
