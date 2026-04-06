import { defineConfig } from "tsup";

const EXTERNALS = [
  "better-sqlite3",
  "openai",
  "@anthropic-ai/sdk",
  "@modelcontextprotocol/sdk",
  "@modelcontextprotocol/sdk/server/mcp.js",
  "@modelcontextprotocol/sdk/server/stdio.js",
  "zod",
];

export default defineConfig([
  // Main library
  {
    entry: { index: "src/index.ts" },
    format: ["cjs", "esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "node18",
    treeshake: true,
    external: EXTERNALS,
  },
  // MCP server (separate — optional peer deps)
  {
    entry: { mcp: "src/server/mcp.ts" },
    format: ["cjs", "esm"],
    dts: false, // Skip DTS — types depend on optional @modelcontextprotocol/sdk
    sourcemap: true,
    target: "node18",
    treeshake: true,
    external: EXTERNALS,
  },
  // CLI
  {
    entry: { cli: "bin/cli.ts" },
    format: ["cjs"],
    target: "node18",
    banner: { js: "#!/usr/bin/env node" },
    external: EXTERNALS,
  },
]);
