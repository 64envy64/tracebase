/**
 * Helpers used by the MCP v2 tools (get_reasoning_patterns,
 * record_reasoning_outcome, store_reasoning_pattern). Kept as a
 * separate module so they're unit-testable without spinning up an
 * MCP server.
 */
import { randomUUID } from "node:crypto";
import type { BlockStore } from "../core/block-store.js";
import { createBlock } from "../core/block.js";
import { classifyForCapture } from "../core/capture-gate.js";
import type { BlockInvariants, StoreBlockInput } from "../types.js";

/**
 * Collect the block ids and fact ids that were actually injected for a
 * given queryId. Powers `record_reasoning_outcome` when the caller
 * says `usedPattern: true` without naming specific items — we credit
 * every item that was injected for that query.
 *
 * Reads both `injection` and `fact_injection` events filtered by
 * queryId. Deduped preserving first-seen order.
 */
export function collectInjectedFromQuery(
  store: BlockStore,
  queryId: string,
): { blockIds: string[]; factIds: string[] } {
  const events = store.readEvents({ queryId, limit: 10_000 });
  const blockIds: string[] = [];
  const factIds: string[] = [];
  const seenB = new Set<string>();
  const seenF = new Set<string>();
  for (const ev of events) {
    if (ev.event === "injection" && !seenB.has(ev.blockId)) {
      seenB.add(ev.blockId);
      blockIds.push(ev.blockId);
    } else if (ev.event === "fact_injection" && !seenF.has(ev.factId)) {
      seenF.add(ev.factId);
      factIds.push(ev.factId);
    }
  }
  return { blockIds, factIds };
}

/**
 * Decide which block + fact ids to credit with `agent_used` based on
 * the caller's record_reasoning_outcome arguments. Rules:
 *
 *   1. If `usedBlocks` / `usedFacts` is given, use those verbatim
 *      (finest granularity, caller knows best).
 *   2. Else if `usedPattern` is true, credit every id that the store
 *      recorded as injected for this query (shortcut).
 *   3. Else credit nothing (the agent explicitly reports it didn't
 *      use the patterns — neutral attribution).
 *
 * `usedBlocks` / `usedFacts` are always intersected with the actually-
 * injected set so a caller can't silently credit arbitrary ids that
 * never appeared in the injection payload.
 */
export function resolveUsedItems(
  injected: { blockIds: string[]; factIds: string[] },
  args: {
    usedPattern?: boolean;
    usedBlocks?: string[];
    usedFacts?: string[];
  },
): { usedBlockIds: string[]; usedFactIds: string[] } {
  const injectedBlockSet = new Set(injected.blockIds);
  const injectedFactSet = new Set(injected.factIds);

  if (args.usedBlocks !== undefined || args.usedFacts !== undefined) {
    return {
      usedBlockIds: (args.usedBlocks ?? []).filter((id) => injectedBlockSet.has(id)),
      usedFactIds: (args.usedFacts ?? []).filter((id) => injectedFactSet.has(id)),
    };
  }
  if (args.usedPattern === true) {
    return {
      usedBlockIds: injected.blockIds,
      usedFactIds: injected.factIds,
    };
  }
  return { usedBlockIds: [], usedFactIds: [] };
}

// ---------------------------------------------------------------------------
// store_reasoning_pattern — the capture half of the loop.
//
// `get_reasoning_patterns` reads from the v2 reasoning_blocks table.
// The legacy `store` MCP tool, in contrast, writes v1 ReasoningTrace
// rows via ReasoningLayer — a different table. That's why a fresh
// project stayed empty even when the agent "stored" every solution:
// nothing it wrote was visible to the retrieval path.
//
// `storeReasoningPattern` is the matching v2 writer. The agent
// composes the pattern (situation / mechanism / unlock / verification)
// and the helper inserts a candidate block, attaches an origin case
// ref, and promotes it to active so the next retrieval can surface it
// as a hypothesis.
// ---------------------------------------------------------------------------

export interface StoreReasoningPatternArgs {
  /** When does this pattern apply? Short trigger statement. */
  situation: string;
  /** Why the fix works — the underlying mechanism. */
  mechanism: string;
  /** The concrete change or action that resolves it. */
  unlock: string;
  /** How to confirm the fix worked (tests / logs / manual check). */
  verification: string;
  /** Approaches that don't work — warn future agents away from them. */
  deadEnds?: string[];
  language?: string;
  framework?: string;
  errorType?: string;
  apiSurface?: string[];
  /**
   * queryId from the get_reasoning_patterns call that triggered this
   * capture. Used as the origin case ref's `traceId` for audit — so
   * the block can be traced back to the query that led to it.
   */
  queryId?: string;
}

export interface StoreReasoningPatternResult {
  blockId: string;
  /**
   * True if this call inserted a new block. False if a block with the
   * same trigger fingerprint already existed — in that case the helper
   * attaches a `supporting` case ref to the existing block instead of
   * creating a duplicate, and returns that block's id.
   */
  isNew: boolean;
  /** Situation actually stored (trimmed and normalized). */
  situation: string;
}

