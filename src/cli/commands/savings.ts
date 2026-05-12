/**
 * `tracebase savings` — friendly value-first summary for regular coders.
 *
 * The everyday command. After `init` and `doctor` confirm the install
 * works, this is the one you run to answer "is TraceBase actually
 * helping?". No "shadow arm", no "calibration" — just:
 *
 *   ✨ helped you on N tasks
 *   ⏱ ~X min saved
 *   💬 ~Y tokens recycled
 *   top 3 memories
 *
 * Internally it reuses the existing event aggregator
 * (`computeAggregates`) and pipes it through `computeImpact` to
 * translate the rigorous metric surface into plain-English fields.
 * No new analytics — same store, same events, friendlier presentation.
 *
 * Three states the renderer handles:
 *
 *   1. Not initialized            → "run init first" + octopus hint
 *   2. Initialized, no events     → "no savings yet, octopus is waiting"
 *   3. Initialized, has events    → the value-first summary
 *
 * Flags:
 *   --json    machine-readable Impact + the resolved window
 *   --debug   also print the technical aggregates (rates, lift, etc.)
 *   --since / --before    same window grammar as `events` / `report`
 *   --top <n>             cap on topMemories / needsAttention rows
 */
import { Command } from "commander";
import { existsSync } from "node:fs";
import pc from "picocolors";
import Database from "better-sqlite3";
import { findConfigDir, loadConfig } from "../../core/config.js";
import { BlockStore } from "../../core/block-store.js";
import { computeAggregates } from "../../core/analytics.js";
import { computeImpact, type Impact } from "../../core/impact.js";
import { parseSince } from "./events.js";
import type { ReasoningBlock } from "../../types.js";

export const savingsCommand = new Command("savings")
  .description("Show what TraceBase actually saved you (time + tokens) in plain English")
  .option("-p, --path <path>", "project root", process.cwd())
  .option("--since <when>", "window start: relative (7d / 1h) or ISO / epoch ms", "7d")
  .option("--before <when>", "window end: relative / ISO / epoch ms")
  .option("--top <n>", "max rows in top memories / needs-attention (default 3)", "3")
  .option("--debug", "also print the technical aggregates")
  .option("--json", "machine-readable JSON output")
  .action((opts: {
    path: string;
    since?: string;
    before?: string;
    top: string;
    debug?: boolean;
    json?: boolean;
  }) => {
    const view = build(opts);
    if (opts.json) {
      process.stdout.write(JSON.stringify(view, null, 2) + "\n");
      return;
    }
    render(view, !!opts.debug);
  });

// ---------------------------------------------------------------------------
// Build the view
// ---------------------------------------------------------------------------

interface SavingsView {
  state: "uninitialized" | "no-store" | "no-events" | "ok";
  /** Resolved window, both fields optional. */
  window: { since?: number; before?: number; label: string };
  /** Impact summary — present unless state is "uninitialized". */
  impact: Impact | null;
  /**
   * Labels (trigger.situation) for blockIds referenced in
   * impact.topMemories / needsAttention. Keyed by blockId. Missing
   * keys = block was retired / pruned out of the store between the
   * event firing and now.
   */
  labels: Record<string, string>;
  /** Echoed only when --debug. Filled with computeAggregates() output. */
  debug?: unknown;
}

function emptyImpact(): Impact {
  return {
    isEmpty: true,
    confidence: "empty",
    assistedTasks: 0,
    helpedTasks: 0,
    memoriesUsed: 0,
    estimatedMinutesSaved: 0,
    estimatedTokensSaved: 0,
    topMemories: [],
    needsAttention: [],
  };
}

