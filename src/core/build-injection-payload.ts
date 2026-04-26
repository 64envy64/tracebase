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
import type { FileHit } from "./file-indexer.js";

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
  /**
   * 0.7.0-rc.3 §rc.3 — file memory hits to render inside an
   * explicit `<file_memory>…</file_memory>` tag below the block /
   * fact sections. Top-K hits ranked by FTS5 bm25; the section is
   * dropped cleanly if budget is tight. Default 3 hits, hard
   * ceiling 6 (anything beyond starts hurting prompt focus more
   * than it helps recall).
   */
  fileHits?: FileHit[];
  /** Hard cap on rendered file lines regardless of budget. Default 3. */
  maxFiles?: number;
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
  /**
   * 0.7.0-rc.3 §rc.3 — repo-relative file paths that appear in the
   * rendered `<file_memory>` section. Same contract as blockIds /
   * factIds: empty when no file recall fired or the budget dropped
   * them all. Used by recallForPrompt to emit
   * `file_memory.recalled` analytics with the matching ids.
   */
  fileIds: string[];
  /**
   * 0.7.0-rc.3 §rc.3 — total `size_bytes` of the source files
   * surfaced via the `<file_memory>` section. The agent uses
   * recall-summary instead of re-reading; this is the rough
   * "bytes avoided" the badge surfaces. Aggregate only — file
   * paths / hashes / contents never reach the cloud.
   */
  bytesAvoided: number;
  /** Rough token estimate (chars / 4, ceiled). 0 when text is empty. */
  tokensEstimate: number;
  /**
   * 0.7.0-rc.3 hardening — token cost of the `<file_memory>`
   * section ONLY (tags + lines), separate from the full payload's
   * `tokensEstimate`. The recall path uses this — not the payload
   * total — when emitting `file_memory.recalled.tokensInjected`,
   * so the per-mechanism metric isn't inflated by the cost of
   * blocks / facts / `<prior_fix>` segments. Equals 0 when no
   * file lines made it past the budget.
   *
   * Required for rc.7 `file_memory_avoided = size_bytes/4 -
   * tokensInjected` to compute against the correct denominator.
   */
  fileMemoryTokensEstimate: number;
}

