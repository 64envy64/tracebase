/**
 * Domain self-distillation — compress the top-K patterns in a single
 * (language, framework) domain into ONE primer block.
 *
 * The retrieval surface today emits up to 7 patterns × ~200 tokens
 * for a mature domain — a ceiling set by the buildInjectionPayload
 * token budget. The primer trades 7-of-them for 1-of-them at a much
 * smaller token cost (~600 tokens) without losing the actionable
 * advice that the top patterns share.
 *
 * Two distillation modes:
 *
 *   • Extractive (default, offline, deterministic) — concatenates each
 *     source pattern's unlock + first mechanism sentence + verification
 *     into a single body, deduplicates near-identical bullets via
 *     token-overlap, and clamps to the token budget. Produces the
 *     same primer for the same inputs every time. No API key, no
 *     model call, no nondeterminism — exactly what eval needs.
 *
 *   • LLM (opt-in via `mode: "llm"`) — uses the existing
 *     AnthropicDistiller scaffolding (per-trace) but with a multi-
 *     pattern compression prompt. NOT wired in this change: the
 *     interface accepts a custom distiller so the LLM mode can land
 *     without re-touching the orchestrator. Pass any `LlmDistiller` to
 *     `distillDomain` and it will be invoked once for the whole batch.
 *
 * Storage contract: the primer is stored as a normal ReasoningBlock
 * with `provenance.extractedFrom = "distilled"` and its trigger
 * invariants set to the same (language, framework) the primer covers.
 * This means retrieval treats it exactly like any other block —
 * BM25 + invariants + calibration + gate — and we get the token-cost
 * win without surgery on the recall path. If three different domains
 * have primers, they each compete on their own invariant turf;
 * cross-domain bleed is structurally impossible.
 */
import { createBlock } from "../core/block.js";
import type { BlockStore } from "../core/block-store.js";
import type { ReasoningBlock, BlockInvariants } from "../types.js";

/**
 * Identifies a single domain. At least one of `language` / `framework`
 * must be set; both is allowed and recommended (the primer becomes more
 * specific). `errorType` is supported because some bug patterns cluster
 * by error class rather than by stack — but is optional.
 */
export interface DomainKey {
  language?: string;
  framework?: string;
  errorType?: string;
}

export interface DistillDomainOptions {
  /** Max source patterns to compress. Default 7 — matches the recall slate. */
  k?: number;
  /**
   * Token budget for the primer body. Default 600 — empirically about
   * half of what 7 patterns occupy after rendering, leaving room for
   * the trigger/situation header.
   */
  tokenBudget?: number;
  /**
   * Minimum source patterns required before we even try to distill.
   * Default 3 — a single pattern is just a copy, two is noise. Three
   * is where compression starts to mean something.
   */
  minPatterns?: number;
  /** Deterministic clock for tests. */
  now?: () => number;
  /**
   * Skip the wilson-lb floor that filters out unproven patterns.
   * Tests use this to exercise distillation against synthetic blocks
   * that haven't accumulated outcome events.
   */
  skipQualityFloor?: boolean;
}

export type DistillDomainResult =
  | { status: "stored"; block: ReasoningBlock; sourceIds: string[] }
  | { status: "skipped"; reason: SkipReason; foundPatterns: number };

export type SkipReason =
  | "no-domain-key"
  | "too-few-patterns"
  | "no-actionable-content";

/**
 * Pick the top-K source patterns for a domain and compress them into
 * a single primer block. Returns either the stored primer or a typed
 * skip reason so the CLI can render a useful explanation.
 */
