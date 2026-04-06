import { Command } from "commander";
import { readFileSync, writeFileSync } from "node:fs";
import pc from "picocolors";
import { ReasoningLayer } from "../../core/engine.js";
import { loadConfig } from "../../core/config.js";
import type { ReasoningTrace } from "../../types.js";

export const exportCommand = new Command("export")
  .description("Export all traces to a JSON file")
  .argument("[file]", "output file path", "tracebase-export.json")
  .option("--pretty", "pretty-print JSON")
  .action((file: string, opts: { pretty?: boolean }) => {
    const config = loadConfig();
    const layer = new ReasoningLayer(config);

    try {
      const traces = layer.exportAll();
      const json = opts.pretty
        ? JSON.stringify(traces, null, 2)
        : JSON.stringify(traces);
      writeFileSync(file, json + "\n");

      console.log(
        pc.green("✓") + ` Exported ${traces.length} traces to ${pc.cyan(file)}`,
      );
    } finally {
      layer.close();
    }
  });

export const importCommand = new Command("import")
  .description("Import traces from a JSON file")
  .argument("<file>", "input file path")
  .action((file: string) => {
    const config = loadConfig();
    const layer = new ReasoningLayer(config);

    try {
      const raw = readFileSync(file, "utf-8");
      const traces = JSON.parse(raw) as ReasoningTrace[];

      if (!Array.isArray(traces)) {
        console.error(pc.red("Error: ") + "File must contain a JSON array of traces.");
        process.exit(1);
      }

      const imported = layer.importTraces(traces);
      console.log(
        pc.green("✓") +
          ` Imported ${imported} new trace${imported === 1 ? "" : "s"} (${traces.length - imported} duplicates skipped)`,
      );
    } finally {
      layer.close();
    }
  });
