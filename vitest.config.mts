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
  },
});
