import { Command } from "commander";
import pc from "picocolors";
import { ReasoningLayer } from "../../core/engine.js";
import { loadConfig } from "../../core/config.js";

export const recallCommand = new Command("recall")
  .description("Find relevant past solutions for a problem")
  .argument("<problem>", "problem description")
  .option("-n, --limit <n>", "max results", "5")
  .option("-m, --min-score <score>", "minimum similarity score", "0.1")
  .option("-l, --language <lang>", "filter by language")
  .option("-f, --framework <fw>", "filter by framework")
  .option("-e, --error-type <type>", "filter by error type")
  .option("--json", "output as JSON")
  .action((problem: string, opts) => {
    const config = loadConfig();
    const layer = new ReasoningLayer(config);

    try {
      const results = layer.recall({
        problem,
        limit: parseInt(opts.limit, 10),
        minScore: parseFloat(opts.minScore),
        context: {
          language: opts.language,
          framework: opts.framework,
          errorType: opts.errorType,
        },
      });

      if (opts.json) {
        console.log(JSON.stringify(results, null, 2));
        return;
      }

      if (results.length === 0) {
        console.log(pc.yellow("No matching traces found."));
        console.log(pc.dim("  Tip: store solutions with `tracebase store`"));
        return;
      }

      console.log(
        pc.bold(`Found ${results.length} relevant trace${results.length === 1 ? "" : "s"}:\n`),
      );

      for (const [i, result] of results.entries()) {
        const { trace, score, matchType } = result;
        const matchColor =
          matchType === "exact"
            ? pc.green
            : matchType === "similar"
              ? pc.cyan
              : pc.yellow;

        console.log(
          `${pc.dim(`${i + 1}.`)} ${matchColor(`[${matchType}]`)} ` +
            `${pc.dim(`score:${score.toFixed(2)}`)}`,
        );
        console.log(`   ${pc.bold(trace.solution.summary)}`);
        console.log(`   ${pc.dim(trace.problem.description.slice(0, 120))}`);

        if (trace.problem.language || trace.problem.framework) {
          const parts = [trace.problem.language, trace.problem.framework]
            .filter(Boolean)
            .join(", ");
          console.log(`   ${pc.dim(parts)}`);
        }

        if (trace.solution.outcome !== "success") {
          console.log(`   ${pc.red(`outcome: ${trace.solution.outcome}`)}`);
        }

        console.log(`   ${pc.dim(`id: ${trace.id}`)}`);
        console.log();
      }
    } finally {
      layer.close();
    }
  });