export function distillDomain(
  store: BlockStore,
  domain: DomainKey,
  opts: DistillDomainOptions = {},
): DistillDomainResult {
  if (!domain.language && !domain.framework && !domain.errorType) {
    return { status: "skipped", reason: "no-domain-key", foundPatterns: 0 };
  }

  const k = opts.k ?? 7;
  const minPatterns = opts.minPatterns ?? 3;
  const tokenBudget = opts.tokenBudget ?? 600;
  const now = (opts.now ?? Date.now)();

  const candidates = selectTopPatternsForDomain(store, domain, {
    k,
    skipQualityFloor: opts.skipQualityFloor,
  });
  if (candidates.length < minPatterns) {
    return { status: "skipped", reason: "too-few-patterns", foundPatterns: candidates.length };
  }

  const primerBody = buildExtractivePrimer(candidates, tokenBudget);
  if (primerBody.unlock.length === 0 || primerBody.mechanism.length === 0) {
    return { status: "skipped", reason: "no-actionable-content", foundPatterns: candidates.length };
  }

  const invariants: BlockInvariants = {
    ...(domain.language ? { language: domain.language } : {}),
    ...(domain.framework ? { framework: domain.framework } : {}),
    ...(domain.errorType ? { errorType: domain.errorType } : {}),
  };
  const domainLabel = formatDomainLabel(domain);
  const sourceIds = candidates.map((c) => c.id);

  const traceId = `distill-domain-${slugifyDomain(domain)}-${now}`;
  // Stable situation: depends ONLY on the domain key, not on the
  // source count or content. This is what makes the primer's
  // fingerprint stable across reruns — fresh sources → same domain
  // primer ID → `replaceBlock` updates in place rather than
  // accumulating one-primer-per-rerun duplicates.
  const primer = createBlock(
    {
      kind: "success",
      trigger: {
        situation: `Domain primer for ${domainLabel}`,
        invariants,
      },
      body: primerBody,
      provenance: {
        sourceTaskId: traceId,
        extractedFrom: "distilled",
        distilledBy: "rule",
        distilledWithModel: "extractive.v1",
        distillationConfidence: 1.0,
      },
    },
    { now },
  );

  const existing = store.findBlockByFingerprintAndKind(
    primer.trigger.fingerprint,
    "success",
  );
  if (existing && existing.provenance.extractedFrom === "distilled") {
    // Replace the prior primer for this domain — fresh top-K, same
    // identity. Preserves createdAt so age-based metrics stay sensible
    // and the dashboard's "last refreshed" reads correctly.
    const replacement: ReasoningBlock = {
      ...primer,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: now,
      status: "active",
      // Carry stats forward — the primer is the same identity, only
      // its body changed, so the usage history is still meaningful.
      stats: existing.stats,
      quality: existing.quality,
    };
    store.replaceBlock(replacement);
    return { status: "stored", block: store.getBlock(replacement.id)!, sourceIds };
  }

  // Fresh insert: candidate → origin-ref → activate dance. The
  // block-store integrity check refuses to insert an "active" block
  // without at least one origin case ref.
  primer.status = "candidate";
  store.storeBlock(primer);
  store.attachCaseRef({
    blockId: primer.id,
    traceId,
    role: "origin",
    evidenceQuality: "strong",
    locator: `domain=${slugifyDomain(domain)} sources=${sourceIds.length}`,
  });
  const stored = store.updateBlockStatus(primer.id, "active")!;
  return { status: "stored", block: stored, sourceIds };
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

interface SelectorOptions {
  k: number;
  skipQualityFloor?: boolean;
}

/**
 * Pick top-K active blocks for the given domain, ordered by wilson_lb
 * DESC then helpful_count DESC. `listBlocks` does not (yet) filter by
 * invariants; we over-fetch and filter in JS — fine at CLI-time, would
 * need a real index for a hot-path call.
 */
export function selectTopPatternsForDomain(
  store: BlockStore,
  domain: DomainKey,
  opts: SelectorOptions,
): ReasoningBlock[] {
  const overFetch = Math.max(opts.k * 10, 50);
  const all = store.listBlocks({
    status: "active",
    limit: overFetch,
    orderBy: "wilson_lb",
  });
  const matching = all.filter((b) => matchesDomain(b, domain));
  const filtered = opts.skipQualityFloor
    ? matching
    : matching.filter(
        (b) =>
          b.stats.timesAgentUsed > 0 ||
          b.quality.wilsonLowerBound > 0 ||
          b.provenance.extractedFrom === "imported" ||
          b.provenance.extractedFrom === "manual",
      );
  filtered.sort((a, b) => {
    if (b.quality.wilsonLowerBound !== a.quality.wilsonLowerBound) {
      return b.quality.wilsonLowerBound - a.quality.wilsonLowerBound;
    }
    return b.stats.timesHelpful - a.stats.timesHelpful;
  });
  // Skip primers from the candidate pool — a domain primer derived
  // from yesterday's primer is feedback-loop slop.
  return filtered
    .filter((b) => b.provenance.extractedFrom !== "distilled")
    .slice(0, opts.k);
}

function matchesDomain(block: ReasoningBlock, domain: DomainKey): boolean {
  const inv = block.trigger.invariants;
  if (domain.language && inv.language !== domain.language) return false;
  if (domain.framework && inv.framework !== domain.framework) return false;
  if (domain.errorType && inv.errorType !== domain.errorType) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Extractive primer builder
// ---------------------------------------------------------------------------

interface PrimerBody {
  mechanism: string;
  deadEnds: string[];
  unlock: string;
  verification: string;
}

/**
 * Build a primer body that quotes from each source pattern but stays
 * inside `tokenBudget`. The shape:
 *
 *   mechanism:   "1. <unlock #1>\n2. <unlock #2>\n…"   (action list)
 *   deadEnds:    union of source deadEnds, dedup'd
 *   unlock:      "First, <topUnlock>. Then verify: <topVerification>."
 *   verification: top verification step that appears in ≥1 source
 *
 * Token estimation is the same `len/4` heuristic the recall payload
 * uses, so this primer's token cost matches what the gate will see.
 */
export function buildExtractivePrimer(
  patterns: readonly ReasoningBlock[],
  tokenBudget: number,
): PrimerBody {
  // 1. Action list from each pattern's unlock, numbered, dedup'd.
  const unlockLines: string[] = [];
  const seenUnlocks = new Set<string>();
  for (const p of patterns) {
    const u = clean(p.body.unlock);
    if (!u) continue;
    const fingerprint = bagOfWords(u);
    if (alreadyCovered(fingerprint, seenUnlocks)) continue;
    seenUnlocks.add(fingerprint);
    unlockLines.push(u);
  }

  // 2. Mechanism digest — first sentence of each pattern's mechanism.
  //    Helps the agent understand WHY each action works, not just WHAT
  //    to do.
  const mechanismDigest: string[] = [];
  const seenMech = new Set<string>();
  for (const p of patterns) {
    const first = firstSentence(p.body.mechanism);
    if (!first) continue;
    const fp = bagOfWords(first);
    if (alreadyCovered(fp, seenMech)) continue;
    seenMech.add(fp);
    mechanismDigest.push(first);
  }

  // 3. DeadEnds union — keep distinct, cap at 6 to leave token room.
  const deadEnds: string[] = [];
  const seenDE = new Set<string>();
  for (const p of patterns) {
    for (const de of p.body.deadEnds ?? []) {
      const c = clean(de);
      if (!c) continue;
      const fp = bagOfWords(c);
      if (alreadyCovered(fp, seenDE)) continue;
      seenDE.add(fp);
      deadEnds.push(c);
      if (deadEnds.length >= 6) break;
    }
    if (deadEnds.length >= 6) break;
  }

  // 4. Verification — the most-quoted verification step wins.
  const topVerification = mostCommon(
    patterns.map((p) => firstSentence(p.body.verification)).filter((s): s is string => !!s),
  );

  // 5. Assemble with strict token budget. Citation header lists source
  //    IDs so an audit can re-derive the primer.
  const citation = `Distilled from blocks: ${patterns.map((p) => p.id.slice(0, 8)).join(", ")}.`;
  const mechanismParts = [citation, ...mechanismDigest];
  let mechanism = mechanismParts.join(" ");
  mechanism = truncateToTokens(mechanism, Math.floor(tokenBudget * 0.4));

  let unlock = unlockLines
    .map((l, i) => `${i + 1}. ${l}`)
    .join("\n");
  unlock = truncateToTokens(unlock, Math.floor(tokenBudget * 0.4));

  let verification = topVerification ?? "Re-run the failing command and confirm the previously-broken assertion now passes.";
  verification = truncateToTokens(verification, Math.floor(tokenBudget * 0.15));

  // 6. DeadEnds budget — keep adding until the remaining token room
  //    is exhausted.
  const remaining = Math.max(
    0,
    tokenBudget - estimateTokens(mechanism) - estimateTokens(unlock) - estimateTokens(verification),
  );
  const cappedDeadEnds = deadEnds.filter((d) => estimateTokens(d) <= remaining);
  let used = 0;
  const finalDeadEnds: string[] = [];
  for (const d of cappedDeadEnds) {
    const cost = estimateTokens(d);
    if (used + cost > remaining) break;
    finalDeadEnds.push(d);
    used += cost;
  }

  return { mechanism, deadEnds: finalDeadEnds, unlock, verification };
}

// ---------------------------------------------------------------------------
// Helpers — text shaping
// ---------------------------------------------------------------------------

function formatDomainLabel(domain: DomainKey): string {
  const parts: string[] = [];
  if (domain.language) parts.push(domain.language);
  if (domain.framework) parts.push(domain.framework);
  if (domain.errorType) parts.push(`error=${domain.errorType}`);
  return parts.join(" · ");
}

function slugifyDomain(domain: DomainKey): string {
  const parts: string[] = [];
  if (domain.language) parts.push(domain.language);
  if (domain.framework) parts.push(domain.framework);
  if (domain.errorType) parts.push(domain.errorType);
  return parts.join("-").toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

function firstSentence(s: string): string {
  if (typeof s !== "string") return "";
  const cleaned = s.trim();
  if (!cleaned) return "";
  const m = cleaned.match(/^[^.!?\n]+[.!?]?/);
  return m ? m[0].trim() : cleaned;
}

function clean(s: string): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

function bagOfWords(s: string): string {
  return [
    ...new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9 ]+/g, " ")
        .split(/\s+/)
        .filter((t) => t.length >= 3),
    ),
  ]
    .sort()
    .join(" ");
}

