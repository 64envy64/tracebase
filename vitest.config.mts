import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // Mirror www/tsconfig.json → "@/*": "./src/*". Root-level tests
      // that exercise www modules import via this alias rather than
      // brittle relative paths.
      "@": resolve(here, "www/src"),
      // Stubs so importing server modules (which gate themselves on
      // these in production) does not fail in node test runner.
      "server-only": resolve(here, "tests/stubs/server-only.ts"),
    },
  },
  test: {
    globals: true,
    include: ["tests/**/*.test.ts"],
    testTimeout: 10_000,
    pool: "forks",
    // Unit tests run on tiny single-block FTS5 corpuses where IDF is
    // degenerate, so the production gate (0.4) would mask hits. Pin
    // gate=0 in test processes — production paths read this env var
    // via `resolveProductionGateThreshold()` and fall back to the
    // safe production default when unset. Individual tests can
    // override by setting the env var explicitly in beforeAll.
    env: {
      TRACEBASE_GATE_THRESHOLD: "0",
    },
  },
});
