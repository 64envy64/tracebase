/**
 * `tracebase canary …` — operate the explicit opt-in applicability canary
 * (Phase D.4). Apply-only: exposes the reranker-selected block when baseline V4
 * abstains, to a bounded, deterministically-assigned sample. DEFAULT OFF.
 *
 * Activation requires an EXPLICIT command with a rate AND a policy
 * acknowledgement (`--ack <policyVersion>`) — there is no accidental path on.
 * `disable` is the crash-safe emergency stop; `preview` is a read-only dry run.
 */
import { Command, InvalidArgumentError } from "commander";
import pc from "picocolors";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  enableApplicabilityCanary,
  disableApplicabilityCanary,
  readApplicabilityCanaryConfig,
  resolveCanaryServingState,
  findConfigDir,
  resolveProjectBase,
  loadConfig,
  DEFAULT_CANARY_RATE,
  MAX_CANARY_RATE,
  CANARY_POLICY_VERSION,
  APPLICABILITY_CANARY_KILL_ENV,
} from "../../core/config.js";
import type { ApplicabilityCanaryConfig } from "../../types.js";
import { BlockStore } from "../../core/block-store.js";
import { APPLICABILITY_FEATURE_VERSION } from "../../core/applicability-reranker.js";
import {
  buildPreflightReceipt,
  verifyReceiptForEnable,
  preregHashOf,
  CANARY_RECEIPT_FILE,
  type CanaryPreflightReceipt,
} from "../../experiments/canary-preflight.js";

/** Resolve + read the frozen pre-registration doc (relative to this module). */
function readPreregText(): string {
  const here = fileURLToPath(import.meta.url);
  // src/cli/commands/canary.(ts|js) → repo root is three levels up.
  const candidate = join(here, "..", "..", "..", "..", "docs", "applicability-canary-prereg.md");
  return readFileSync(candidate, "utf8");
}

function killEngaged(env: NodeJS.ProcessEnv): boolean {
  const k = (env[APPLICABILITY_CANARY_KILL_ENV] ?? "").trim().toLowerCase();
  return k === "off" || k === "0" || k === "false" || k === "disabled";
}
function shadowEnabled(env: NodeJS.ProcessEnv): boolean {
  return (env.TRACEBASE_REASONING_APPLICABILITY ?? "").trim().toLowerCase() === "shadow";
}

