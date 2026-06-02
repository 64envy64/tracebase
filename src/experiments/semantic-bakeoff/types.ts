/**
 * Semantic-applicability provider BAKEOFF substrate — types (R&D, off the frozen
 * D.5 runtime). This is a comparison harness ONLY: it lets several applicability
 * providers be scored over the same scanned fixtures, offline, deterministically.
 * It does NOT wire any model into production serving and downloads no weights.
 *
 * Every provider is the existing `ApplicabilityProvider` (core/applicability-
 * reranker.ts): deterministic for fixed inputs, returns `null` (never throws) on
 * failure/timeout so the caller falls open. The bakeoff adds three things on top:
 *   1. a STRICT deadline + fail-open fallback to the deterministic baseline,
 *   2. a declared network posture (no implicit network — remote needs opt-in),
 *   3. scanned DTOs only (a leaky fixture is dropped before any provider sees it).
 */
import type {
  ApplicabilityProvider,
  ApplicabilityQueryViews,
  ApplicabilityCandidate,
  ApplicabilityResult,
} from "../../core/applicability-reranker.js";

/**
 * How a candidate provider reaches its model. The substrate FORBIDS implicit
 * network: `remote-explicit` providers only run when the caller passes
 * `allowRemote`, and none of the shipped candidates here are remote.
 */
export type ProviderNetwork = "none" | "local-process" | "remote-explicit";

/** A bakeoff-registered provider: an ApplicabilityProvider + declared capabilities. */
export interface BakeoffProvider {
  /** Stable manifest id (must match an entry in CANDIDATE_MANIFEST). */
  manifestId: string;
  provider: ApplicabilityProvider;
  /** Declared network posture; `remote-explicit` requires `allowRemote` at run time. */
  network: ProviderNetwork;
}

/** A scanned, bounded probe fixture — built ONLY from scrubbed views/candidates. */
export interface BakeoffProbeDTO {
  probeId: string;
  query: ApplicabilityQueryViews;
  candidates: readonly ApplicabilityCandidate[];
}

/** Why a provider's own attempt was abandoned and the fallback served. Closed enum. */
export type BakeoffFallbackReason = "timeout" | "null" | "threw" | "network-blocked";

/** The result of running ONE probe through ONE provider (or its fallback). */
export interface BakeoffOutcome {
  probeId: string;
  manifestId: string;
  /** The provider that actually produced `results` (the candidate, or the fallback). */
  providerName: string;
  featureVersion: number;
  /** null only when BOTH the provider and the fallback failed. */
  results: ApplicabilityResult[] | null;
  latencyMs: number;
  /** True when the candidate failed/timed out/was blocked and the fallback served. */
  usedFallback: boolean;
  /** Present iff `usedFallback`. */
  fallbackReason?: BakeoffFallbackReason;
}

export interface RunBakeoffOptions {
  deadlineMs?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Opt-in for `remote-explicit` providers. Default false → they fall open. */
  allowRemote?: boolean;
  /** Fail-open fallback. Defaults to a fresh DeterministicApplicabilityReranker. */
  fallback?: ApplicabilityProvider;
}

export interface BakeoffRun {
  outcomes: BakeoffOutcome[];
  /** Number of fixtures that passed the leakage scan and were run. */
  scanned: number;
  /** Fixtures dropped by the scan (scanned DTOs only — never sent to a provider). */
  rejected: { probeId: string; pattern: string }[];
}
