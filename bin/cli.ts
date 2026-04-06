import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import pc from "picocolors";
import { initCommand } from "../src/cli/commands/init.js";
import { recallCommand } from "../src/cli/commands/recall.js";
import { searchCommand } from "../src/cli/commands/search.js";
import { statsCommand } from "../src/cli/commands/stats.js";
import { serveCommand } from "../src/cli/commands/serve.js";
import { exportCommand, importCommand } from "../src/cli/commands/transfer.js";
import { pruneCommand } from "../src/cli/commands/prune.js";
import { storeCommand } from "../src/cli/commands/store.js";

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

program.addCommand(initCommand);
program.addCommand(storeCommand);
program.addCommand(recallCommand);
program.addCommand(searchCommand);
program.addCommand(statsCommand);
program.addCommand(serveCommand);
program.addCommand(exportCommand);
program.addCommand(importCommand);
program.addCommand(pruneCommand);

program.parse();
