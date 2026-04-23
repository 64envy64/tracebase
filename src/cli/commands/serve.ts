import { Command } from "commander";
import pc from "picocolors";
import { findProjectRoot, loadConfig } from "../../core/config.js";

export const serveCommand = new Command("serve")
  .description("Start the TraceBase server (HTTP or MCP)")
  .option("-p, --port <port>", "HTTP port", "3781")
  .option("--mcp", "start as MCP server (stdio transport)")
  .option(
    "--selftest",
    "bootstrap the MCP server to READY without binding stdio, then exit 0 (used by `tracebase doctor` for live boot probes)",
  )
  .option("--host <host>", "bind address", "127.0.0.1")
  .action(async (opts: { port: string; mcp?: boolean; selftest?: boolean; host: string }) => {
    const config = loadConfig();
    // Resolve the project root the same way every other CLI command
    // does — walk up from cwd looking for `.tracebase/`. Pass it
    // through explicitly so MCP runtime reads (e.g. holdout config)
    // never have to reverse-engineer it from `storagePath`.
    const basePath = findProjectRoot(process.cwd()) ?? process.cwd();

    if (opts.mcp || opts.selftest) {
      try {
        const { startMcpServer } = await import("../../server/mcp.js");
        await startMcpServer(config, { basePath, selftest: !!opts.selftest });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND") {
          console.error(
            pc.red("Error: ") +
              "@modelcontextprotocol/sdk failed to resolve — the install is broken.",
          );
          console.error(
            pc.dim(
              "  The SDK is a hard dependency of tracebase-ai. " +
                "Try `npx -y tracebase-ai@latest serve --mcp` to refresh the install.",
            ),
          );
          process.exit(1);
        }
        // Surface the full error message to stderr so `tracebase doctor`
        // can capture it verbatim and display it alongside the FAIL.
        const msg = e instanceof Error ? e.message : String(e);
        console.error(pc.red("Error: ") + msg);
        process.exit(1);
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