const DEFAULT_TOKEN_BUDGET = 1200;
const DEFAULT_MAX_BLOCKS = 4;
const DEFAULT_MAX_FACTS = 4;
const DEFAULT_MAX_FILES = 3;
const FILE_MAX_HARD_CEILING = 6;
/** Common English heuristic — good enough for budgeting against the 10 KB ceiling. */
const CHARS_PER_TOKEN = 4;
/** Per-file-line clamp inside the `<file_memory>` section. */
const FILE_LINE_MAX_CHARS = 220;

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
  const maxFiles = Math.min(
    Math.max(0, opts.maxFiles ?? DEFAULT_MAX_FILES),
    FILE_MAX_HARD_CEILING,
  );

  const empty: InjectionPayload = {
    text: "",
    hasContent: false,
    queryId: result.queryId,
    blockIds: [],
    factIds: [],
    fileIds: [],
    bytesAvoided: 0,
    tokensEstimate: 0,
    fileMemoryTokensEstimate: 0,
  };

  // 0.7.0-rc.3 hardening — file memory MUST inject independently
  // of block/fact recall. `shouldInject` is computed from blocks +
  // facts only, so a recall where indexed files match but no
  // procedural pattern hits would never render the
  // `<file_memory>` section pre-hardening.
  //
  // Honest gate now:
  //   - `result.shadow` is the holdout / diagnostic-shadow flag —
  //     in that arm we MUST stay silent across all sections, file
  //     memory included, otherwise we leak treatment-side context
  //     into the control cohort.
  //   - When not shadow, files render even if shouldInject is
  //     false; blocks and facts still respect their own gate.
  if (result.shadow) return empty;

  // Gate contract: items below the gate live in `result` for
  // inspection but never reach the prompt. Block + fact slots
  // continue to honor `shouldInject` so a clean-but-low-confidence
  // hit doesn't leak into the prompt.
  const blockFactGateOpen = result.shouldInject;
  const gatedBlocks = blockFactGateOpen
    ? result.blocks.filter((h) => h.passesGate).slice(0, maxBlocks)
    : [];
  const gatedFacts = blockFactGateOpen
    ? result.facts.filter((h) => h.passesGate).slice(0, maxFacts)
    : [];
  // 0.7.0-rc.3 §rc.3 — file memory hits feed in directly from the
  // caller's recallFiles(). They have no per-item gate (the file
  // indexer's leakage / injection scans gate at write-time), so
  // the maxFiles cap is the only filter here.
  const gatedFiles = (opts.fileHits ?? []).slice(0, maxFiles);
  if (gatedBlocks.length === 0 && gatedFacts.length === 0 && gatedFiles.length === 0) {
    return empty;
  }

  const blockLines = gatedBlocks.map(renderBlockSilent);
  const factLines = gatedFacts.map(renderFactSilent);
  const fileLines = gatedFiles.map(renderFileSilent);

  // Frame: queryId-tagged wrapper so `record_reasoning_outcome` can
  // close the loop, plus a one-line lead-in. The lead-in is plain
  // English — never "These are HYPOTHESES" or "you must" — because
  // the agent is reading this as if a human teammate wrote a note.
  const open = `<tracebase queryId="${result.queryId}">`;
  const close = `</tracebase>`;
  const lead = composeLead({
    hasBlocks: gatedBlocks.length > 0,
    hasFacts: gatedFacts.length > 0,
    hasFiles: gatedFiles.length > 0,
  });

  // 0.7.0-rc.3 §rc.3 — file_memory section is wrapped in an
  // explicit XML tag so the agent treats summaries as background
  // recall (same scepticism level as `<prior_fix source="imported">`),
  // not authoritative procedural patterns. Tag overhead is
  // accounted for in the budget walk below.
  const fileTagOpen = `<file_memory>`;
  const fileTagClose = `</file_memory>`;
  const fileSectionFixed =
    gatedFiles.length > 0
      ? fileTagOpen.length + 1 + fileTagClose.length + 1
      : 0;

  // Budget walk. Reserve `open + lead + close` headroom then add
  // items in score order, dropping any item that would push us
  // over. Items are kept fully or not at all.
  const fixedHeadroom = open.length + 1 + lead.length + 2 + close.length + 1;
  const sectionGap =
    gatedBlocks.length > 0 && gatedFacts.length > 0 ? 1 + "Project facts:".length + 1 : 0;
  let used = fixedHeadroom + sectionGap + fileSectionFixed;
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
  const keptFiles: { hit: FileHit; line: string }[] = [];
  for (let i = 0; i < gatedFiles.length; i++) {
    const hit = gatedFiles[i]!;
    const line = fileLines[i]!;
    const cost = line.length + 1;
    if (used + cost > charBudget) break;
    used += cost;
    keptFiles.push({ hit, line });
  }

  // Edge case: a budget so tight that nothing fit. Prefer a mild
  // overshoot over silence — keep the top-scored item across all
  // three pools.
  if (
    keptBlocks.length === 0 &&
    keptFacts.length === 0 &&
    keptFiles.length === 0
  ) {
    if (gatedBlocks.length > 0) {
      keptBlocks.push({ hit: gatedBlocks[0]!, line: blockLines[0]! });
    } else if (gatedFacts.length > 0) {
      keptFacts.push({ hit: gatedFacts[0]!, line: factLines[0]! });
    } else if (gatedFiles.length > 0) {
      keptFiles.push({ hit: gatedFiles[0]!, line: fileLines[0]! });
    }
  }

  if (
    keptBlocks.length === 0 &&
    keptFacts.length === 0 &&
    keptFiles.length === 0
  ) {
    return empty;
  }

  const parts: string[] = [open, lead];
  if (keptBlocks.length > 0) {
    for (const k of keptBlocks) parts.push(k.line);
  }
  if (keptFacts.length > 0) {
    if (keptBlocks.length > 0) parts.push("", "Project facts:");
    for (const k of keptFacts) parts.push(k.line);
  }
  if (keptFiles.length > 0) {
    parts.push("", fileTagOpen);
    for (const k of keptFiles) parts.push(k.line);
    parts.push(fileTagClose);
  }
  parts.push(close);

  const text = parts.join("\n");
  // 0.7.0-rc.3 hardening — per-section token accounting. The
  // file-memory section's cost is the wrap tags + each kept file
  // line's chars (with newlines), NOT the full payload total.
  // Used by recallForPrompt to populate
  // `file_memory.recalled.tokensInjected` honestly.
  const fileMemoryChars =
    keptFiles.length === 0
      ? 0
      : fileTagOpen.length +
        1 +
        keptFiles.reduce((acc, k) => acc + k.line.length + 1, 0) +
        fileTagClose.length;
  const fileMemoryTokensEstimate =
    fileMemoryChars > 0 ? Math.ceil(fileMemoryChars / CHARS_PER_TOKEN) : 0;
  return {
    text,
    hasContent: true,
    queryId: result.queryId,
    blockIds: keptBlocks.map((k) => k.hit.block.id),
    factIds: keptFacts.map((k) => k.hit.fact.id),
    fileIds: keptFiles.map((k) => k.hit.relPath),
    bytesAvoided: keptFiles.reduce((acc, k) => acc + (k.hit.sizeBytes ?? 0), 0),
    tokensEstimate: Math.ceil(text.length / CHARS_PER_TOKEN),
    fileMemoryTokensEstimate,
  };
}

