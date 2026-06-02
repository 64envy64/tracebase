/**
 * HTTP protocol v2 for the semantic inference data plane (R&D).
 *
 * v2 hardening (E.2.1): strict runtime DECODERS (never trust the wire), a unique
 * requestId echoed + verified, a requested deadline + absolute expiresAt, a
 * verdict enum + confidence bounds, a candidate-content digest in the cache key,
 * and attestation/requestId verification on the client. Tenant is NEVER in the
 * body — the server derives it from a verified principal (see auth.ts).
 */
import { createHash } from "node:crypto";
import type { WireQuery, WireCandidate, WireResult, WireVerdict } from "../worker-protocol.js";

export const RERANK_PROTOCOL_VERSION = 2 as const;
const VERDICTS: ReadonlySet<string> = new Set(["applicable", "uncertain", "inapplicable"]);

export interface RerankRequestDTO {
  v: typeof RERANK_PROTOCOL_VERSION;
  /** Unique per request; echoed back + verified by the client. */
  requestId: string;
  /** Client-requested deadline (ms); the server clamps to min(client, serverCap). */
  deadlineMs: number;
  /** Absolute wall-clock expiry (ms epoch); the server drops if already past. */
  expiresAtMs: number;
  featureVersion: number;
  query: WireQuery;
  candidates: WireCandidate[];
  // NOTE: NO tenant field — the server derives tenant from the verified principal.
}

export interface ModelAttestation {
  model: string;
  revision: string;
  featureVersion: number;
  backend: string;
}

export interface RerankResponseDTO {
  v: typeof RERANK_PROTOCOL_VERSION;
  requestId: string;
  attestation: ModelAttestation;
  results: WireResult[];
}

export interface HealthDTO {
  ok: boolean;
  attestation: ModelAttestation;
  inFlight: number;
  telemetry: {
    served: number;
    rejectedAuth: number;
    rejectedLeak: number;
    rejectedMalformed: number;
    rejectedTooLarge: number;
    rejectedExpired: number;
    quotaExceeded: number;
    timeouts: number;
    overloads: number;
    backendErrors: number;
  };
}

function isStr(x: unknown): x is string {
  return typeof x === "string";
}
function isFiniteNum(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}
function isTokens(x: unknown, maxTokenChars: number): x is string[] {
  // Bound BOTH the array length AND each token STRING's length (E.2.3).
  return Array.isArray(x) && x.length <= 512 && x.every((t) => isStr(t) && t.length <= maxTokenChars);
}

/** Strict decode of an inbound rerank request. Returns null on ANY shape violation. */
export function decodeRerankRequest(raw: unknown, bounds: { maxCandidates: number; maxQueryChars?: number; maxTokenChars?: number; maxBlockIdChars?: number }): RerankRequestDTO | null {
  const maxQ = bounds.maxQueryChars ?? 16_384;
  const maxTok = bounds.maxTokenChars ?? 256; // per-token string bound, not just array length
  const maxId = bounds.maxBlockIdChars ?? 256;
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== RERANK_PROTOCOL_VERSION) return null;
  if (!isStr(r.requestId) || r.requestId.length === 0 || r.requestId.length > 128) return null;
  if (!isFiniteNum(r.deadlineMs) || r.deadlineMs <= 0) return null;
  if (!isFiniteNum(r.expiresAtMs)) return null;
  if (!isFiniteNum(r.featureVersion)) return null;
  const q = r.query as Record<string, unknown> | undefined;
  if (!q || !isStr(q.literalText) || q.literalText.length > maxQ) return null; // input bound
  if (q.causalText !== undefined && (!isStr(q.causalText) || q.causalText.length > maxQ)) return null;
  if (!Array.isArray(r.candidates) || r.candidates.length === 0 || r.candidates.length > bounds.maxCandidates) return null;
  const seen = new Set<string>();
  for (const c of r.candidates) {
    const cc = c as Record<string, unknown>;
    if (!isStr(cc.blockId) || cc.blockId.length === 0 || cc.blockId.length > maxId) return null;
    if (seen.has(cc.blockId)) return null; // DUPLICATE block id → reject
    seen.add(cc.blockId);
    if (!isTokens(cc.mechanism, maxTok) || !isTokens(cc.situation, maxTok) || !isTokens(cc.unlock, maxTok)) return null;
  }
  return r as unknown as RerankRequestDTO;
}

/** Strict decode of a response (client side). Verifies requestId, attestation,
 *  verdict enum, confidence bounds, and that result ids are a unique SUBSET of the
 *  requested block ids. Returns null on any violation. */
export function decodeRerankResponse(
  raw: unknown,
  expect: { requestId: string; requestedBlockIds: ReadonlySet<string> },
): RerankResponseDTO | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== RERANK_PROTOCOL_VERSION) return null;
  if (r.requestId !== expect.requestId) return null; // requestId verification
  const att = r.attestation as Record<string, unknown> | undefined;
  if (!att || !isStr(att.model) || !isStr(att.revision) || !isFiniteNum(att.featureVersion) || !isStr(att.backend)) return null;
  if (!Array.isArray(r.results)) return null;
  const out: WireResult[] = [];
  const seen = new Set<string>();
  for (const res of r.results) {
    const rr = res as Record<string, unknown>;
    if (!isStr(rr.blockId) || !expect.requestedBlockIds.has(rr.blockId)) return null; // SUBSET of requested
    if (seen.has(rr.blockId)) return null; // UNIQUE result ids
    seen.add(rr.blockId);
    if (!isStr(rr.verdict) || !VERDICTS.has(rr.verdict)) return null; // verdict ENUM
    if (!isFiniteNum(rr.confidence) || rr.confidence < 0 || rr.confidence > 1) return null; // confidence BOUNDS
    out.push({ blockId: rr.blockId, verdict: rr.verdict as WireVerdict, confidence: rr.confidence });
  }
  return { v: RERANK_PROTOCOL_VERSION, requestId: expect.requestId, attestation: att as unknown as ModelAttestation, results: out };
}

const sha16 = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** Privacy-safe stable model identity for telemetry/manifests. Never contains credentials. */
export function attestationHash(att: ModelAttestation): string {
  return sha16(JSON.stringify([att.model, att.revision, att.backend, att.featureVersion]));
}

/** Stable hash of the query views (never the raw text leaves in the key). */
export function queryHash(q: WireQuery): string {
  return sha16(JSON.stringify([q.literalText, q.causalText ?? ""]));
}

/** Digest of a candidate's CONTENT (tokens) — binds the cache key to the content,
 *  so a changed candidate yields a different key (no stale-wrong-content serving). */
export function candidateDigest(c: Pick<WireCandidate, "mechanism" | "situation" | "unlock">): string {
  return sha16(JSON.stringify([c.mechanism, c.situation, c.unlock]));
}

/** The full cache key: tenant + model revision + featureVersion + queryHash +
 *  candidate-content digest + blockId. A model-version OR content change → new key. */
export function credentialPartition(authToken: string): string {
  // One-way fingerprint of the bearer credential (E.2.3). The client cache namespace
  // is bound to the EXACT credential it authenticates with, so it can never diverge
  // from the principal the server derives from the same token — removing the old
  // independently-settable tenant/auth mismatch. Never the raw token (not reversible).
  return "cred:" + sha16(authToken);
}

export function cacheKey(p: {
  partition: string;
  revision: string;
  featureVersion: number;
  queryHash: string;
  candidateDigest: string;
  blockId: string;
}): string {
  return [p.partition, p.revision, p.featureVersion, p.queryHash, p.candidateDigest, p.blockId].join("\0");
}
