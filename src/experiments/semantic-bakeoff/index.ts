/**
 * Semantic-applicability bakeoff substrate (R&D). Public surface.
 *
 * Comparison harness ONLY — no model weights, no inference adapters, no network.
 * The real Qwen3 / BGE / MemReranker adapters (CANDIDATE_MANIFEST) are a future,
 * separately-approved step; today the only providers are the in-repo deterministic
 * baseline and a deterministic fake for harness tests.
 */
export * from "./types.js";
export { runProbe, runBakeoff, scanProbeDTO, DEFAULT_BAKEOFF_DEADLINE_MS } from "./boundary.js";
export { DeterministicFakeProvider, type FakeProviderOptions } from "./fake-provider.js";
export { CANDIDATE_MANIFEST, manifestDigest, type CandidateManifestEntry, type CandidateKind, type CandidateStatus } from "./manifest.js";
