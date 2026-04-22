import { Command } from "commander";
import pc from "picocolors";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ReasoningLayer } from "../../core/engine.js";
import { loadConfig } from "../../core/config.js";
import { writeJsonl, readJsonl } from "../../kb/jsonl.js";

/**
 * Sync command — Institutional Knowledge Base.
 *
 * Git-based team sync using JSONL format. Export traces to a shared file
 * that lives in your repo, commit to git, teammates import. Traces are
 * tagged with provenance.origin = "team" for transparency.
 *
 * Usage:
 *   tracebase sync export                    # export to .tracebase-shared.jsonl
 *   tracebase sync export ./shared/kb.jsonl  # export to custom path
 *   tracebase sync import ./shared/kb.jsonl  # merge teammate's traces
 *   tracebase sync status                    # show local vs shared diff
 */

const DEFAULT_SYNC_FILE = ".tracebase-shared.jsonl";

export const syncCommand = new Command("sync")
  .description("Team knowledge sharing (Institutional KB)")
  .addCommand(
    new Command("export")
      .description("Export traces to JSONL for team sharing")
      .argument("[file]", "output file path", DEFAULT_SYNC_FILE)
      .option("--since <date>", "Only export traces created after this date (ISO 8601)")
      .option("--success-only", "Only export successful traces", true)
      .action(async (file: string, opts) => {
        const config = loadConfig();
        const layer = new ReasoningLayer(config);

        try {
          let traces = layer.exportAll();

          if (opts.successOnly) {
            traces = traces.filter((t) => t.solution.outcome === "success");
          }

          if (opts.since) {
            const sinceTs = new Date(opts.since).getTime();
            traces = traces.filter((t) => t.createdAt >= sinceTs);
          }

          // Set provenance for team sharing
          for (const trace of traces) {
            if (!trace.provenance) {
              trace.provenance = { origin: "team", appliedCount: 0 };
            }
            if (trace.provenance.origin === "local") {
              trace.provenance.origin = "team";
            }
          }

          const outPath = resolve(file);
          writeJsonl(traces, outPath);

          console.log(pc.green(`Exported ${traces.length} traces`) + pc.dim(` → ${outPath}`));
          console.log(pc.dim("\nCommit this file to git so your team can import it:"));
          console.log(pc.dim(`  git add ${file}`));
          console.log(pc.dim(`  git commit -m "Update shared knowledge base"`));
        } finally {
          layer.close();
        }
      }),
  )
  .addCommand(
    new Command("import")
      .description("Import traces from a team JSONL file")
      .argument("<file>", "JSONL file to import")
      .option("--dry-run", "Preview what would be imported without changing anything")
      .action(async (file: string, opts) => {
        const filePath = resolve(file);
        if (!existsSync(filePath)) {
          console.log(pc.red(`File not found: ${filePath}`));
          return;
        }

        const config = loadConfig();
        const layer = new ReasoningLayer(config);

        try {
          const traces = await readJsonl(filePath);

          if (traces.length === 0) {
            console.log(pc.yellow("No valid traces found in file."));
            return;
          }

          // Ensure provenance is set for team imports
          for (const trace of traces) {
            if (!trace.provenance) {
              trace.provenance = { origin: "team", appliedCount: 0 };
            }
          }

          if (opts.dryRun) {
            // Count how many would be new
            const existingIds = new Set(layer.exportAll().map((t) => t.id));
            const newTraces = traces.filter((t) => !existingIds.has(t.id));
            console.log(pc.dim(`Dry run: would import ${newTraces.length} new traces (${traces.length - newTraces.length} duplicates)`));
            return;
          }

          const imported = layer.importTraces(traces);

          console.log(pc.green(`Imported ${imported} new traces`) + pc.dim(` (${traces.length - imported} duplicates skipped)`));
        } finally {
          layer.close();
        }
      }),
  )
  .addCommand(
    new Command("status")
      .description("Show sync status — local traces vs shared file")
      .argument("[file]", "shared JSONL file to compare against", DEFAULT_SYNC_FILE)
      .action(async (file: string) => {
        const config = loadConfig();
        const layer = new ReasoningLayer(config);
        const filePath = resolve(file);

        try {
          const localTraces = layer.exportAll();
          const localIds = new Set(localTraces.map((t) => t.id));

          if (!existsSync(filePath)) {
            console.log(pc.dim(`No shared file found at ${filePath}`));
            console.log(pc.dim(`  Run: tracebase sync export`));
            console.log();
            console.log(`  ${pc.bold("Local:")} ${localTraces.length} traces`);
            return;
          }

          const sharedTraces = await readJsonl(filePath);
          const sharedIds = new Set(sharedTraces.map((t) => t.id));

          const onlyLocal = localTraces.filter((t) => !sharedIds.has(t.id));
          const onlyShared = sharedTraces.filter((t) => !localIds.has(t.id));
          const shared = localTraces.filter((t) => sharedIds.has(t.id));

          console.log(pc.bold("Sync Status:\n"));
          console.log(`  ${pc.bold("Local:")} ${localTraces.length} traces`);
          console.log(`  ${pc.bold("Shared:")} ${sharedTraces.length} traces`);
          console.log(`  ${pc.green(`+${onlyLocal.length}`)} only in local (would be added on export)`);
          console.log(`  ${pc.cyan(`+${onlyShared.length}`)} only in shared (would be added on import)`);
          console.log(`  ${pc.dim(`${shared.length} in both`)}`);

          if (onlyShared.length > 0) {
            console.log(pc.dim(`\n  Run: tracebase sync import ${file}`));
          }
          if (onlyLocal.length > 0) {
            console.log(pc.dim(`  Run: tracebase sync export ${file}`));
          }
        } finally {
          layer.close();
        }
      }),
  );
