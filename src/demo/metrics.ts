/**
 * Pure metric derivation for the agentic demo harness.
 *
 * Takes two `RunArtifact`s for the same task — the OFF run and the ON
 * run — and produces a `ComparisonReport`. No I/O, no clocks, no
 * randomness; the same inputs always produce the same output. This is
 * the place to put any rule we want exercised by `tests/demo/`.
 */

import type {
  ComparisonDelta,
  ComparisonReport,
  RunArtifact,
} from "./types.js";

/**
 * Compute the headline comparison report from two run artifacts.
 *
 * Defensive checks: refuse to compare runs that disagree on `task`,
 * or where the `variant` fields don't match the `(off, on)` argument
 * order. Demo numbers are easy to mix up if the runner accidentally
 * swaps which file is which; we'd rather throw than silently invert
 * the savings sign.
 *
 * 2026-05-23 — `source` is now a single-value literal (`"real"`).
 * Synthetic fixtures are gone; the source-mismatch check that lived
 * here is dead code under the narrowed type.
 */
export function computeComparison(
  off: RunArtifact,
  on: RunArtifact,
): ComparisonReport {
  if (off.task !== on.task) {
    throw new Error(`task mismatch: off=${off.task}, on=${on.task}`);
  }
  if (off.variant !== "off" || on.variant !== "on") {
    throw new Error(
      `variant mismatch: expected (off, on); got (${off.variant}, ${on.variant})`,
    );
  }

  // The on-run may legally carry tracebase=null when an ON run
  // produced no TraceBase activity (e.g. retrieval refused every
  // candidate). Treat missing telemetry as zero — defensive.
  const injectedTokens = on.tracebase?.injectedTokens ?? 0;
  const overheadMs = on.tracebase?.overheadMs ?? 0;
  const blockedToolCalls = on.tracebase?.blockedToolCalls ?? 0;

  const tokensTotalRaw = off.tokens.total - on.tokens.total;
  const tokensTotalNet = tokensTotalRaw - injectedTokens;

  const delta: ComparisonDelta = {
    timeMs: off.wallClockMs - on.wallClockMs,
    toolCalls: off.toolCalls.total - on.toolCalls.total,
    duplicates: off.toolCalls.duplicates - on.toolCalls.duplicates,
    tokensTotal: tokensTotalRaw,
    tokensTotalNet,
    injectedTokens,
    blockedToolCalls,
    overheadMs,
    verifierAgreement: pickAgreement(off.verifier.pass, on.verifier.pass),
  };
  return { task: off.task, off, on, delta };
}

function pickAgreement(
  offPass: boolean,
  onPass: boolean,
): ComparisonDelta["verifierAgreement"] {
  if (offPass && onPass) return "both-pass";
  if (!offPass && !onPass) return "both-fail";
  if (offPass && !onPass) return "off-pass-on-fail";
  return "off-fail-on-pass";
}

/**
 * Render a markdown comparison table. Pure function so the report
 * script and any embedded preview can share one formatter.
 */
export function renderComparisonMarkdown(report: ComparisonReport): string {
  const { task, off, on, delta } = report;
  const lines: string[] = [];
  lines.push(`## ${task}  ·  **Real-agent recording**`);
  lines.push("");
  lines.push(
    `Off model: ${off.model} · On model: ${on.model} · token source: off=${off.tokens.source} / on=${on.tokens.source}`,
  );
  if (off.notes || on.notes) {
    lines.push(`Notes: off=${off.notes ?? "—"} · on=${on.notes ?? "—"}`);
  }
  lines.push("");
  lines.push("| Metric | OFF | ON | Δ |");
  lines.push("|---|---:|---:|---:|");
  lines.push(
    `| Wall-clock (ms) | ${off.wallClockMs} | ${on.wallClockMs} | ${signed(delta.timeMs)} |`,
  );
  lines.push(
    `| Tokens (total) | ${off.tokens.total} | ${on.tokens.total} | ${signed(delta.tokensTotal)} |`,
  );
  lines.push(
    `| TraceBase injected tokens | — | ${delta.injectedTokens} | — |`,
  );
  lines.push(
    `| **Net tokens saved (Δ − injected)** | — | — | **${signed(delta.tokensTotalNet)}** |`,
  );
  lines.push(
    `| Tool calls | ${off.toolCalls.total} | ${on.toolCalls.total} | ${signed(delta.toolCalls)} |`,
  );
  lines.push(
    `| Duplicate tool calls | ${off.toolCalls.duplicates} | ${on.toolCalls.duplicates} | ${signed(delta.duplicates)} |`,
  );
  lines.push(
    `| Blocked tool calls (supervision) | — | ${delta.blockedToolCalls} | — |`,
  );
  lines.push(`| TraceBase overhead (ms) | — | ${delta.overheadMs} | — |`);
  lines.push(
    `| Verifier | ${off.verifier.pass ? "PASS" : "FAIL"} | ${on.verifier.pass ? "PASS" : "FAIL"} | ${delta.verifierAgreement} |`,
  );
  lines.push("");
  return lines.join("\n");
}

function signed(n: number): string {
  if (n === 0) return "0";
  return n > 0 ? `+${n}` : `${n}`;
}