function composeLead(opts: {
  hasBlocks: boolean;
  hasFacts: boolean;
  hasFiles: boolean;
}): string {
  // The lead phrasing focuses on whatever the agent will read MOST —
  // patterns + facts dominate when present; file memory plays a
  // supporting role and is folded into the lead when nothing else
  // is there.
  if (opts.hasBlocks && opts.hasFacts) {
    return "Relevant prior patterns and project facts from this codebase:";
  }
  if (opts.hasBlocks) {
    return "Relevant prior patterns from this codebase:";
  }
  if (opts.hasFacts) {
    return "Relevant project facts:";
  }
  // Files-only path — explicit lead-in so the agent doesn't read
  // the bare tag as protocol.
  return "Relevant file context:";
}

// 0.7.0-rc.1 §Ground — provenance trust differentiation. Content
// imported from outside the local workspace (gold-patch corpora,
// JSONL exports of another project, third-party knowledge bases) is
// rendered inside an explicit `<prior_fix source="imported">` tag so
// the agent treats it with the same scepticism as web search
// results. Local content (the default) ships untagged, identical to
// the pre-0.7 voice. The CLAUDE.md / AGENTS.md update in §0.7.0
// stable documents the tag's contract for the model side.
const IMPORTED_TAG_OPEN = `<prior_fix source="imported">`;
const IMPORTED_TAG_CLOSE = `</prior_fix>`;

function wrapIfImported(line: string, imported: boolean): string {
  return imported ? `${IMPORTED_TAG_OPEN}${line}${IMPORTED_TAG_CLOSE}` : line;
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
  const imported = hit.block.provenance.extractedFrom === "imported";
  if (hit.block.body.deadEnds.length === 0) {
    return wrapIfImported(main, imported);
  }
  const avoid = hit.block.body.deadEnds
    .map((s) => trimSentence(s).replace(/[.;]+$/, ""))
    .filter(Boolean)
    .join("; ");
  const full = avoid ? `${main} Avoid: ${avoid}.` : main;
  return wrapIfImported(full, imported);
}

function renderFactSilent(hit: FactHit): string {
  const line = `• ${trimSentence(hit.fact.statement)}`;
  return wrapIfImported(line, hit.fact.source.origin === "imported");
}

/**
 * 0.7.0-rc.3 §rc.3 — render a file-memory hit as a single bullet
 * line: `• <relPath>: <summary>` clamped to FILE_LINE_MAX_CHARS.
 * The full `<file_memory>` wrapper is added by the caller so the
 * tag bytes count once per section, not per line.
 */
function renderFileSilent(hit: FileHit): string {
  const summary = trimSentence(hit.summary);
  const raw = `• ${hit.relPath}: ${summary}`;
  return clampFileLine(raw);
}

function clampFileLine(s: string): string {
  if (s.length <= FILE_LINE_MAX_CHARS) return s;
  const slice = s.slice(0, FILE_LINE_MAX_CHARS);
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace > FILE_LINE_MAX_CHARS - 40) return slice.slice(0, lastSpace) + "…";
  return slice + "…";
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
