/**
 * Internal silent-injection payload builder.
 *
 * Production caller: the `tracebase inject-context` CLI command,
 * which is spawned by host pre-prompt hooks (Claude Code
 * `UserPromptSubmit` / `SessionStart`, and any future adapters
 * wired to the same envelope).
 * The payload it returns is wrapped in a host envelope and
 * surfaced as `additionalContext` — the agent reads it as
 * background knowledge alongside the user's prompt and never
 * narrates a tool call.
 *
 * Why a new builder instead of reusing `formatInjection`:
 *   • The legacy "tool" voice has audit sub-ribbons (`<sub>Audit:
 *     block …, calibrated …</sub>`) and an explicit "These are
 *     hypotheses to verify" preamble. That phrasing makes the
 *     agent narrate ("Looking at the prior hypotheses, I see…").
 *     Silent injection wants the opposite: terse prose the agent
 *     can absorb without acknowledging the source.
 *   • Hooks have a hard host-side ceiling (Claude Code: 10 KB
 *     `additionalContext`). The builder enforces a soft character
 *     budget so a noisy store cannot break a real user prompt.
 *   • Outcome attribution needs to know *which* items the agent
 *     actually saw — the budget can drop low-ranked items, so the
 *     builder reports the ids that survived in `blockIds` /
 *     `factIds`. The MCP tool path doesn't need this because it
 *     never budgets.
 *
 * The legacy `formatInjection` (block-serving.ts) is the tool-path
 * voice — kept for the MCP `get_reasoning_patterns` response and
 * for any external consumer that wants the audit ribbons.
 */
import type { RecallV2Result, BlockHit, FactHit } from "./block-serving.js";

export interface BuildInjectionPayloadOptions {
  /**
   * Soft character budget. The builder fills in score-order until
   * the next item would push the total over `tokenBudget * 4`
   * characters (≈ 4 chars per token, the rule of thumb for English
   * text), then stops. Items already included are never sliced —
   * they're either fully in or fully out, so the agent never reads
   * a half-sentence. Default 1200 tokens (≈ 4800 chars), well
   * below Claude Code's 10 KB hook ceiling.
   */
  tokenBudget?: number;
  /** Hard cap on rendered blocks regardless of budget. Default 4. */
  maxBlocks?: number;
  /** Hard cap on rendered facts regardless of budget. Default 4. */
  maxFacts?: number;
}

export interface InjectionPayload {
  /** Final text. Empty string when nothing renderable cleared the gate. */
  text: string;
  /** True iff `text` is non-empty. Convenience for callers. */
  hasContent: boolean;
  /** queryId from the recall — required for downstream outcome attribution. */
  queryId: string;
  /**
   * Block ids that *appear in `text`*. May be a subset of the gate-
   * passing set if the budget cut them. Use this — not
   * `result.blocks` — when reporting `agent_used` so attribution
   * matches what the agent actually read.
   */
  blockIds: string[];
  /** Same contract as blockIds. */
  factIds: string[];
  /** Rough token estimate (chars / 4, ceiled). 0 when text is empty. */
  tokensEstimate: number;
}

const DEFAULT_TOKEN_BUDGET = 1200;
const DEFAULT_MAX_BLOCKS = 4;
const DEFAULT_MAX_FACTS = 4;
/** Common English heuristic — good enough for budgeting against the 10 KB ceiling. */
const CHARS_PER_TOKEN = 4;

/**
 * Convert a recall result to silent injection text.
 *
 * Empty contract: when no item passes the gate (or the result is a
 * shadow / no-inject), returns `{ text: "", hasContent: false, … }`
 * with empty id arrays. Hook callers can short-circuit safely and
 * emit an empty `additionalContext` envelope.
 */
