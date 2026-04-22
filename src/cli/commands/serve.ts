import { Command } from "commander";
import pc from "picocolors";
import { findProjectRoot, loadConfig } from "../../core/config.js";

export const serveCommand = new Command("serve")
  .description("Start the TraceBase server (HTTP or MCP)")
  .option("-p, --port <port>", "HTTP port", "3781")
  .option("--mcp", "start as MCP server (stdio transport)")
  .option("--host <host>", "bind address", "127.0.0.1")
  .action(async (opts: { port: string; mcp?: boolean; host: string }) => {
    const config = loadConfig();
    // Resolve the project root the same way every other CLI command
    // does — walk up from cwd looking for `.tracebase/`. Pass it
    // through explicitly so MCP runtime reads (e.g. holdout config)
    // never have to reverse-engineer it from `storagePath`.
    const basePath = findProjectRoot(process.cwd()) ?? process.cwd();

    if (opts.mcp) {
      // Dynamic import to avoid loading MCP SDK when not needed
      try {
        const { startMcpServer } = await import("../../server/mcp.js");
        await startMcpServer(config, { basePath });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND") {
          console.error(
            pc.red("Error: ") +
              "@modelcontextprotocol/sdk is required for MCP mode.",
          );
          console.error(
            pc.dim("  Install: npm install @modelcontextprotocol/sdk"),
          );
          process.exit(1);
        }
        throw e;
      }
      return;
    }

    // HTTP server
    const { startHttpServer } = await import("../../server/http.js");
    const port = parseInt(opts.port, 10);
    await startHttpServer(config, opts.host, port);

    console.log(
      pc.green("✓") +
        ` TraceBase HTTP server running on ${pc.cyan(`http://${opts.host}:${port}`)}`,
    );
    console.log(pc.dim("  Press Ctrl+C to stop."));
  });
