import { Command } from "commander";
import pc from "picocolors";
import { initConfig, isInitialized } from "../../core/config.js";

export const initCommand = new Command("init")
  .description("Initialize TraceBase in the current project")
  .option("-p, --path <path>", "base path", process.cwd())
  .option("--force", "overwrite existing configuration")
  .action((opts: { path: string; force?: boolean }) => {
    const basePath = opts.path;

    if (isInitialized(basePath) && !opts.force) {
      console.log(
        pc.yellow("⚠") + " TraceBase is already initialized in this directory.",
      );
      console.log(pc.dim("  Use --force to reinitialize."));
      return;
    }

    const config = initConfig(basePath);

    console.log(pc.green("✓") + " TraceBase initialized!");
    console.log();
    console.log(pc.dim("  Config:  ") + ".tracebase/config.json");
    console.log(pc.dim("  Storage: ") + config.storagePath);
    console.log();
    console.log(pc.dim("  Add to .gitignore:"));
    console.log(pc.dim("    .tracebase/memory.db"));
    console.log(pc.dim("    .tracebase/memory.db-wal"));
    console.log(pc.dim("    .tracebase/memory.db-shm"));
    console.log();
    console.log(
      "  Next: " +
        pc.cyan("tracebase store") +
        " or integrate with the SDK.",
    );
  });
