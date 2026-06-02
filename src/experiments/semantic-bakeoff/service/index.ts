/** Semantic inference data plane (R&D) — public surface. */
export * from "./protocol.js";
export { SwrCache, type CacheState, type CachedVerdict, type SwrCacheOptions } from "./cache.js";
export { type RerankBackend, FakeRerankBackend, QwenRerankBackend, type FakeBackendOptions } from "./backend.js";
export { createRerankService, type RerankService, type ServiceOptions } from "./server.js";
export { HttpRerankProvider, type HttpRerankClientOptions, type HttpClientHealth } from "./client.js";