/**
 * Minimum acceptable length for each text field. Below this the
 * pattern is almost certainly unhelpful — the helper rejects rather
 * than silently polluting the store.
 */
const MIN_FIELD_LEN = 4;

export class StorePatternValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorePatternValidationError";
  }
}

export function storeReasoningPattern(
  store: BlockStore,
  args: StoreReasoningPatternArgs,
): StoreReasoningPatternResult {
  const situation = args.situation.trim();
  const mechanism = args.mechanism.trim();
  const unlock = args.unlock.trim();
  const verification = args.verification.trim();

  for (const [name, value] of [
    ["situation", situation],
    ["mechanism", mechanism],
    ["unlock", unlock],
    ["verification", verification],
  ] as const) {
    if (value.length < MIN_FIELD_LEN) {
      throw new StorePatternValidationError(
        `field "${name}" is too short (min ${MIN_FIELD_LEN} chars after trim)`,
      );
    }
  }

  // Capture gate — refuses the two dominant junk classes (release-noise
  // and template-verify boilerplate) at storage time, before they
  // pollute the dedupe index or surface in retrieval. See
  // src/core/capture-gate.ts for rationale.
  const gate = classifyForCapture({ situation, mechanism, unlock, verification });
  if (gate.kind === "reject") {
    throw new StorePatternValidationError(
      `pattern rejected by capture gate (${gate.reason}): ${gate.detail}`,
    );
  }

  const invariants: BlockInvariants = {};
  if (args.language) invariants.language = args.language;
  if (args.framework) invariants.framework = args.framework;
  if (args.errorType) invariants.errorType = args.errorType;
  if (args.apiSurface && args.apiSurface.length > 0) {
    invariants.apiSurface = [...args.apiSurface];
  }

  const input: StoreBlockInput = {
    kind: "success",
    trigger: { situation, invariants },
    body: {
      mechanism,
      deadEnds: args.deadEnds ? [...args.deadEnds] : [],
      unlock,
      verification,
    },
    provenance: {
      // When the agent doesn't pass a queryId we still need a stable
      // sourceTaskId for audit; a fresh UUID is fine (no query to link).
      sourceTaskId: args.queryId ?? randomUUID(),
      extractedFrom: "trajectory",
      distilledBy: "llm",
    },
  };

  // Build once so we can use the fingerprint for dedupe.
  const fresh = createBlock(input);

  // Dedupe: a successful agent often runs the same class of problem
  // multiple times. Collapsing on fingerprint avoids duplicate blocks
  // that would only differ by phrasing. Kind-scoped lookup leaves
  // pitfall blocks independent — they're intentionally complementary.
  const existing = store.findBlockByFingerprintAndKind(
    fresh.trigger.fingerprint,
    fresh.kind,
  );

  // Origin ref's traceId is opaque at this layer. We use the queryId
  // when the agent supplied one (so the ref traces back to the
  // get_reasoning_patterns call that led here) and a fresh UUID
  // otherwise.
  const traceId = args.queryId ?? `agent-report-${fresh.id}`;

  if (existing) {
    // Retry idempotency: block_case_refs has a UNIQUE index on
    // (block_id, trace_id, role). An MCP tool call can legitimately
    // be retried by the client (flaky transport, agent-level retry),
    // and every retry passes the same queryId. Without this guard the
    // third identical call would raise a UNIQUE-violation exception
    // and surface as a hard tool failure to the agent — even though
    // semantically the state is already what the caller wants.
    //
    // We only need to check for the supporting role. An origin ref
    // with the same traceId on this block is impossible to reach
    // from this branch — it can only have been inserted by a prior
    // storeReasoningPattern call with the *same* queryId, which
    // would also have landed a supporting ref on the next retry; so
    // the supporting-ref presence is the canonical idempotency key.
    const alreadySupported = store
      .listCaseRefs(existing.id)
      .some((r) => r.traceId === traceId && r.role === "supporting");
    if (!alreadySupported) {
      // Attach as supporting evidence — the new report corroborates
      // the prior block. Origin status stays with the first ref.
      store.attachCaseRef({
        blockId: existing.id,
        traceId,
        role: "supporting",
        evidenceQuality: "moderate",
      });
    }
    return { blockId: existing.id, isNew: false, situation: existing.trigger.situation };
  }

  // Insert flow: candidate → origin ref → promote. storeBlock rejects
  // inserting active-without-origin, so we force candidate here.
  // Wrapped in a single transaction so a mid-sequence failure rolls
  // back as a unit — without this, a crash between any two writes
  // would leave a `candidate`-status block invisible to readers
  // (which filter `status='active'`) and orphaned from the case-ref
  // graph.
  const candidate = { ...fresh, status: "candidate" as const };
  store.transaction(() => {
    store.storeBlock(candidate);
    store.attachCaseRef({
      blockId: candidate.id,
      traceId,
      role: "origin",
      evidenceQuality: "strong",
    });
    store.updateBlockStatus(candidate.id, "active");
  });

  return { blockId: candidate.id, isNew: true, situation };
}
