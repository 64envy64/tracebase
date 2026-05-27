# Task B — Auth + Session Cache

`npm test` is failing. The auth middleware looks up a session on every request and bumps the role-permission check. Active sessions that are repeatedly touched on every request should stay resident even as new sessions arrive — they're the hot working set.

The test simulates realistic auth traffic: a single hot session is touched between bursts of new short-lived sessions, then asserted to still be in the cache. The hot session is being evicted instead.

Investigate. Fix the source so the tests pass. Do not edit tests.

Files:
- `src/server.ts` — request entry
- `src/auth/middleware.ts` — auth middleware
- `src/auth/permissionChecker.ts` — role / permission resolution
- `src/auth/sessionStore.ts` — session store façade
- `src/cache/lruCache.ts` — bounded LRU
- `src/cache/types.ts` — cache types
- `src/util/clock.ts` — clock primitive
- `tests/permissionCheck.test.ts` — acceptance tests (fixed)
