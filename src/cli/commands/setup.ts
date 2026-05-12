/**
 * `tracebase setup` — legacy alias for `tracebase init`.
 *
 * Earlier releases treated `setup` as a separate "auto-configure every
 * IDE" command. `init` now does that natively: it auto-detects the
 * running agent, or — on a cold terminal — configures every
 * locally-installed agent. Keeping `setup` as a thin alias means old
 * docs and shell history still work.
 */
import { Command } from "commander";
import pc from "picocolors";
import { initCommand } from "./init.js";

export const setupCommand = new Command("setup")
  .description("Alias for `tracebase init` — kept for back-compat")
  .option("-p, --path <path>", "project root", process.cwd())
  .option("-a, --agent <agent>", "restrict install to one agent: claude-code | cursor | codex")
  .option("--api-url <url>", "TraceBase hosted control-plane origin (or use TRACEBASE_API_URL)")
  .option("--api-key <key>", "TraceBase workspace API key (or use TRACEBASE_API_KEY)")
  .option("--force", "overwrite an existing tracebase MCP entry with a different shape")
  .option("--dry-run", "ignored — kept for back-compat")
  .action(async (opts: {
    path: string;
    agent?: string;
    apiUrl?: string;
    apiKey?: string;
    force?: boolean;
    dryRun?: boolean;
  }) => {
    if (opts.dryRun) {
      console.log(pc.yellow("  --dry-run is no longer supported. Run `npx tracebase-ai init` directly."));
      return;
    }
    const args: string[] = [];
    if (opts.path) args.push("-p", opts.path);
    if (opts.agent) args.push("-a", opts.agent);
    if (opts.apiUrl) args.push("--api-url", opts.apiUrl);
    if (opts.apiKey) args.push("--api-key", opts.apiKey);
    if (opts.force) args.push("--force");
    await initCommand.parseAsync(args, { from: "user" });
  });
