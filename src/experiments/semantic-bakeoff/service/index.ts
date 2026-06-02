/** Semantic inference data plane (R&D) — public surface (v2, E.2.1). */
export * from "./protocol.js";
export {
  type SemanticCache,
  type SemanticCacheEntry,
  type SemanticCacheOptions,
  type CacheState,
  type Verdict,
  InMemorySemanticCache,
  SqliteSemanticCache,
} from "./cache.js";
export { type RerankBackend, FakeRerankBackend, QwenRerankBackend, type FakeBackendOptions } from "./backend.js";
export { type Authenticator, type Principal, FakeAuthenticator, StaticBearerAuthenticator, TenantQuota } from "./auth.js";
export { WarmQueue, type WarmQueueOptions } from "./warm-queue.js";
export { createRerankService, type RerankService, type ServiceOptions } from "./server.js";
export { HttpRerankProvider, type HttpRerankClientOptions, type HttpClientHealth } from "./client.js";
export { probeSemanticShadow, type SemanticShadowDoctorReport } from "./doctor.js";
export {
  diagnoseSemanticSidecarConfig,
  fileSha256,
  verifyQwenArtifact,
  startSemanticSidecar,
  type SemanticSidecarConfig,
  type SemanticSidecarConfigDiagnostic,
  type SemanticSidecarHandle,
} from "./sidecar.js";
