/**
 * `tracebase canary …` — operate the explicit opt-in applicability canary
 * (Phase D.4). Apply-only: exposes the reranker-selected block when baseline V4
 * abstains, to a bounded, deterministically-assigned sample. DEFAULT OFF.
 *
 * Activation requires an EXPLICIT command with a rate AND a policy
 * acknowledgement (`--ack <policyVersion>`) — there is no accidental path on.
 * `disable` is the crash-safe emergency stop; `preview` is a read-only dry run.
 */
import { Command } from "commander";
import pc from "picocolors";
import {
  enableApplicabilityCanary,
  disableApplicabilityCanary,
  readApplicabilityCanaryConfig,
  resolveCanaryServingState,
  findConfigDir,
  resolveProjectBase,
  DEFAULT_CANARY_RATE,
  CANARY_POLICY_VERSION,
  APPLICABILITY_CANARY_KILL_ENV,
} from "../../core/config.js";
import type { ApplicabilityCanaryConfig } from "../../types.js";

function assertInitialized(path: string): string {
  const projectBase = resolveProjectBase(path);
  const configDir = findConfigDir(projectBase);
  if (!configDir) {
    console.error(pc.yellow("⚠ Not initialized. ") + "Run " + pc.cyan("npx tracebase-ai init") + " first.");
    process.exit(1);
  }
  return configDir.replace(/\.tracebase\/?$/, "").replace(/\/$/, "") || configDir;
}

function parseRateArg(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 1) throw new Error(`--rate must be in (0, 1]; got ${value}`);
  return n;
}

function renderCanary(c: ApplicabilityCanaryConfig): void {
  const state = c.enabled ? pc.green("enabled") : pc.yellow("disabled");
  const ratePct = (c.rate * 100).toFixed(c.rate < 0.1 ? 2 : 0);
  const serving = resolveCanaryServingState(c);
  console.log(`  canary     ${state}` + pc.dim(` rate=${ratePct}% policy=${c.policyVersion} salt=${c.salt.slice(0, 6)}…`));
  console.log(pc.dim(`             effective: ${serving.enabled ? pc.red("LIVE — exposing") : "not exposing"}${serving.killReason ? ` (${serving.killReason})` : ""}`));
  console.log(pc.dim(`             since ${c.createdAt} · updated ${c.updatedAt}`));
}

export const canaryCommand = new Command("canary")
  .description("Operate the explicit opt-in applicability canary (apply-only; default OFF)")
  .addCommand(
    new Command("enable")
      .description("ACTIVATE the canary — requires --ack of the policy version")
      .option("-p, --path <path>", "project root", process.cwd())
      .option("--rate <rate>", `treatment rate in (0, 1]; default ${DEFAULT_CANARY_RATE}`, parseRateArg)
      .requiredOption("--ack <policyVersion>", `acknowledge the policy being served (must equal ${CANARY_POLICY_VERSION})`)
      .action((opts: { path: string; rate?: number; ack: string }) => {
        const projectBase = assertInitialized(opts.path);
        try {
          const next = enableApplicabilityCanary(projectBase, {
            policyAck: opts.ack,
            ...(opts.rate !== undefined ? { rate: opts.rate } : {}),
          });
          if (!next) {
            console.error(pc.yellow("⚠ Could not read .tracebase/config.json"));
            process.exit(1);
          }
          console.log();
          console.log(pc.bold(pc.red("⚠ Applicability canary ENABLED — it will serve injections to a bounded sample")));
          renderCanary(next);
          console.log();
          console.log(pc.dim("Apply-only: exposes the reranker block when V4 abstains. Requires TRACEBASE_REASONING_APPLICABILITY=shadow to have a verdict."));
          console.log(pc.dim(`Emergency stop: \`npx tracebase-ai canary disable\` or ${APPLICABILITY_CANARY_KILL_ENV}=off`));
          console.log();
        } catch (e) {
          console.error(pc.red("Error: ") + (e instanceof Error ? e.message : String(e)));
          process.exit(1);
        }
      }),
  )
  .addCommand(
    new Command("disable")
      .description("Emergency stop — disable the canary (salt preserved)")
      .option("-p, --path <path>", "project root", process.cwd())
      .action((opts: { path: string }) => {
        const projectBase = assertInitialized(opts.path);
        const next = disableApplicabilityCanary(projectBase);
        console.log();
        if (!next) {
          console.log(pc.dim("  No canary configured."));
          console.log();
          return;
        }
        console.log(pc.bold("Applicability canary disabled"));
        renderCanary(next);
        console.log();
      }),
  )
  .addCommand(
    new Command("status")
      .description("Show the current canary serving state")
      .option("-p, --path <path>", "project root", process.cwd())
      .option("--json", "machine-readable JSON output")
      .action((opts: { path: string; json?: boolean }) => {
        const projectBase = assertInitialized(opts.path);
        const current = readApplicabilityCanaryConfig(projectBase);
        const serving = resolveCanaryServingState(current);
        if (opts.json) {
          process.stdout.write(JSON.stringify({ canary: current, effective: { enabled: serving.enabled, killReason: serving.killReason ?? null } }, null, 2) + "\n");
          return;
        }
        console.log();
        console.log(pc.bold("TraceBase applicability canary"));
        if (!current) {
          console.log(pc.dim("  canary     not configured (off)"));
          console.log();
          console.log(pc.dim(`  Activate with \`npx tracebase-ai canary enable --rate 0.05 --ack ${CANARY_POLICY_VERSION}\`.`));
          console.log();
          return;
        }
        renderCanary(current);
        console.log();
      }),
  )
  .addCommand(
    new Command("preview")
      .description("Dry-run: show what enabling would do WITHOUT changing anything")
      .option("-p, --path <path>", "project root", process.cwd())
      .option("--rate <rate>", `preview at this rate; default ${DEFAULT_CANARY_RATE}`, parseRateArg)
      .action((opts: { path: string; rate?: number }) => {
        const projectBase = assertInitialized(opts.path);
        const current = readApplicabilityCanaryConfig(projectBase);
        const rate = opts.rate ?? DEFAULT_CANARY_RATE;
        console.log();
        console.log(pc.bold("Applicability canary — dry run (nothing written)"));
        console.log(pc.dim(`  current:   ${current ? (current.enabled ? "enabled" : "disabled") : "not configured (off)"}`));
        console.log(pc.dim(`  would set: enabled, rate=${(rate * 100).toFixed(rate < 0.1 ? 2 : 0)}%, policy=${CANARY_POLICY_VERSION}`));
        console.log(pc.dim(`  exposes:   the reranker-selected block when V4 abstains, to ~${(rate * 100).toFixed(rate < 0.1 ? 2 : 0)}% of eligible distinct problems (apply-only).`));
        console.log(pc.dim(`  to apply:  npx tracebase-ai canary enable --rate ${rate} --ack ${CANARY_POLICY_VERSION}`));
        console.log();
      }),
  );
