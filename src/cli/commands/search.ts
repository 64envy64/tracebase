import { Command } from "commander";
import pc from "picocolors";
import { ReasoningLayer } from "../../core/engine.js";
import { loadConfig } from "../../core/config.js";

export const searchCommand = new Command("search")
  .description("Full-text search through stored traces")
  .argument("<query>", "search query")
  .option("-n, --limit <n>", "max results", "10")
  .option("--json", "output as JSON")
  .action((query: string, opts) => {
    const config = loadConfig();
    const layer = new ReasoningLayer(config);

    try {
      const results = layer.search(query, parseInt(opts.limit, 10));

      if (opts.json) {
        console.log(JSON.stringify(results, null, 2));
        return;
      }

      if (results.length === 0) {
        console.log(pc.yellow("No results found."));
        return;
      }

      console.log(pc.bold(`${results.length} result${results.length === 1 ? "" : "s"}:\n`));

      for (const [i, trace] of results.entries()) {
        const outcomeColor =
          trace.solution.outcome === "success"
            ? pc.green
            : trace.solution.outcome === "failure"
              ? pc.red
              : pc.yellow;

        console.log(
          `${pc.dim(`${i + 1}.`)} ${outcomeColor(`[${trace.solution.outcome}]`)} ${pc.bold(trace.solution.summary)}`,
        );
        console.log(`   ${pc.dim(trace.problem.description.slice(0, 120))}`);

        const meta = [
          trace.problem.language,
          trace.problem.framework,
          trace.problem.errorType,
        ]
          .filter(Boolean)
          .join(" · ");
        if (meta) console.log(`   ${pc.dim(meta)}`);

        console.log(
          `   ${pc.dim(`quality: ${trace.quality.score.toFixed(2)}`)} ${pc.dim(`id: ${trace.id}`)}`,
        );
        console.log();
      }
    } finally {
      layer.close();
    }
  });