function build(opts: {
  path: string;
  since?: string;
  before?: string;
  top: string;
}): SavingsView {
  const configDir = findConfigDir(opts.path);
  const topN = Math.max(1, Math.min(parseInt(opts.top, 10) || 3, 25));
  const windowLabel = humanWindowLabel(opts.since, opts.before);

  if (!configDir) {
    return {
      state: "uninitialized",
      window: { label: windowLabel },
      impact: null,
      labels: {},
    };
  }

  // Resolve window — same parser as `events` / `report` so flags stay
  // consistent across the CLI surface.
  let afterTs: number | undefined;
  let beforeTs: number | undefined;
  try {
    if (opts.since) afterTs = parseSince(opts.since);
    if (opts.before) beforeTs = parseSince(opts.before);
  } catch (e) {
    console.error(pc.red("Error: ") + (e instanceof Error ? e.message : String(e)));
    process.exitCode = 1;
    // Still return an "ok-shaped" view so JSON consumers get a stable
    // shape even on error — they read state separately.
    return {
      state: "no-events",
      window: { label: windowLabel },
      impact: emptyImpact(),
      labels: {},
    };
  }

  const window = {
    label: windowLabel,
    ...(afterTs !== undefined ? { since: afterTs } : {}),
    ...(beforeTs !== undefined ? { before: beforeTs } : {}),
  };

  const cfg = loadConfig(opts.path);
  if (!existsSync(cfg.storagePath)) {
    return {
      state: "no-store",
      window,
      impact: emptyImpact(),
      labels: {},
    };
  }

  const db = new Database(cfg.storagePath, { readonly: true });
  const store = new BlockStore(db, { skipMigrate: true });
  let aggregates;
  let labels: Record<string, string> = {};
  try {
    aggregates = computeAggregates(store, {
      ...(afterTs !== undefined ? { afterTs } : {}),
      ...(beforeTs !== undefined ? { beforeTs } : {}),
    });
    const impact = computeImpact(aggregates, { topN });
    labels = resolveLabels(store, [
      ...impact.topMemories.map((m) => m.blockId),
      ...impact.needsAttention.map((m) => m.blockId),
    ]);

    if (impact.isEmpty) {
      return {
        state: "no-events",
        window,
        impact,
        labels,
      };
    }
    return {
      state: "ok",
      window,
      impact,
      labels,
      debug: aggregates,
    };
  } finally {
    db.close();
  }
}

/**
 * Look up trigger.situation for a set of block ids. Missing ids are
 * silently skipped — usually means the block was retired since the
 * event fired and we don't want to crash the friendly summary on it.
 */
function resolveLabels(store: BlockStore, ids: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const block: ReasoningBlock | null = store.getBlock(id);
    if (!block) continue;
    const label = block.trigger.situation.trim();
    out[id] = label.length > 0 ? label : "(unnamed memory)";
  }
  return out;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

function render(view: SavingsView, debug: boolean): void {
  console.log();
  console.log(pc.bold("TraceBase savings") + pc.dim("  · " + view.window.label));
  console.log();

  switch (view.state) {
    case "uninitialized":
      renderUninitialized();
      return;
    case "no-store":
    case "no-events":
      renderEmpty();
      return;
    case "ok":
      renderOk(view);
      if (debug && view.debug) renderDebug(view.debug);
      return;
  }
}

/**
 * Tiny ascii octopus — matches the SVG mascot's silhouette, lives in
 * the terminal where SVG can't. Used in empty states as a small piece
 * of brand warmth without leaning on emoji that font-render unevenly
 * across terminals.
 */
const OCTOPUS_ASCII = [
  "   ___",
  "  /   \\",
  " | o o |",
  "  \\___/",
  "  / | \\",
  " /  |  \\",
].join("\n");

function renderUninitialized(): void {
  console.log("  " + pc.yellow("Not initialized in this directory."));
  console.log();
  console.log("  Run " + pc.cyan("npx tracebase-ai init") + " to set up TraceBase here.");
  console.log("  Then come back to this command after a few Claude Code sessions.");
  console.log();
}

