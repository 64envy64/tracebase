/**
 * `tracebase events` — filtered dump of the analytics event log.
 *
 * Supports:
 *   --since <7d|30m|1234567890|2026-04-18T12:00:00Z>
 *   --type  <retrieval|injection|agent_used|outcome|fact_injection|fact_agent_used>
 *   --block <blockId>
 *   --fact  <factId>
 *   --query <queryId>
 *   --run   <runId>
 *   --limit <n>   (default 50)
 *   --json        machine-readable
 *
 * Read-only.
 */
import { Command } from "commander";
import { existsSync } from "node:fs";
import pc from "picocolors";
import Database from "better-sqlite3";
import { findConfigDir, loadConfig } from "../../core/config.js";
import { BlockStore, type EventReadOptions } from "../../core/block-store.js";
import type { AnalyticsEvent } from "../../types.js";

export const eventsCommand = new Command("events")
  .description("Show recent analytics events from the local store")
  .option("-p, --path <path>", "project root", process.cwd())
  .option("--since <when>", "window start: relative (7d / 1h / 30m) or ISO / epoch ms")
  .option("--type <type>", "filter by event type")
  .option("--block <id>", "filter by block id")
  .option("--fact <id>", "filter by fact id")
  .option("--query <id>", "filter by queryId")
  .option("--run <id>", "filter by runId")
  .option("-l, --limit <n>", "max events (default 50)", "50")
  .option("--json", "machine-readable JSON output")
  .action((opts: {
    path: string;
    since?: string;
    type?: string;
    block?: string;
    fact?: string;
    query?: string;
    run?: string;
    limit: string;
    json?: boolean;
  }) => {
    const configDir = findConfigDir(opts.path);
    if (!configDir) {
      console.error(pc.yellow("⚠ Not initialized. ") + "Run " + pc.cyan("npx tracebase init") + " first.");
      process.exitCode = 1;
      return;
    }
    const cfg = loadConfig(opts.path);
    if (!existsSync(cfg.storagePath)) {
      if (opts.json) {
        process.stdout.write(JSON.stringify({ events: [], note: "no store yet" }) + "\n");
        return;
      }
      console.log(pc.dim("  (no store file yet — events appear after the first MCP call)"));
      return;
    }

    const limit = Math.max(1, Math.min(parseInt(opts.limit, 10) || 50, 10_000));

    let afterTs: number | undefined;
    if (opts.since) {
      try {
        afterTs = parseSince(opts.since);
      } catch (e) {
        console.error(pc.red("Error: ") + (e instanceof Error ? e.message : String(e)));
        process.exitCode = 1;
        return;
      }
    }

    const readOpts: EventReadOptions = { limit };
    if (afterTs !== undefined) readOpts.afterTs = afterTs;
    if (opts.type) readOpts.eventType = opts.type as AnalyticsEvent["event"];
    if (opts.block) readOpts.blockId = opts.block;
    if (opts.fact) readOpts.factId = opts.fact;
    if (opts.query) readOpts.queryId = opts.query;
    if (opts.run) readOpts.runId = opts.run;

    const db = new Database(cfg.storagePath, { readonly: true });
    const store = new BlockStore(db, { skipMigrate: true });
    let events: AnalyticsEvent[];
    try {
      events = store.readEvents(readOpts);
    } finally {
      db.close();
    }

    if (opts.json) {
      process.stdout.write(JSON.stringify({ events }, null, 2) + "\n");
      return;
    }

    console.log();
    console.log(pc.bold("TraceBase events") + pc.dim(`  (${events.length} shown, limit ${limit})`));
    if (afterTs !== undefined) {
      console.log(pc.dim("  since: " + new Date(afterTs).toISOString()));
    }
    console.log();
    if (events.length === 0) {
      console.log(pc.dim("  no matching events"));
      console.log();
      return;
    }
    for (const ev of events) {
      console.log("  " + formatEventLine(ev));
    }
    console.log();
  });

/**
 * Parse a --since argument. Accepts:
 *   relative:  "7d" "3h" "45m" "30s" "2w"
 *   epoch ms:  "1718300000000"
 *   ISO 8601:  "2026-04-18T12:00:00Z"
 */
