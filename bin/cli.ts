import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import { initCommand } from "../src/cli/commands/init.js";
import { injectContextCommand } from "../src/cli/commands/inject-context.js";
import { captureTurnCommand } from "../src/cli/commands/capture-turn.js";
import { captureContextCommand } from "../src/cli/commands/capture-context.js";
import { captureToolUseCommand } from "../src/cli/commands/capture-tool-use.js";
import { removeCommand } from "../src/cli/commands/remove.js";
import { recallCommand } from "../src/cli/commands/recall.js";
import { searchCommand } from "../src/cli/commands/search.js";
import { statsCommand } from "../src/cli/commands/stats.js";
import { serveCommand } from "../src/cli/commands/serve.js";
import { exportCommand, importCommand } from "../src/cli/commands/transfer.js";
import { pruneCommand } from "../src/cli/commands/prune.js";
import { storeCommand } from "../src/cli/commands/store.js";
import { setupCommand } from "../src/cli/commands/setup.js";
import { explainCommand } from "../src/cli/commands/explain.js";
import { seedCommand } from "../src/cli/commands/seed.js";
import { syncCommand } from "../src/cli/commands/sync.js";
import { statusCommand } from "../src/cli/commands/status.js";
import { doctorCommand } from "../src/cli/commands/doctor.js";
import { eventsCommand } from "../src/cli/commands/events.js";
import { reportCommand } from "../src/cli/commands/report.js";
import { usageCommand } from "../src/cli/commands/usage.js";
// 0.6.1 — `experimentCommand` is no longer surfaced on the CLI.
// Users opt INTO verified mode via `tracebase init --holdout-rate
// <rate>`. The experiment-config helpers in `src/core/config.ts`
// (enable / disable / read) stay exported for programmatic use.
import { memoryCommand } from "../src/cli/commands/memory.js";
import { impactCommand } from "../src/cli/commands/impact.js";
import { isInitialized } from "../src/core/config.js";

// Read version from package.json at runtime
const pkgPath = join(__dirname, "..", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };

const program = new Command();

program
  .name("tracebase")
  .description(
    pc.bold("TraceBase") +
      " — Reasoning layer for AI agents.\n" +
      pc.dim("Your agents never solve the same problem twice."),
  )
  .version(pkg.version);

program.addCommand(setupCommand);
program.addCommand(initCommand);
program.addCommand(removeCommand);
program.addCommand(storeCommand);
program.addCommand(recallCommand);
program.addCommand(searchCommand);
program.addCommand(statsCommand);
program.addCommand(serveCommand);
program.addCommand(exportCommand);
program.addCommand(importCommand);
program.addCommand(pruneCommand);
program.addCommand(explainCommand);
program.addCommand(seedCommand);
program.addCommand(syncCommand);
program.addCommand(statusCommand);
program.addCommand(doctorCommand);
program.addCommand(eventsCommand);
program.addCommand(reportCommand);
program.addCommand(usageCommand);
// 0.6.1 — experimentCommand intentionally NOT registered (see import note above).
program.addCommand(injectContextCommand);
program.addCommand(captureTurnCommand);
program.addCommand(captureContextCommand);
program.addCommand(captureToolUseCommand);
program.addCommand(memoryCommand);
program.addCommand(impactCommand);

// No args → guided quickstart instead of generic help
if (process.argv.length <= 2) {
  console.log();
  console.log(pc.bold("TraceBase") + ` v${pkg.version}` + pc.dim(" — reasoning layer for AI agents"));
  console.log();

  if (!isInitialized()) {
    console.log(pc.yellow("Not initialized.") + " Run this to get started:\n");
    console.log(`  ${pc.cyan("npx tracebase init")}    ${pc.dim("Auto-detect your agent (Claude Code / Cursor / Codex) and wire it up")}`);
    console.log();
  } else {
    console.log(pc.green("Initialized.") + " Common commands:\n");
    console.log(`  ${pc.cyan("tracebase recall")} ${pc.dim('"query"')}    ${pc.dim("Find past solutions")}`);
    console.log(`  ${pc.cyan("tracebase store")} ${pc.dim("-d ... -s ...")}  ${pc.dim("Save a solution")}`);
    console.log(`  ${pc.cyan("tracebase explain")} ${pc.dim('"query"')}  ${pc.dim("See ranking breakdown")}`);
    console.log(`  ${pc.cyan("tracebase stats")}              ${pc.dim("Storage overview")}`);
    console.log(`  ${pc.cyan("tracebase seed")} ${pc.dim("install ...")}   ${pc.dim("Install knowledge packs")}`);
    console.log(`  ${pc.cyan("tracebase sync")} ${pc.dim("export/import")} ${pc.dim("Team knowledge sharing")}`);
    console.log();
    console.log(pc.dim("Run `tracebase --help` for all commands."));
  }
  console.log();
} else {
  program.parse();
}