function renderEmpty(): void {
  for (const line of OCTOPUS_ASCII.split("\n")) {
    console.log(pc.dim("    " + line));
  }
  console.log();
  console.log("  " + pc.bold("No savings yet") + pc.dim(" — the octopus is waiting."));
  console.log();
  console.log("  TraceBase records what helped each time Claude Code solves a task.");
  console.log("  Once you've had a few sessions, this command shows you how much time it saved.");
  console.log();
  console.log("  Verify the install: " + pc.cyan("npx tracebase-ai doctor"));
  console.log();
}

function renderOk(view: SavingsView): void {
  const impact = view.impact!;
  const hedge = impact.confidence === "measured" ? "" : pc.dim(" (estimated)");

  console.log(
    "  " + pc.green("✓") + " Helped you on " +
    pc.bold(String(impact.helpedTasks)) +
    pc.dim(" of ") +
    pc.bold(String(impact.assistedTasks)) +
    " assisted task" +
    (impact.assistedTasks === 1 ? "" : "s"),
  );
  console.log(
    "  " + pc.cyan("⏱") + " ~" +
    pc.bold(String(impact.estimatedMinutesSaved)) +
    " min saved" + hedge,
  );
  console.log(
    "  " + pc.magenta("💬") + " ~" +
    pc.bold(formatTokenCount(impact.estimatedTokensSaved)) +
    " tokens recycled" + hedge,
  );
  console.log(
    "  " + pc.dim("📚 " + impact.memoriesUsed + " memor" +
    (impact.memoriesUsed === 1 ? "y" : "ies") + " actually used"),
  );

  if (impact.topMemories.length > 0) {
    console.log();
    console.log(pc.bold("  Top memories"));
    impact.topMemories.forEach((m, i) => {
      const label = view.labels[m.blockId] ?? `(block ${m.blockId.slice(0, 8)}…)`;
      const trimmed = truncate(label, 60);
      console.log(
        "    " + pc.dim(`${i + 1}.`) + " " + trimmed + "  " +
        pc.dim(`(used ${m.agentUsed}× · helpful ${m.helpful}×)`),
      );
    });
  }

  if (impact.needsAttention.length > 0) {
    console.log();
    console.log(pc.bold("  Needs attention ") + pc.dim("(injected but didn't help)"));
    impact.needsAttention.forEach((m) => {
      const label = view.labels[m.blockId] ?? `(block ${m.blockId.slice(0, 8)}…)`;
      const trimmed = truncate(label, 60);
      console.log(
        "    " + pc.yellow("•") + " " + trimmed + "  " +
        pc.dim(`(${m.counterproductive} miss${m.counterproductive === 1 ? "" : "es"} of ${m.injected})`),
      );
    });
  }

  console.log();
  if (impact.confidence === "estimated") {
    console.log(pc.dim("  Numbers above are estimates. Once TraceBase has enough comparison data,"));
    console.log(pc.dim("  this command flips to measured values."));
    console.log();
  }
}

function renderDebug(aggregates: unknown): void {
  console.log(pc.bold("  Debug — technical metrics"));
  console.log(pc.dim("  (this is the same data `tracebase-ai report` shows)"));
  console.log();
  const agg = aggregates as {
    counts: Record<string, number>;
    rates: Record<string, number | null>;
  };
  console.log(
    pc.dim("    counts: ") +
    Object.entries(agg.counts)
      .map(([k, v]) => `${k}=${v}`)
      .join(" · "),
  );
  console.log(
    pc.dim("    rates:  ") +
    Object.entries(agg.rates)
      .map(([k, v]) => `${k}=${v === null ? "n/a" : (v as number).toFixed(3)}`)
      .join(" · "),
  );
  console.log();
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

function humanWindowLabel(since?: string, before?: string): string {
  if (!since && !before) return "all time";
  const parts: string[] = [];
  if (since) parts.push("since " + since);
  if (before) parts.push("before " + before);
  return parts.join(" · ");
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return (n / 1000).toFixed(1) + "k";
  if (n < 1_000_000) return Math.round(n / 1000) + "k";
  return (n / 1_000_000).toFixed(1) + "M";
}
