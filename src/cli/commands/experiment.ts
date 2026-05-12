/**
 * `tracebase experiment …` — manage the holdout experiment on this
 * local project. Phase 3.4 scope: config only. Serving uses the
 * resulting state through the explicit `buildHoldoutInput` helper,
 * never through globals.
 */
import { Command } from "commander";
import pc from "picocolors";
import {
  disableHoldoutExperiment,
  enableHoldoutExperiment,
  findConfigDir,
  readHoldoutConfig,
  resolveProjectBase,
  DEFAULT_HOLDOUT_RATE,
} from "../../core/config.js";
import type { HoldoutConfig } from "../../types.js";

function assertInitialized(path: string): string {
  const projectBase = resolveProjectBase(path);
  const configDir = findConfigDir(projectBase);
  if (!configDir) {
    console.error(pc.yellow("⚠ Not initialized. ") + "Run " + pc.cyan("npx tracebase-ai init") + " first.");
    process.exit(1);
  }
  // configDir is `<base>/.tracebase` — the owning project base is
  // its parent. Using that lets `experiment enable --path <nested>`
  // still write to the correct config.
  return configDir.replace(/\.tracebase\/?$/, "").replace(/\/$/, "") || configDir;
}

function parseRateArg(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 1) {
    throw new Error(`--rate must be in (0, 1]; got ${value}`);
  }
  return n;
}

function renderHoldout(label: string, h: HoldoutConfig): void {
  const state = h.enabled ? pc.green("enabled") : pc.yellow("disabled");
  const ratePct = (h.rate * 100).toFixed(h.rate < 0.1 ? 1 : 0);
  console.log(
    `  ${label.padEnd(10)} ${state}` +
      pc.dim(` rate=${ratePct}% salt=${h.salt.slice(0, 6)}…${h.salt.slice(-4)}`),
  );
  console.log(
    pc.dim(`             since ${h.createdAt} · updated ${h.updatedAt}`),
  );
}

export const experimentCommand = new Command("experiment")
  .description("Manage the deterministic holdout experiment on this project")
  .addCommand(
    new Command("enable")
      .description("Enable holdout cohort assignment at the given rate")
      .option("-p, --path <path>", "project root", process.cwd())
      .option("--rate <rate>", `holdout rate in (0, 1]; default ${DEFAULT_HOLDOUT_RATE}`, parseRateArg)
      .action((opts: { path: string; rate?: number }) => {
        const projectBase = assertInitialized(opts.path);
        try {
          const next = enableHoldoutExperiment(projectBase, {
            ...(opts.rate !== undefined ? { rate: opts.rate } : {}),
          });
          if (!next) {
            console.error(pc.yellow("⚠ Could not read .tracebase/config.json"));
            process.exit(1);
          }
          console.log();
          console.log(pc.bold("Holdout experiment enabled"));
          renderHoldout("holdout", next);
          console.log();
          console.log(
            pc.dim(
              "Serving will withhold a deterministic fraction of gate-eligible queries " +
                "from injection. Phase 3.5 surfaces the resulting causal comparison in the dashboard.",
            ),
          );
          console.log();
        } catch (e) {
          console.error(pc.red("Error: ") + (e instanceof Error ? e.message : String(e)));
          process.exit(1);
        }
      }),
  )
  .addCommand(
    new Command("disable")
      .description("Disable holdout cohort assignment (salt preserved for future re-enable)")
      .option("-p, --path <path>", "project root", process.cwd())
      .action((opts: { path: string }) => {
        const projectBase = assertInitialized(opts.path);
        const next = disableHoldoutExperiment(projectBase);
        console.log();
        if (!next) {
          console.log(pc.dim("  No holdout experiment configured."));
          console.log();
          return;
        }
        console.log(pc.bold("Holdout experiment disabled"));
        renderHoldout("holdout", next);
        console.log();
        console.log(
          pc.dim(
            "Re-enable any time with `npx tracebase-ai experiment enable` — the existing " +
              "salt is preserved so previously assigned fingerprints stay in their cohorts.",
          ),
        );
        console.log();
      }),
  )
  .addCommand(
    new Command("status")
      .description("Show the current holdout experiment state")
      .option("-p, --path <path>", "project root", process.cwd())
      .option("--json", "machine-readable JSON output")
      .action((opts: { path: string; json?: boolean }) => {
        const projectBase = assertInitialized(opts.path);
        const current = readHoldoutConfig(projectBase);
        if (opts.json) {
          process.stdout.write(
            JSON.stringify({ experiment: { holdout: current } }, null, 2) + "\n",
          );
          return;
        }
        console.log();
        console.log(pc.bold("TraceBase experiment"));
        if (!current) {
          console.log(pc.dim("  holdout    not configured"));
          console.log();
          console.log(pc.dim("  Enable with `npx tracebase-ai experiment enable`."));
          console.log();
          return;
        }
        renderHoldout("holdout", current);
        console.log();
      }),
  );
