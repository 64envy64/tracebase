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
 *
 * ---------------------------------------------------------------------
 * Phase 1C.1 — scope contract
 *
 * Local events do not carry an agent dimension, so the sample we
 * push represents the whole project's activity. It is tagged
 * `scope: "workspace"` in the payload so the dashboard can render
 * it as "Project activity" and never pretend to break it down per
 * adapter. Per-installation impact rendering waits on Phase 2, when
 * events themselves carry an agent tag and `scope: "agent"` samples
 * become meaningful.
 *
 * The push is still keyed by the primary adapter's `installationId`
 * because the server schema requires one; the scope tag in the
 * payload is the authoritative signal to downstream readers.
 */
import { Command } from "commander";
import pc from "picocolors";
import Database from "better-sqlite3";
import { findConfigDir } from "../../core/config.js";
import { BlockStore } from "../../core/block-store.js";
import {
  buildWindowPayload,
  checkSyncReadiness,
  pushSampleToCloud,
} from "../../sdk/usage-payload.js";
import { parseSince } from "./events.js";

const DAY_MS = 86_400_000;

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
        // 0.5.5 §1 / §2 — CLI delegates to `checkSyncReadiness` so
        // the manual sync path uses the same validation + payload
        // assembly the auto-sync coordinator does. The `dryRun`
        // flag flows in as `allowMissingApiKey` so a workspace
        // without a key can still preview a sample.
        const configDir = findConfigDir(opts.path);
        const readiness = checkSyncReadiness(opts.path, {
          apiUrlOverride: opts.apiUrl,
          apiKeyOverride: opts.apiKey,
          allowMissingApiKey: opts.dryRun,
        });
        if (!readiness.ok) {
          renderReadinessError(readiness.reason);
          if (readiness.reason === "no-storage") {
            // Same UX as the previous "no memory.db yet" path — we
            // exit cleanly with a note rather than a 1.
            return;
          }
          process.exitCode = 1;
          return;
        }
        const { apiUrl, installationId, storagePath, cliVersion } = readiness.readiness;

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
        console.log(pc.dim(`  installation ${installationId} (primary; scope=workspace)`));
        console.log(pc.dim(`  window       ${new Date(afterTs).toISOString()} → ${new Date(nowTs).toISOString()} (${days.length} bucket${days.length === 1 ? "" : "s"})`));
        console.log(pc.dim(`  scope        workspace — project-level rollup. Per-adapter attribution ships in Phase 2.`));
        console.log();

        // Open the local event store once; iterate buckets against
        // it via the shared `buildWindowPayload` helper.
        const db = new Database(storagePath, { readonly: true });
        const store = new BlockStore(db, { skipMigrate: true });

        let pushed = 0;
        let skipped = 0;
        try {
          for (const bucket of days) {
            const built = buildWindowPayload(
              readiness.readiness,
              store,
              bucket.startMs,
              bucket.endMs,
            );
            if (!built.ok) {
              skipped++;
              continue;
            }
            const { metrics } = built.input;
            if (opts.dryRun) {
              console.log(pc.dim(`  ~ ${bucket.start} `) + `eligible=${metrics.observed.eligibleRuns} injected=${metrics.observed.injectedRuns} helpful=${metrics.observed.helpfulRuns}`);
              pushed++;
              continue;
            }
            const result = await pushSampleToCloud({
              ...built.input,
              // Daily windows use the bucket boundaries; override
              // the helper's literal-window timestamps so the
              // dedupe key matches the CLI's traditional shape.
              windowStart: bucket.start,
              windowEnd: bucket.end,
            });
            if (result.ok) {
              pushed++;
              console.log(pc.green(`  + ${bucket.start} `) + pc.dim(`eligible=${metrics.observed.eligibleRuns} injected=${metrics.observed.injectedRuns} helpful=${metrics.observed.helpfulRuns}`));
            } else {
              console.log(pc.red(`  ! ${bucket.start} `) + pc.dim(`push failed (${result.status}): ${truncate(result.reason ?? "", 140)}`));
            }
          }
        } finally {
          store.close();
        }
        // Suppress unused-var warning while we no longer reference cliVersion
        // directly here (it's captured inside built.input from
        // `buildWindowPayload`).
        void cliVersion;

        console.log();
        const summary = opts.dryRun ? "Dry run" : "Pushed";
        console.log(pc.dim(`  ${summary} ${pushed} bucket${pushed === 1 ? "" : "s"}; ${skipped} skipped (empty).`));
        console.log();
      }),
  );

function renderReadinessError(reason: string): void {
  switch (reason) {
    case "not-initialized":
      console.error(
        pc.yellow("⚠ Not initialized. ") +
          "Run " +
          pc.cyan("npx tracebase init") +
          " first.",
      );
      return;
    case "no-cloud-link":
      console.error(
        pc.yellow("⚠ No cloud link on this project. ") +
          "Re-run " +
          pc.cyan("npx tracebase init") +
          " with cloud credentials.",
      );
      return;
    case "no-installation-id":
      console.error(
        pc.yellow("⚠ This project has no installationId yet. ") +
          "Re-run " +
          pc.cyan("npx tracebase init") +
          " to register with the control plane.",
      );
      return;
    case "no-api-key":
      console.error(
        pc.yellow("⚠ No API key for this workspace. ") +
          "Set " +
          pc.cyan("TRACEBASE_API_KEY") +
          " or re-run " +
          pc.cyan("init") +
          " to obtain one.",
      );
      return;
    case "no-storage":
      console.log();
      console.log(pc.bold("TraceBase usage sync"));
      console.log();
      console.log(pc.dim("  no memory.db yet — nothing to sync. Run an agent turn first."));
      console.log();
      return;
  }
}

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

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