/**
 * Two bags overlap "enough" when their token-overlap fraction is ≥ 0.6.
 * Anything above that is treated as a near-duplicate (e.g. the same
 * unlock phrased two different ways) and we keep only the first.
 */
function alreadyCovered(fingerprint: string, seen: Set<string>): boolean {
  if (seen.has(fingerprint)) return true;
  if (!fingerprint) return true;
  const newTokens = new Set(fingerprint.split(" ").filter(Boolean));
  if (newTokens.size === 0) return true;
  for (const prior of seen) {
    const priorTokens = new Set(prior.split(" ").filter(Boolean));
    let intersect = 0;
    for (const t of newTokens) if (priorTokens.has(t)) intersect++;
    const union = priorTokens.size + newTokens.size - intersect;
    if (union === 0) continue;
    if (intersect / union >= 0.6) return true;
  }
  return false;
}

function mostCommon(values: readonly string[]): string | undefined {
  if (values.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | undefined;
  let bestCount = -1;
  for (const [v, c] of counts) {
    if (c > bestCount) {
      bestCount = c;
      best = v;
    }
  }
  return best;
}

/** Char/4 token heuristic, matching `buildInjectionPayload`. */
function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

function truncateToTokens(s: string, maxTokens: number): string {
  if (estimateTokens(s) <= maxTokens) return s;
  const maxChars = Math.max(0, maxTokens * 4 - 1);
  if (maxChars === 0) return "";
  return s.slice(0, maxChars).replace(/\s+\S*$/, "") + "…";
}
