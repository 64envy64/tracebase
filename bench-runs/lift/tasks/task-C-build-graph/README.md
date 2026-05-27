# Task C — Build Graph

`npm test` is failing. The build CLI is supposed to resolve a project's module dependencies, compile each, and emit the build artifact. Some test projects contain circular dependencies (a depends on b, b depends on a) — these are legal at runtime via lazy require. The resolver currently hangs (or stack overflows) on such input; tests time out.

Investigate. Fix the source so the tests pass. Do not edit tests.

Files:
- `src/cli.ts` — entry
- `src/build/builder.ts` — orchestrator
- `src/build/resolver.ts` — dependency resolver
- `src/build/compiler.ts` — per-module compiler
- `src/build/manifestParser.ts` — parse manifest input
- `src/util/logger.ts` — logger
- `src/types.ts` — shared types
- `tests/build.test.ts` — acceptance tests (fixed)