export function buildInjectionPayload(
  result: RecallV2Result,
  opts: BuildInjectionPayloadOptions = {},
): InjectionPayload {
  const tokenBudget = Math.max(0, opts.tokenBudget ?? DEFAULT_TOKEN_BUDGET);
  const charBudget = tokenBudget * CHARS_PER_TOKEN;
  const maxBlocks = Math.max(0, opts.maxBlocks ?? DEFAULT_MAX_BLOCKS);
  const maxFacts = Math.max(0, opts.maxFacts ?? DEFAULT_MAX_FACTS);

  const empty: InjectionPayload = {
    text: "",
    hasContent: false,
    queryId: result.queryId,
    blockIds: [],
    factIds: [],
    tokensEstimate: 0,
  };

  if (!result.shouldInject) return empty;

  // Gate contract: items below the gate live in `result` for
  // inspection but never reach the prompt.
  const gatedBlocks = result.blocks.filter((h) => h.passesGate).slice(0, maxBlocks);
  const gatedFacts = result.facts.filter((h) => h.passesGate).slice(0, maxFacts);
  if (gatedBlocks.length === 0 && gatedFacts.length === 0) return empty;

  const blockLines = gatedBlocks.map(renderBlockSilent);
  const factLines = gatedFacts.map(renderFactSilent);

  // Frame: queryId-tagged wrapper so `record_reasoning_outcome` can
  // close the loop, plus a one-line lead-in. The lead-in is plain
  // English — never "These are HYPOTHESES" or "you must" — because
  // the agent is reading this as if a human teammate wrote a note.
  const open = `<tracebase queryId="${result.queryId}">`;
  const close = `</tracebase>`;
  const lead =
    gatedBlocks.length > 0 && gatedFacts.length > 0
      ? "Relevant prior patterns and project facts from this codebase:"
      : gatedBlocks.length > 0
        ? "Relevant prior patterns from this codebase:"
        : "Relevant project facts:";

  // Budget walk. Reserve `open + lead + close` headroom then add
  // items in score order, dropping any item that would push us
  // over. Items are kept fully or not at all.
  const fixedHeadroom = open.length + 1 + lead.length + 2 + close.length + 1;
  const sectionGap =
    gatedBlocks.length > 0 && gatedFacts.length > 0 ? 1 + "Project facts:".length + 1 : 0;
  let used = fixedHeadroom + sectionGap;
  const keptBlocks: { hit: BlockHit; line: string }[] = [];
  for (let i = 0; i < gatedBlocks.length; i++) {
    const hit = gatedBlocks[i]!;
    const line = blockLines[i]!;
    const cost = line.length + 1; // +newline
    if (used + cost > charBudget) break;
    used += cost;
    keptBlocks.push({ hit, line });
  }
  const keptFacts: { hit: FactHit; line: string }[] = [];
  for (let i = 0; i < gatedFacts.length; i++) {
    const hit = gatedFacts[i]!;
    const line = factLines[i]!;
    const cost = line.length + 1;
    if (used + cost > charBudget) break;
    used += cost;
    keptFacts.push({ hit, line });
  }

  // Edge case: a budget so tight that nothing fit. Prefer a mild
  // overshoot over silence — keep the top-scored item.
  if (keptBlocks.length === 0 && keptFacts.length === 0) {
    if (gatedBlocks.length > 0) {
      keptBlocks.push({ hit: gatedBlocks[0]!, line: blockLines[0]! });
    } else if (gatedFacts.length > 0) {
      keptFacts.push({ hit: gatedFacts[0]!, line: factLines[0]! });
    }
  }

  if (keptBlocks.length === 0 && keptFacts.length === 0) return empty;

  const parts: string[] = [open, lead];
  if (keptBlocks.length > 0) {
    for (const k of keptBlocks) parts.push(k.line);
  }
  if (keptFacts.length > 0) {
    if (keptBlocks.length > 0) parts.push("", "Project facts:");
    for (const k of keptFacts) parts.push(k.line);
  }
  parts.push(close);

  const text = parts.join("\n");
  return {
    text,
    hasContent: true,
    queryId: result.queryId,
    blockIds: keptBlocks.map((k) => k.hit.block.id),
    factIds: keptFacts.map((k) => k.hit.fact.id),
    tokensEstimate: Math.ceil(text.length / CHARS_PER_TOKEN),
  };
}

function renderBlockSilent(hit: BlockHit): string {
  // Compact bullet:
  //   • <Situation, capitalized>. Mechanism: <…>. Fix: <unlock>. Verify: <verification>.
  //   (followed by `Avoid: a; b` only when dead ends are present)
  //
  // We deliberately do NOT mention "block id", "calibrated probability",
  // or anything that signals tooling. The agent should read the line
  // and judge fit on the merits of the prose.
  const situation = capitalize(hit.block.trigger.situation.trim()).replace(/[.\s]+$/, "");
  const mechanism = trimSentence(hit.block.body.mechanism);
  const unlock = trimSentence(hit.block.body.unlock);
  const verification = trimSentence(hit.block.body.verification);
  const main = `• ${situation}. Mechanism: ${mechanism}. Fix: ${unlock}. Verify: ${verification}.`;
  if (hit.block.body.deadEnds.length === 0) return main;
  const avoid = hit.block.body.deadEnds
    .map((s) => trimSentence(s).replace(/[.;]+$/, ""))
    .filter(Boolean)
    .join("; ");
  return avoid ? `${main} Avoid: ${avoid}.` : main;
}

function renderFactSilent(hit: FactHit): string {
  return `• ${trimSentence(hit.fact.statement)}`;
}

function capitalize(s: string): string {
  if (s.length === 0) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function trimSentence(s: string): string {
  // Collapse interior whitespace, strip trailing periods (we re-add
  // our own punctuation in the renderer so we don't produce
  // "verify..").
  const collapsed = s.replace(/\s+/g, " ").trim();
  return collapsed.replace(/\.+$/, "");
}
