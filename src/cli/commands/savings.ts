/**
 * `tracebase savings` — visual dashboard of estimated mechanism
 * savings, modelled on the per-command savings dashboards from
 * other agent toolkits.
 *
 * Sections:
 *   1. Header — "TraceBase Token Savings (window: Nd)"
 *   2. Summary block — total events / tokens injected / tokens
 *      saved / efficiency meter
 *   3. By Mechanism table — # / mechanism / count / saved / avg /
 *      impact bar
 *   4. By Tool Family table (only when tool supervision fired) —
 *      # / family / count / saved / avg / impact bar
 *
 * Strict copy contract — same as `tracebase impact` (PLAN-0.7
 * §rc.7 + §6 stable §4):
 *   - All "saved" labels are tagged "estimated saved" or
 *     "total estimated saved" — never bare "saved" alone.
 *   - The block NEVER uses the words "verified" or "guaranteed"
 *     anywhere; this surface is the deterministic-mechanism view,
 *     orthogonal to the holdout-based causal block.
 *   - Empty windows render an honest "no events yet" rather than
 *     a row of zeros that could read as "we ran but saved nothing".
 *
 * Run: `tracebase savings`. Flags mirror `tracebase impact` so
 * users can swap commands without re-learning options.
 */
import { Command } from "commander";
import pc from "picocolors";
import Database from "better-sqlite3";
import { existsSync } from "node:fs";

import {
  findProjectRoot,
  isInitialized,
  loadConfig,
} from "../../core/config.js";
import { BlockStore } from "../../core/block-store.js";
import { computeAggregates, type MechanismAggregates } from "../../core/analytics.js";
import {
  computeMechanismSavings,
  TOOL_FAMILY_TOKEN_ESTIMATE,
  type MechanismSavings,
} from "../../analytics/mechanism-savings.js";
import { TOOL_FAMILIES, type ToolFamily } from "../../runtime/tool-family.js";

interface SavingsOptions {
  path?: string;
  /** Window (ms) — default 7 days. Accepts plain ms or "Nd" / "Nh". */
  since?: string;
  json?: boolean;
}

