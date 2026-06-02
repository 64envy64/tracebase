/**
 * FROZEN candidate manifest for the semantic-applicability bakeoff (R&D).
 *
 * DATA ONLY. Each entry describes a candidate applicability reranker — its source
 * (Hugging Face card), license, size, and offline posture — verified from the
 * model cards on 2026-06-02. No weights are downloaded and no inference adapter is
 * built here; these entries are the frozen target set a future, separately-
 * approved bakeoff would implement adapters for. The deterministic baseline is the
 * only entry with code in-repo (it is also the fail-open fallback).
 *
 * Licenses verified: every confirmed candidate is Apache-2.0 with downloadable
 * weights → all are offline-capable (local-process inference, no remote API).
 */
import { createHash } from "node:crypto";

export type CandidateKind = "deterministic-baseline" | "cross-encoder";
export type CandidateStatus = "verified" | "pending-verification";

export interface CandidateManifestEntry {
  id: string;
  displayName: string;
  kind: CandidateKind;
  /** Parameter scale (approx where the card doesn't state an exact count). */
  params: string;
  /** Authoritative source (Hugging Face model card / repo, or in-repo path). */
  source: string;
  /** SPDX-ish license string verbatim from the card, or "in-repo" for the baseline. */
  license: string;
  /** Weights downloadable from the source (false for the in-repo baseline). */
  weightsDownloadable: boolean;
  /** Can run fully offline (local weights, no remote API). */
  offlineCapable: boolean;
  /** The network posture an adapter WOULD declare to the bakeoff boundary. */
  network: "none" | "local-process";
  status: CandidateStatus;
  baseModel?: string;
  notes?: string;
}

/**
 * The frozen matrix. Adapters are NOT implemented (R&D substrate only). Adding an
 * adapter + downloading weights is a separate, explicitly-approved step.
 */
export const CANDIDATE_MANIFEST: readonly CandidateManifestEntry[] = [
  {
    id: "deterministic-baseline",
    displayName: "Deterministic applicability reranker (in-repo)",
    kind: "deterministic-baseline",
    params: "n/a (rule-based, structured-field overlap + discriminative gap)",
    source: "src/core/applicability-reranker.ts (this repository)",
    license: "in-repo (project source)",
    weightsDownloadable: false,
    offlineCapable: true,
    network: "none",
    status: "verified",
    notes: "The shipped D.2 provider and the bakeoff's fail-open fallback. featureVersion 1.",
  },
  {
    id: "qwen3-reranker-0.6b",
    displayName: "Qwen3-Reranker-0.6B",
    kind: "cross-encoder",
    params: "0.6B",
    source: "https://huggingface.co/Qwen/Qwen3-Reranker-0.6B",
    license: "apache-2.0",
    weightsDownloadable: true,
    offlineCapable: true,
    network: "local-process",
    status: "verified",
    baseModel: "Qwen3-0.6B-Base",
    notes: "Instruction-aware reranker from the Qwen3 Embedding/Reranking release.",
  },
  {
    id: "bge-reranker-v2-m3",
    displayName: "BGE-reranker-v2-m3",
    kind: "cross-encoder",
    params: "bge-m3 backbone (XLM-RoBERTa-large class, ~568M)",
    source: "https://huggingface.co/BAAI/bge-reranker-v2-m3",
    license: "apache-2.0",
    weightsDownloadable: true,
    offlineCapable: true,
    network: "local-process",
    status: "verified",
    baseModel: "bge-m3",
    notes: "Multilingual cross-encoder reranker (BAAI). Param count approximate (backbone class).",
  },
  {
    id: "memreranker",
    displayName: "MemReranker (0.6B / 4B)",
    kind: "cross-encoder",
    params: "0.6B / 4B",
    source: "https://huggingface.co/IAAR-Shanghai/MemReranker-4B",
    license: "apache-2.0",
    weightsDownloadable: true,
    offlineCapable: true,
    network: "local-process",
    status: "verified",
    baseModel: "Qwen3-Reranker-4B",
    notes: "Reasoning-aware reranking purpose-built for agent-memory retrieval (arXiv 2605.06132). Most on-domain for TraceBase. Larger; latency budget must be validated against the §7.4 50ms p95 rail before any serving.",
  },
];

/** Canonical, stable digest of the frozen matrix — pins the candidate set for a run. */
export function manifestDigest(entries: readonly CandidateManifestEntry[] = CANDIDATE_MANIFEST): string {
  const canonical = entries.map((e) => [e.id, e.kind, e.params, e.source, e.license, e.weightsDownloadable, e.offlineCapable, e.network, e.status, e.baseModel ?? ""]);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 16);
}