export function parseSince(input: string, now: number = Date.now()): number {
  const trimmed = input.trim();
  // Relative.
  const m = trimmed.match(/^(\d+)\s*([smhdw])$/i);
  if (m) {
    const n = parseInt(m[1]!, 10);
    const unit = m[2]!.toLowerCase();
    const ms: Record<string, number> = {
      s: 1000,
      m: 60_000,
      h: 3_600_000,
      d: 86_400_000,
      w: 604_800_000,
    };
    return now - n * ms[unit]!;
  }
  // Pure digits → epoch ms (must be ≥ 10 digits = year 2001+).
  if (/^\d{10,}$/.test(trimmed)) {
    const ts = parseInt(trimmed, 10);
    if (Number.isFinite(ts)) return ts;
  }
  // Date-parseable fallback — but require at least one structural
  // character ('-', 'T', ':', '/') to avoid accidentally parsing
  // short digit runs like "123" as year 123.
  if (/[-T:/]/.test(trimmed)) {
    const d = new Date(trimmed);
    const t = d.getTime();
    if (!Number.isNaN(t)) return t;
  }
  throw new Error(`unrecognized --since value: "${input}"`);
}

function formatEventLine(ev: AnalyticsEvent): string {
  const ts = new Date(ev.ts).toISOString();
  const runTag = ev.runId ? pc.dim(` run=${ev.runId}`) : "";
  const qidTag = pc.dim(` query=${ev.queryId}`);

  switch (ev.event) {
    case "retrieval":
      return `${pc.dim(ts)}  ${pc.cyan("retrieval")}   ` +
        `candidates=${ev.candidates.length}` +
        (ev.factCandidates ? ` facts=${ev.factCandidates.length}` : "") +
        (ev.shadow ? pc.yellow(" shadow") : "") +
        qidTag + runTag;
    case "injection":
      return `${pc.dim(ts)}  ${pc.green("injection")}   ` +
        `block=${ev.blockId.slice(0, 8)}… score=${ev.score.toFixed(3)}` +
        (ev.calibratedProb !== undefined ? ` calibrated=${ev.calibratedProb.toFixed(3)}` : "") +
        qidTag + runTag;
    case "fact_injection":
      return `${pc.dim(ts)}  ${pc.green("fact_inject")} ` +
        `fact=${ev.factId.slice(0, 8)}… score=${ev.score.toFixed(3)}` +
        (ev.calibratedProb !== undefined ? ` calibrated=${ev.calibratedProb.toFixed(3)}` : "") +
        qidTag + runTag;
    case "agent_used":
      return `${pc.dim(ts)}  ${pc.magenta("agent_used")}  ` +
        `block=${ev.blockId.slice(0, 8)}… match=${ev.matchSignal}(${ev.matchScore.toFixed(2)})` +
        qidTag + runTag;
    case "fact_agent_used":
      return `${pc.dim(ts)}  ${pc.magenta("fact_used")}   ` +
        `fact=${ev.factId.slice(0, 8)}… match=${ev.matchSignal}(${ev.matchScore.toFixed(2)})` +
        qidTag + runTag;
    case "outcome":
      return `${pc.dim(ts)}  ${ev.resolved ? pc.green("outcome✓") : pc.red("outcome✗")}   ` +
        `resolved=${ev.resolved}` +
        (ev.regressed !== undefined ? ` regressed=${ev.regressed}` : "") +
        (ev.tokens !== undefined ? ` tokens=${ev.tokens}` : "") +
        (ev.steps !== undefined ? ` steps=${ev.steps}` : "") +
        (ev.control ? pc.yellow(" control") : "") +
        qidTag + runTag;
    default: {
      // 0.7.0-rc.1+ — generic line for new event kinds. Pretty
      // renderers land alongside the rc that emits each kind; the
      // generic shape stays here for low-frequency events
      // (`store.injection_rejected`, `file_index.skipped`, etc.)
      // that don't justify a bespoke format string.
      const e = ev as { event: string };
      return `${pc.dim(ts)}  ${pc.gray(e.event)}` + qidTag + runTag;
    }
  }
}