export const savingsCommand = new Command("savings")
  .description(
    "Visual dashboard of estimated mechanism savings: total + per-" +
      "mechanism + per-tool-family with impact bars. Window-bounded; " +
      "every number is deterministic (no causal lift here).",
  )
  .option("-p, --path <path>", "project root", process.cwd())
  .option("--since <window>", "window: '7d' | '24h' | epoch ms (default 7d)", "7d")
  .option("--json", "emit machine-readable JSON")
  .action((opts: SavingsOptions) => {
    const result = runSavings(opts);
    if (opts.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else {
      process.stdout.write(renderSavingsDashboard(result));
    }
    if (result.error) process.exitCode = 1;
  });

// ---------------------------------------------------------------------------
// Public report shape
// ---------------------------------------------------------------------------

export interface SavingsReport {
  windowAfterTs: number;
  windowBeforeTs: number;
  /** Window length in days, ceil-rounded for display. */
  windowDays: number;
  /**
   * Total events landed in the window (across all mechanism kinds
   * that contribute to the savings number — i.e. fold + recall +
   * supervision + cache hits). NOT a lifecycle-events total.
   */
  totalEvents: number;
  /** Total injection-side token spend in the window. */
  tokensInjected: number;
  /** Σ over the four mechanism components. */
  savings: MechanismSavings;
  /** Underlying aggregator output, used for the per-family rollup. */
  aggregates: MechanismAggregates | null;
  /** "savings.total / (savings.total + tokensInjected)" — clamped to [0,1]. */
  efficiency: number;
  error?: string;
}

interface MechanismRow {
  rank: number;
  /** Display label, e.g. "context fold". */
  name: string;
  /** Stable id, e.g. "context_fold". */
  key: "context_fold" | "file_memory" | "tool_supervision" | "prompt_cache";
  count: number;
  saved: number;
  /** Saved tokens per event in this row. */
  avgPerEvent: number;
  /** 0..1, scaled against the largest row in the same table. */
  impact: number;
}

interface FamilyRow {
  rank: number;
  family: ToolFamily;
  count: number;
  saved: number;
  avgPerEvent: number;
  impact: number;
}

// ---------------------------------------------------------------------------
// Compute
// ---------------------------------------------------------------------------

export function runSavings(opts: SavingsOptions): SavingsReport {
  const projectRoot = resolveBasePath(opts.path);
  if (!projectRoot || !isInitialized(projectRoot)) {
    return emptyReport(opts, "not initialized — run `npx tracebase init` first");
  }
  const config = loadConfig(projectRoot);
  if (!existsSync(config.storagePath)) {
    return emptyReport(opts);
  }
  const beforeTs = Date.now();
  const afterTs = beforeTs - parseWindow(opts.since ?? "7d");

  const db = new Database(config.storagePath, { readonly: true });
  const store = new BlockStore(db, { skipMigrate: true });
  let savings: MechanismSavings;
  let aggregates: MechanismAggregates;
  let tokensInjected = 0;
  try {
    const agg = computeAggregates(store, { afterTs, beforeTs });
    savings = computeMechanismSavings(store, { afterTs, beforeTs });
    aggregates = agg.mechanisms;
    tokensInjected = agg.retrieval.totalInjectedTokensEstimate;
  } finally {
    store.close();
  }

  const totalEvents =
    aggregates.contextFold.chunkCount +
    aggregates.fileMemory.recallCount +
    (aggregates.toolSupervision.warnCount + aggregates.toolSupervision.suppressedCount) +
    aggregates.promptCache.hitCount;

  const denom = savings.total + tokensInjected;
  const efficiency = denom > 0 ? Math.min(1, Math.max(0, savings.total / denom)) : 0;
  const windowDays = Math.max(1, Math.round((beforeTs - afterTs) / 86_400_000));

  return {
    windowAfterTs: afterTs,
    windowBeforeTs: beforeTs,
    windowDays,
    totalEvents,
    tokensInjected,
    savings,
    aggregates,
    efficiency,
  };
}

function emptyReport(opts: SavingsOptions, error?: string): SavingsReport {
  const beforeTs = Date.now();
  const afterTs = beforeTs - parseWindow(opts.since ?? "7d");
  const windowDays = Math.max(1, Math.round((beforeTs - afterTs) / 86_400_000));
  return {
    windowAfterTs: afterTs,
    windowBeforeTs: beforeTs,
    windowDays,
    totalEvents: 0,
    tokensInjected: 0,
    savings: {
      contextCompressionSaved: 0,
      fileMemoryAvoided: 0,
      toolSupervisionAvoided: 0,
      promptCacheSaved: 0,
      total: 0,
    },
    aggregates: null,
    efficiency: 0,
    ...(error ? { error } : {}),
  };
}

// ---------------------------------------------------------------------------
// Per-mechanism row build
// ---------------------------------------------------------------------------

export function buildMechanismRows(report: SavingsReport): MechanismRow[] {
  if (!report.aggregates) return [];
  const a = report.aggregates;
  const s = report.savings;
  const cfCount = a.contextFold.chunkCount;
  const fmCount = a.fileMemory.recallCount;
  const tsCount = a.toolSupervision.warnCount + a.toolSupervision.suppressedCount;
  const pcCount = a.promptCache.hitCount;

  const raw: Array<Omit<MechanismRow, "rank" | "impact">> = [
    {
      name: "context fold",
      key: "context_fold",
      count: cfCount,
      saved: s.contextCompressionSaved,
      avgPerEvent: cfCount > 0 ? s.contextCompressionSaved / cfCount : 0,
    },
    {
      name: "file memory",
      key: "file_memory",
      count: fmCount,
      saved: s.fileMemoryAvoided,
      avgPerEvent: fmCount > 0 ? s.fileMemoryAvoided / fmCount : 0,
    },
    {
      name: "tool supervision",
      key: "tool_supervision",
      count: tsCount,
      saved: s.toolSupervisionAvoided,
      avgPerEvent: tsCount > 0 ? s.toolSupervisionAvoided / tsCount : 0,
    },
    {
      name: "prompt cache",
      key: "prompt_cache",
      count: pcCount,
      saved: s.promptCacheSaved,
      avgPerEvent: pcCount > 0 ? s.promptCacheSaved / pcCount : 0,
    },
  ];

  // Drop rows with zero saved tokens — they're noise on a "what
  // helped me" dashboard. Sort by saved descending so the top
  // contributor is on row #1.
  const filtered = raw.filter((r) => r.saved > 0);
  filtered.sort((a, b) => b.saved - a.saved);

  const max = filtered.length > 0 ? filtered[0]!.saved : 0;
  return filtered.map((r, i) => ({
    ...r,
    rank: i + 1,
    impact: max > 0 ? r.saved / max : 0,
  }));
}

export function buildFamilyRows(report: SavingsReport): FamilyRow[] {
  if (!report.aggregates) return [];
  const counts = report.aggregates.toolSupervision.byFamily;
  const raw: Array<{ family: ToolFamily; count: number; saved: number; avgPerEvent: number }> = [];
  for (const family of TOOL_FAMILIES) {
    const count = counts[family] ?? 0;
    if (count === 0) continue;
    const est = TOOL_FAMILY_TOKEN_ESTIMATE[family] ?? 0;
    const saved = count * est;
    raw.push({
      family,
      count,
      saved,
      avgPerEvent: est,
    });
  }
  raw.sort((a, b) => b.saved - a.saved);
  const max = raw.length > 0 ? raw[0]!.saved : 0;
  return raw.map((r, i) => ({
    ...r,
    rank: i + 1,
    impact: max > 0 ? r.saved / max : 0,
  }));
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

const BAR_FILL = "█";
const BAR_TRACK = "░";
const BAR_WIDTH = 30;

function bar(ratio: number, width: number = BAR_WIDTH): string {
  const r = Math.min(1, Math.max(0, ratio));
  const filled = Math.round(r * width);
  return BAR_FILL.repeat(filled) + BAR_TRACK.repeat(width - filled);
}

function impactBar(ratio: number, width: number = 12): string {
  const r = Math.min(1, Math.max(0, ratio));
  const filled = Math.round(r * width);
  // Use the same fill+track chars as the efficiency meter so the
  // per-row bars line up visually with the top-of-page meter.
  return BAR_FILL.repeat(filled) + BAR_TRACK.repeat(width - filled);
}

export function renderSavingsDashboard(report: SavingsReport): string {
  const lines: string[] = [];
  if (report.error) {
    lines.push(pc.yellow("⚠ ") + report.error);
    lines.push("");
    return lines.join("\n");
  }

  // Header
  lines.push(pc.bold("TraceBase Token Savings") + pc.dim(`  (window: ${report.windowDays}d)`));
  lines.push(pc.dim("─".repeat(48)));

  // Summary block
  const s = report.savings;
  const labelColor = pc.dim;
  lines.push(`${labelColor("Total events:".padEnd(22))}${humanCount(report.totalEvents)}`);
  lines.push(`${labelColor("Tokens injected:".padEnd(22))}${humanTokens(report.tokensInjected)}`);
  const pct = s.total + report.tokensInjected > 0
    ? Math.round(report.efficiency * 1000) / 10
    : 0;
  const savedLine = `${humanTokens(s.total)} estimated saved` +
    (report.tokensInjected > 0 ? `  (${pct.toFixed(1)}%)` : "");
  lines.push(`${labelColor("Tokens saved:".padEnd(22))}${pc.green(savedLine)}`);
  lines.push(`${labelColor("Efficiency meter:".padEnd(22))}${bar(report.efficiency)}  ${pct.toFixed(1)}%`);

  // No data: stop here with an honest message.
  if (s.total === 0 && report.totalEvents === 0) {
    lines.push("");
    lines.push(pc.dim("  No mechanism events in this window yet — try `tracebase impact` for the always-on summary."));
    lines.push("");
    return lines.join("\n") + "\n";
  }

  // By Mechanism table
  lines.push("");
  lines.push(pc.bold("By Mechanism"));
  const mechRows = buildMechanismRows(report);
  if (mechRows.length === 0) {
    lines.push(pc.dim("  no rows — every mechanism component is zero in this window"));
  } else {
    lines.push(renderMechRow("#", "Mechanism", "Count", "Saved", "Avg", "Impact", true));
    for (const row of mechRows) {
      lines.push(
        renderMechRow(
          String(row.rank),
          row.name,
          humanCount(row.count),
          humanTokens(row.saved),
          humanTokens(row.avgPerEvent),
          impactBar(row.impact),
        ),
      );
    }
  }

  // By Tool Family — only when tool supervision fired
  const famRows = buildFamilyRows(report);
  if (famRows.length > 0) {
    lines.push("");
    lines.push(pc.bold("By Tool Family") + pc.dim("  (tool supervision blocks)"));
    lines.push(renderFamRow("#", "Family", "Count", "Saved", "Avg", "Impact", true));
    for (const row of famRows) {
      lines.push(
        renderFamRow(
          String(row.rank),
          row.family,
          humanCount(row.count),
          humanTokens(row.saved),
          humanTokens(row.avgPerEvent),
          impactBar(row.impact),
        ),
      );
    }
  }

  lines.push("");
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Table helpers — fixed-width columns so the dashboard lines up
// ---------------------------------------------------------------------------

function renderMechRow(
  num: string,
  name: string,
  count: string,
  saved: string,
  avg: string,
  impact: string,
  header: boolean = false,
): string {
  const cells = [
    num.padStart(2),
    name.padEnd(18),
    count.padStart(6),
    saved.padStart(8),
    avg.padStart(8),
    impact,
  ];
  const line = "  " + cells.join("  ");
  return header ? pc.dim(line) : line;
}

function renderFamRow(
  num: string,
  family: string,
  count: string,
  saved: string,
  avg: string,
  impact: string,
  header: boolean = false,
): string {
  const cells = [
    num.padStart(2),
    family.padEnd(10),
    count.padStart(6),
    saved.padStart(8),
    avg.padStart(8),
    impact,
  ];
  const line = "  " + cells.join("  ");
  return header ? pc.dim(line) : line;
}

// ---------------------------------------------------------------------------
// Utility helpers — duplicated minimally with `impact.ts`. Keep in sync.
// ---------------------------------------------------------------------------

function resolveBasePath(explicit: string | undefined): string | null {
  if (explicit) return explicit;
  return findProjectRoot(process.cwd()) ?? process.cwd();
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

function parseWindow(raw: string): number {
  const trimmed = raw.trim();
  const days = /^(\d+)d$/.exec(trimmed);
  if (days) return Number(days[1]) * DAY_MS;
  const hours = /^(\d+)h$/.exec(trimmed);
  if (hours) return Number(hours[1]) * HOUR_MS;
  const ms = Number(trimmed);
  if (Number.isFinite(ms) && ms > 0) return ms;
  return 7 * DAY_MS;
}

function humanTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${Math.round(n)}`;
}

function humanCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${Math.round(n)}`;
}
