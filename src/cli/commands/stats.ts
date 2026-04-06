import { Command } from "commander";
import pc from "picocolors";
import { ReasoningLayer } from "../../core/engine.js";
import { loadConfig } from "../../core/config.js";

export const statsCommand = new Command("stats")
  .description("Show storage statistics")
  .option("--json", "output as JSON")
  .action((opts) => {
    const config = loadConfig();
    const layer = new ReasoningLayer(config);

    try {
      const s = layer.stats();

      if (opts.json) {
        console.log(JSON.stringify(s, null, 2));
        return;
      }

      console.log(pc.bold("TraceBase Statistics\n"));

      console.log(pc.dim("  Traces"));
      console.log(`    Total:      ${pc.bold(String(s.totalTraces))}`);
      console.log(`    Successful: ${pc.green(String(s.successfulTraces))}`);
      console.log(`    Failed:     ${pc.red(String(s.failedTraces))}`);
      console.log(`    Partial:    ${pc.yellow(String(s.partialTraces))}`);
      console.log();

      console.log(pc.dim("  Quality"));
      console.log(`    Avg score:    ${s.avgQualityScore.toFixed(3)}`);
      console.log(`    Total recalls: ${s.totalRecalls}`);
      console.log(`    Helpful:       ${s.totalHelpful}`);
      if (s.totalRecalls > 0) {
        const rate = ((s.totalHelpful / s.totalRecalls) * 100).toFixed(1);
        console.log(`    Helpful rate:  ${rate}%`);
      }
      console.log();

      if (s.topLanguages.length > 0) {
        console.log(pc.dim("  Languages"));
        for (const l of s.topLanguages.slice(0, 5)) {
          console.log(`    ${l.language}: ${l.count}`);
        }
        console.log();
      }

      if (s.topFrameworks.length > 0) {
        console.log(pc.dim("  Frameworks"));
        for (const f of s.topFrameworks.slice(0, 5)) {
          console.log(`    ${f.framework}: ${f.count}`);
        }
        console.log();
      }

      if (s.topErrorTypes.length > 0) {
        console.log(pc.dim("  Error Types"));
        for (const e of s.topErrorTypes.slice(0, 5)) {
          console.log(`    ${e.errorType}: ${e.count}`);
        }
        console.log();
      }

      console.log(pc.dim("  Storage"));
      console.log(`    DB size: ${formatBytes(s.dbSizeBytes)}`);
      if (s.oldestTrace) {
        console.log(`    Oldest:  ${new Date(s.oldestTrace).toLocaleDateString()}`);
      }
      if (s.newestTrace) {
        console.log(`    Newest:  ${new Date(s.newestTrace).toLocaleDateString()}`);
      }
    } finally {
      layer.close();
    }
  });

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(1)} ${units[i]}`;
}
