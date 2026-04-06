import { Command } from "commander";
import pc from "picocolors";
import { loadConfig } from "../../core/config.js";

export const serveCommand = new Command("serve")
  .description("Start the TraceBase server (HTTP or MCP)")
  .option("-p, --port <port>", "HTTP port", "3781")
  .option("--mcp", "start as MCP server (stdio transport)")
  .option("--host <host>", "bind address", "127.0.0.1")
  .action(async (opts: { port: string; mcp?: boolean; host: string }) => {
    const config = loadConfig();

    if (opts.mcp) {
      // Dynamic import to avoid loading MCP SDK when not needed
      try {
        const { startMcpServer } = await import("../../server/mcp.js");
        await startMcpServer(config);
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
