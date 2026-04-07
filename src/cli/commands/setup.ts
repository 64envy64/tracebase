import { Command } from "commander";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import pc from "picocolors";
import { initConfig, isInitialized } from "../../core/config.js";

/** IDE MCP config locations. */
const IDE_CONFIGS: Array<{
  name: string;
  configPath: string;
  configKey: string;
}> = [
  {
    name: "Claude Code",
    configPath: join(homedir(), ".claude", "claude_desktop_config.json"),
    configKey: "mcpServers",
  },
  {
    name: "Cursor",
    configPath: join(homedir(), ".cursor", "mcp.json"),
    configKey: "mcpServers",
  },
  {
    name: "Windsurf",
    configPath: join(homedir(), ".codeium", "windsurf", "mcp_config.json"),
    configKey: "mcpServers",
  },
];

const MCP_ENTRY = {
  command: "npx",
  args: ["-y", "tracebase-ai", "serve", "--mcp"],
};

export const setupCommand = new Command("setup")
  .description("Auto-configure TraceBase for all detected AI IDEs")
  .option("--force", "overwrite existing MCP config entries")
  .option("--dry-run", "show what would be configured without writing")
  .action((opts: { force?: boolean; dryRun?: boolean }) => {
    const cwd = process.cwd();

    console.log();
    console.log(pc.bold("TraceBase Setup"));
    console.log();

    // Step 1: Initialize project if needed
    if (!isInitialized(cwd)) {
      if (opts.dryRun) {
        console.log(pc.dim("  Would initialize .tracebase/ in current directory"));
      } else {
        initConfig(cwd);
        console.log(pc.green("  +") + " Initialized .tracebase/ in current directory");
      }
    } else {
      console.log(pc.dim("  .tracebase/ already initialized"));
    }

    console.log();

    // Step 2: Detect and configure IDEs
    let configured = 0;
    let skipped = 0;

    for (const ide of IDE_CONFIGS) {
      const dir = join(ide.configPath, "..");

      // Check if IDE directory exists (IDE is installed)
      if (!existsSync(dir)) {
        continue; // IDE not installed, skip silently
      }

      // Read or create config
      let config: Record<string, unknown> = {};
      if (existsSync(ide.configPath)) {
        try {
          config = JSON.parse(readFileSync(ide.configPath, "utf-8")) as Record<string, unknown>;
        } catch {
          config = {};
        }
      }

      // Check if already configured
      const servers = (config[ide.configKey] ?? {}) as Record<string, unknown>;
      if (servers["tracebase"] && !opts.force) {
        console.log(pc.dim(`  ${ide.name}`) + pc.dim(" — already configured"));
        skipped++;
        continue;
      }

      // Configure
      servers["tracebase"] = MCP_ENTRY;
      config[ide.configKey] = servers;

      if (opts.dryRun) {
        console.log(pc.dim(`  Would configure ${ide.name}: ${ide.configPath}`));
        configured++;
        continue;
      }

      mkdirSync(dir, { recursive: true });
      writeFileSync(ide.configPath, JSON.stringify(config, null, 2) + "\n");
      console.log(pc.green("  +") + ` ${ide.name} ${pc.dim(ide.configPath)}`);
      configured++;
    }

    if (configured === 0 && skipped === 0) {
      console.log(pc.dim("  No supported IDEs detected."));
      console.log(pc.dim("  Supported: Claude Code, Cursor, Windsurf"));
      console.log();
      console.log(pc.dim("  Manual setup:"));
      console.log(pc.dim(`    npx tracebase serve --mcp`));
      console.log();
    } else {
      console.log();
      if (configured > 0) {
        console.log(
          pc.green("  Done.") +
          ` Configured ${configured} IDE${configured === 1 ? "" : "s"}.` +
          (skipped > 0 ? ` ${skipped} already set up.` : ""),
        );
      } else {
        console.log(pc.dim(`  All ${skipped} IDEs already configured.`));
      }
      console.log(pc.dim("  Restart your IDE to activate TraceBase."));
    }
    console.log();
  });
