/**
 * `tracebase usage sync` — push rolled-up UsageMetrics samples to the
 * hosted control plane.
 *
 * Idempotent on (installationId, windowStart, windowEnd). Re-running
 * the same day overwrites the previous sample on the server — the
 * CLI never double-counts, even on flaky networks.
 *
 * Phase 1 bucket size is 1 day: each push covers a single UTC day,
 * and the command iterates the requested range in daily slices.
 *
 * The hot path (recall / injection / local events) stays entirely
 * local — this command is opt-in and never blocks agent traffic.
 */
import { existsSync, readFileSync } from "node:fs";
import { Command } from "commander";
import pc from "picocolors";
import Database from "better-sqlite3";
import { findConfigDir, loadConfig } from "../../core/config.js";
import { BlockStore } from "../../core/block-store.js";
import { computeAggregates } from "../../core/analytics.js";
import { computeUsageMetrics, type UsageMetrics } from "../../analytics/usage-metrics.js";
import { loadCloudCredential, normalizeApiUrl } from "../cloud.js";
import { parseSince } from "./events.js";
import { join } from "node:path";

interface PushResult {
  ok: boolean;
  status: number;
  body: string;
}

const DAY_MS = 86_400_000;

function packageVersion(): string {
  try {
    const pkgPath = join(__dirname, "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export const usageCommand = new Command("usage")
  .description("Push rolled-up UsageMetrics to the hosted control plane")
  .addCommand(
    new Command("sync")
      .description("Roll up daily UsageMetrics and push to the cloud (idempotent)")
      .option("-p, --path <path>", "project root", process.cwd())
      .option("--since <when>", "window start (default 30d)", "30d")
      .option("--api-url <url>", "override TRACEBASE_API_URL / stored cloud link")
      .option("--api-key <key>", "override stored workspace API key or TRACEBASE_API_KEY")
      .option("--dry-run", "compute and print the samples without pushing")
      .action(async (opts: {
        path: string;
        since: string;
        apiUrl?: string;
        apiKey?: string;
        dryRun?: boolean;
      }) => {
        const configDir = findConfigDir(opts.path);
        if (!configDir) {
          console.error(pc.yellow("⚠ Not initialized. ") + "Run " + pc.cyan("npx tracebase init") + " first.");
          process.exitCode = 1;
          return;
        }
        const cfg = loadConfig(opts.path);
        if (!cfg.cloud?.workspaceId) {
          console.error(pc.yellow("⚠ No cloud link on this project. ") + "Re-run " + pc.cyan("npx tracebase init") + " with cloud credentials.");
          process.exitCode = 1;
          return;
        }

        const primaryInstallationId =
          cfg.cloud.installationIds?.[cfg.install?.agents?.[0] ?? "claude-code"] ??
          cfg.cloud.installationId;
        if (!primaryInstallationId) {
          console.error(pc.yellow("⚠ This project has no installationId yet. ") + "Re-run " + pc.cyan("npx tracebase init") + " to register with the control plane.");
          process.exitCode = 1;
          return;
        }

        const apiUrl = normalizeApiUrl(opts.apiUrl ?? cfg.cloud.apiUrl);
        const apiKey =
          opts.apiKey?.trim() ||
          process.env.TRACEBASE_API_KEY?.trim() ||
          loadCloudCredential(apiUrl, cfg.cloud.workspaceId) ||
          "";
        if (!apiKey && !opts.dryRun) {
          console.error(pc.yellow("⚠ No API key for this workspace. ") + "Set " + pc.cyan("TRACEBASE_API_KEY") + " or re-run " + pc.cyan("init") + " to obtain one.");
          process.exitCode = 1;
          return;
        }

        // Time range: clamp `since` to a UTC day boundary so each bucket
        // is exactly one day. `parseSince` accepts "30d" / ISO / epoch ms.
        let afterTs: number;
        try {
          afterTs = parseSince(opts.since);
        } catch (e) {
          console.error(pc.red("Error: ") + (e instanceof Error ? e.message : String(e)));
          process.exitCode = 1;
          return;
        }
        const nowTs = Date.now();
        const days = buildDayBuckets(afterTs, nowTs);

        console.log();
        console.log(pc.bold("TraceBase usage sync"));
        console.log(pc.dim(`  project      ${configDir}`));
        console.log(pc.dim(`  api          ${apiUrl}`));
        console.log(pc.dim(`  installation ${primaryInstallationId}`));
        console.log(pc.dim(`  window       ${new Date(afterTs).toISOString()} → ${new Date(nowTs).toISOString()} (${days.length} bucket${days.length === 1 ? "" : "s"})`));
        console.log();

        // No store file yet = no activity yet. Keep the command honest:
        // exit cleanly with a note instead of a SQLite cant-open error.
        if (!existsSync(cfg.storagePath)) {
          console.log(pc.dim("  no memory.db yet — nothing to sync. Run an agent turn first."));
          console.log();
          return;
        }

        // Open the local event store once; iterate buckets against it.
        const db = new Database(cfg.storagePath, { readonly: true });
        const store = new BlockStore(db, { skipMigrate: true });
        const cliVersion = packageVersion();

        let pushed = 0;
        let skipped = 0;
        try {
          for (const bucket of days) {
            const agg = computeAggregates(store, {
              afterTs: bucket.startMs,
              beforeTs: bucket.endMs,
            });
            const metrics: UsageMetrics = computeUsageMetrics(agg);
            // Skip buckets with no activity — no point writing an
            // all-zero sample and spamming the dashboard with empty rows.
            if (metrics.observed.eligibleRuns === 0) {
              skipped++;
              continue;
            }
            if (opts.dryRun) {
              console.log(pc.dim(`  ~ ${bucket.start} `) + `eligible=${metrics.observed.eligibleRuns} injected=${metrics.observed.injectedRuns} helpful=${metrics.observed.helpfulRuns}`);
              pushed++;
              continue;
            }
            const result = await pushSample({
              apiUrl,
              apiKey,
              installationId: primaryInstallationId,
              windowStart: bucket.start,
              windowEnd: bucket.end,
              metrics,
              cliVersion,
            });
            if (result.ok) {
              pushed++;
              console.log(pc.green(`  + ${bucket.start} `) + pc.dim(`eligible=${metrics.observed.eligibleRuns} injected=${metrics.observed.injectedRuns} helpful=${metrics.observed.helpfulRuns}`));
            } else {
              console.log(pc.red(`  ! ${bucket.start} `) + pc.dim(`push failed (${result.status}): ${truncate(result.body, 140)}`));
            }
          }
        } finally {
          store.close();
        }

        console.log();
        const summary = opts.dryRun ? "Dry run" : "Pushed";
        console.log(pc.dim(`  ${summary} ${pushed} bucket${pushed === 1 ? "" : "s"}; ${skipped} skipped (empty).`));
        console.log();
      }),
  );

interface DayBucket {
  /** UTC midnight at the start of the day, ISO. */
  start: string;
  end: string;
  startMs: number;
  endMs: number;
}

function buildDayBuckets(afterTs: number, nowTs: number): DayBucket[] {
  const start = Math.floor(afterTs / DAY_MS) * DAY_MS;
  const end = Math.floor(nowTs / DAY_MS) * DAY_MS + DAY_MS;
  const out: DayBucket[] = [];
  for (let t = start; t < end; t += DAY_MS) {
    out.push({
      start: new Date(t).toISOString(),
      end: new Date(t + DAY_MS).toISOString(),
      startMs: t,
      endMs: t + DAY_MS,
    });
  }
  return out;
}

async function pushSample(input: {
  apiUrl: string;
  apiKey: string;
  installationId: string;
  windowStart: string;
  windowEnd: string;
  metrics: UsageMetrics;
  cliVersion: string;
}): Promise<PushResult> {
  try {
    const res = await fetch(`${input.apiUrl}/api/control-plane/usage-samples`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        installationId: input.installationId,
        windowStart: input.windowStart,
        windowEnd: input.windowEnd,
        metrics: input.metrics,
        cliVersion: input.cliVersion,
      }),
    });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: error instanceof Error ? error.message : String(error),
    };
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