/** Build a fresh preflight receipt from live project + env state. */
function runPreflight(projectBase: string, env: NodeJS.ProcessEnv, nowMs: number): CanaryPreflightReceipt {
  const cfg = loadConfig(projectBase);
  const store = new BlockStore(new Database(cfg.storagePath, { readonly: true }));
  try {
    const events = store.readEvents({});
    return buildPreflightReceipt({
      preregText: readPreregText(),
      events,
      canaryConfig: readApplicabilityCanaryConfig(projectBase),
      shadowEnabled: shadowEnabled(env),
      killEngaged: killEngaged(env),
      globalDisabled: env.TRACEBASE_DISABLED === "1",
      policyVersion: CANARY_POLICY_VERSION,
      currentPolicyVersion: CANARY_POLICY_VERSION,
      applicabilityFeatureVersion: APPLICABILITY_FEATURE_VERSION,
      currentApplicabilityFeatureVersion: APPLICABILITY_FEATURE_VERSION,
      nowMs,
    });
  } finally {
    store.close();
  }
}
function receiptPath(projectBase: string): string {
  return join(projectBase, ".tracebase", CANARY_RECEIPT_FILE);
}

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
  if (!Number.isFinite(n) || n <= 0 || n > MAX_CANARY_RATE) {
    // InvalidArgumentError → commander prints a clean one-line refusal and
    // exits 1 (no stack trace): a rate above the pre-reg cap is REJECTED here,
    // at parse time, never clamped down to the cap.
    throw new InvalidArgumentError(`must be in (0, ${MAX_CANARY_RATE}] (pre-reg cap); got ${value}. Rates above the cap are rejected, never clamped.`);
  }
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
    new Command("preflight")
      .description("Readiness audit — emits a local activation receipt (no content/secrets)")
      .option("-p, --path <path>", "project root", process.cwd())
      .option("--json", "machine-readable JSON output")
      .action((opts: { path: string; json?: boolean }) => {
        const projectBase = assertInitialized(opts.path);
        let receipt: CanaryPreflightReceipt;
        try {
          receipt = runPreflight(projectBase, process.env, Date.now());
        } catch (e) {
          console.error(pc.red("Error: ") + (e instanceof Error ? e.message : String(e)));
          process.exit(1);
        }
        writeFileSync(receiptPath(projectBase), JSON.stringify(receipt, null, 2) + "\n");
        if (opts.json) {
          process.stdout.write(JSON.stringify(receipt, null, 2) + "\n");
          return;
        }
        console.log();
        console.log(pc.bold(`Canary preflight — ${receipt.ok ? pc.green("READY") : pc.red("NOT READY")}`));
        for (const [k, v] of Object.entries(receipt.checks)) console.log(`  ${v ? pc.green("✓") : pc.red("✗")} ${k}`);
        console.log(pc.dim(`  attribution: crossRun=${receipt.diagnostics.crossRun} ambiguous=${receipt.diagnostics.ambiguous} trials=${receipt.diagnostics.trials}${receipt.diagnostics.privacyPattern ? ` privacy=${receipt.diagnostics.privacyPattern}` : ""}`));
        console.log(pc.dim(`  transport parity: build-time attested v${receipt.transportParityVersion} (mcp · hook · sdk)`));
        console.log(pc.dim(`  prereg hash: ${receipt.preregHash}  (receipt written to .tracebase/${CANARY_RECEIPT_FILE})`));
        console.log();
        if (receipt.ok) {
          console.log(pc.dim(`Within 30 min, to activate:  npx tracebase-ai canary enable --rate ${DEFAULT_CANARY_RATE} --ack ${CANARY_POLICY_VERSION} --prereg-ack ${receipt.preregHash}`));
        } else {
          console.log(pc.yellow("Resolve the ✗ checks, then re-run preflight."));
        }
        console.log();
      }),
  )
  .addCommand(
    new Command("enable")
      .description("ACTIVATE the canary — requires a fresh preflight receipt + --ack + --prereg-ack")
      .option("-p, --path <path>", "project root", process.cwd())
      .option("--rate <rate>", `treatment rate in (0, ${MAX_CANARY_RATE}] (pre-reg cap); default ${DEFAULT_CANARY_RATE}`, parseRateArg)
      .requiredOption("--ack <policyVersion>", `acknowledge the policy being served (must equal ${CANARY_POLICY_VERSION})`)
      .requiredOption("--prereg-ack <preregHash>", "acknowledge the frozen pre-reg hash from `canary preflight`")
      .action((opts: { path: string; rate?: number; ack: string; preregAck: string }) => {
        const projectBase = assertInitialized(opts.path);
        try {
          // 1. A fresh preflight receipt must exist and still match live state.
          const rp = receiptPath(projectBase);
          if (!existsSync(rp)) {
            console.error(pc.red("Refused: ") + "no preflight receipt. Run `npx tracebase-ai canary preflight` first.");
            process.exit(1);
          }
          const stored: unknown = JSON.parse(readFileSync(rp, "utf8"));
          // Re-audit LIVE state NOW and verify against it: any drift since preflight
          // (digest mismatch) OR a live readiness regression (live.ok=false) refuses.
          const live = runPreflight(projectBase, process.env, Date.now());
          const verdict = verifyReceiptForEnable(stored, { live, nowMs: Date.now() });
          if (!verdict.ok) {
            console.error(pc.red("Refused: ") + `preflight receipt ${verdict.reason}. Re-run \`canary preflight\` and review the changed prerequisites.`);
            process.exit(1);
          }
          // 2. The operator must acknowledge the EXACT frozen pre-reg they preflighted.
          const currentPreregHash = preregHashOf(readPreregText());
          if (opts.preregAck !== currentPreregHash) {
            console.error(pc.red("Refused: ") + `--prereg-ack ${JSON.stringify(opts.preregAck)} != current pre-reg hash ${currentPreregHash}.`);
            process.exit(1);
          }
          // 3. Persist (enableApplicabilityCanary enforces --ack + the rate cap).
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
