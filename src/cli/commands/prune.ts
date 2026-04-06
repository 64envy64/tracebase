import { Command } from "commander";
import pc from "picocolors";
import { ReasoningLayer } from "../../core/engine.js";
import { loadConfig } from "../../core/config.js";

export const pruneCommand = new Command("prune")
  .description("Remove low-quality traces")
  .option(
    "-t, --threshold <score>",
    "quality score threshold (traces below this are removed)",
    "0.05",
  )
  .option("--dry-run", "show what would be pruned without removing")
  .action((opts: { threshold: string; dryRun?: boolean }) => {
    const config = loadConfig();
    const layer = new ReasoningLayer(config);

    try {
      const threshold = parseFloat(opts.threshold);
      const before = layer.count();

      if (opts.dryRun) {
        // Count what would be pruned
        const all = layer.exportAll();
        const wouldPrune = all.filter(
          (t) => t.quality.score < threshold && t.quality.recallCount > 0,
        );
        console.log(
          pc.yellow(`Would prune ${wouldPrune.length} of ${before} traces `) +
            pc.dim(`(threshold: ${threshold})`),
        );
        return;
      }

      const pruned = layer.prune(threshold);
      const after = layer.count();

      console.log(
        pc.green("✓") +
          ` Pruned ${pruned} trace${pruned === 1 ? "" : "s"} ` +
          pc.dim(`(${before} → ${after})`),
      );
    } finally {
      layer.close();
    }
  });
