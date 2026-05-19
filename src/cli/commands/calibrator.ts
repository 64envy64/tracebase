/**
 * `tracebase calibrator` — fit, inspect, or drop the isotonic block
 * calibrator that turns raw FTS5 maxRel-normalized scores into a
 * calibrated P(helpful).
 *
 * Two subcommands, no daemon:
 *
 *   tracebase calibrator fit       — read events, fit, persist, exit.
 *                                    Production refits happen in-process
 *                                    on the MCP server via the auto-refit
 *                                    loop; this CLI is the manual lever
 *                                    + the bootstrap path for fresh
 *                                    deployments.
 *
 *   tracebase calibrator status    — show the loaded model: name, fit
 *                                    time, sample size, knot count.
 *                                    What the dashboard needs to render
 *                                    "the calibrator was last updated N
 *                                    minutes ago from M outcomes".
 *
 * Deliberately not implemented:
 *
 *   • A `--watch` polling loop. The MCP server already refits in-process
 *     on every `record_reasoning_outcome` once enough fresh evidence has
 *     landed. A separate poll outside the server would race with that
 *     loop and write stale models on top of fresh ones. If you need
 *     refit-driven-from-CLI, run `fit` from your scheduler — that
 *     ALSO benefits the MCP server because `loadCalibrator` reads the
 *     same row.
 *
 *   • A `--drop` / `--reset`. Restoring identity behavior is a single
 *     SQL `DELETE FROM calibrator_models WHERE name = 'isotonic.block.v1'`;
 *     wrapping that in a flag invites accidental wipes. If a calibrator
 *     went bad, you want to look at the model before deleting it —
 *     that's `status` first, then a deliberate SQL delete.
 */
import { Command } from "commander";
import pc from "picocolors";
import Database from "better-sqlite3";
import { findProjectRoot, loadConfig } from "../../core/config.js";
import { BlockStore } from "../../core/block-store.js";
import {
  BLOCK_CALIBRATOR_NAME,
  fitAndSaveBlockCalibrator,
} from "../../lifecycle/calibrator.js";
import type { IsotonicModel } from "../../lifecycle/isotonic.js";

interface FitOptions {
  path: string;
  minSample?: string;
  after?: string;
  json?: boolean;
}

interface StatusOptions {
  path: string;
  json?: boolean;
}

const fitSubcommand = new Command("fit")
  .description("Fit the isotonic calibrator from the event log and persist it.")
  .option("-p, --path <path>", "project root", process.cwd())
  .option(
    "--min-sample <n>",
    "minimum (injection,outcome) pair count required to fit (default 20)",
  )
  .option("--after <iso>", "only use outcomes after this ISO timestamp")
  .option("--json", "machine-readable JSON output")
  .action((opts: FitOptions) => {
    const projectRoot = findProjectRoot(opts.path);
    if (!projectRoot) {
      fatal("Not initialized in this directory. Run `npx tracebase-ai init` first.");
    }
    const cfg = loadConfig(opts.path);
    const db = new Database(cfg.storagePath);
    const store = new BlockStore(db);
    let model: IsotonicModel | null = null;
    try {
      const fitOpts: {
        minSample?: number;
        afterTs?: number;
      } = {};
      if (opts.minSample !== undefined) {
        const n = Number(opts.minSample);
        if (!Number.isFinite(n) || n < 1) {
          fatal(`--min-sample must be a positive integer; got ${opts.minSample}`);
        }
        fitOpts.minSample = n;
      }
      if (opts.after !== undefined) {
        const ts = Date.parse(opts.after);
        if (!Number.isFinite(ts)) {
          fatal(`--after must be a parseable ISO timestamp; got ${opts.after}`);
        }
        fitOpts.afterTs = ts;
      }
      model = fitAndSaveBlockCalibrator(store, fitOpts);
    } finally {
      store.close();
    }

    if (opts.json) {
      process.stdout.write(
        JSON.stringify({ fitted: model !== null, model }, null, 2) + "\n",
      );
      return;
    }

    if (!model) {
      console.log(
        pc.yellow("Skipped.") +
          " Sample size below threshold — record more outcomes before fitting.",
      );
      console.log(
        pc.dim(
          "  (Each `record_reasoning_outcome` call adds one training pair when its query received an injection.)",
        ),
      );
      return;
    }

    console.log(pc.green("Fitted.") + " Calibrator persisted.");
    console.log(pc.dim("  name:              ") + BLOCK_CALIBRATOR_NAME);
    console.log(pc.dim("  fitted at:         ") + new Date(model.fittedAt).toISOString());
    console.log(pc.dim("  breakpoint count:  ") + String(model.breakpoints.length));
    console.log(pc.dim("  sample size:       ") + String(model.n));
  });

const statusSubcommand = new Command("status")
  .description("Show the loaded calibrator's fit time, sample size, and knot count.")
  .option("-p, --path <path>", "project root", process.cwd())
  .option("--json", "machine-readable JSON output")
  .action((opts: StatusOptions) => {
    const projectRoot = findProjectRoot(opts.path);
    if (!projectRoot) {
      fatal("Not initialized in this directory. Run `npx tracebase-ai init` first.");
    }
    const cfg = loadConfig(opts.path);
    const db = new Database(cfg.storagePath, { readonly: true });
    let model: IsotonicModel | null = null;
    let names: Array<{ name: string; fittedAt: number }> = [];
    try {
      const store = new BlockStore(db, { skipMigrate: true });
      try {
        model = store.loadCalibrator<IsotonicModel>(BLOCK_CALIBRATOR_NAME);
        names = store.listCalibratorNames();
      } finally {
        store.close();
      }
    } finally {
      if (db.open) db.close();
    }

    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          {
            loaded: model !== null,
            calibrator: BLOCK_CALIBRATOR_NAME,
            model,
            allNames: names,
          },
          null,
          2,
        ) + "\n",
      );
      return;
    }

    if (!model) {
      console.log(pc.yellow("No calibrator fitted yet.") + " Identity calibration is in effect.");
      console.log(
        pc.dim(
          "  Production gate is held at DEFAULT_GATE_THRESHOLD (0.4) — weak single-hit matches pass through. Run `tracebase calibrator fit` once you have ≥20 outcomes recorded.",
        ),
      );
      return;
    }

    console.log(pc.green("Loaded.") + ` ${BLOCK_CALIBRATOR_NAME}`);
    console.log(pc.dim("  fitted at:         ") + new Date(model.fittedAt).toISOString());
    console.log(pc.dim("  sample size:       ") + String(model.n));
    console.log(pc.dim("  breakpoint count:  ") + String(model.breakpoints.length));
    if (model.breakpoints.length > 0) {
      const first = model.breakpoints[0]!;
      const last = model.breakpoints[model.breakpoints.length - 1]!;
      console.log(
        pc.dim("  range:             ") +
          `x ∈ [${first.x.toFixed(3)}, ${last.x.toFixed(3)}]  ` +
          `y ∈ [${first.y.toFixed(3)}, ${last.y.toFixed(3)}]`,
      );
    }
    if (names.length > 1) {
      console.log(
        pc.dim("  other names: ") +
          names
            .filter((n) => n.name !== BLOCK_CALIBRATOR_NAME)
            .map((n) => n.name)
            .join(", "),
      );
    }
  });

export const calibratorCommand = new Command("calibrator")
  .description("Fit, inspect, or manage the isotonic block calibrator.")
  .addCommand(fitSubcommand)
  .addCommand(statusSubcommand);

function fatal(msg: string): never {
  console.error(pc.red("Error: ") + msg);
  process.exit(1);
}
