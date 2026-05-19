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
import type {
  BlockHit,
  FactHit,
  RecallV2Result,
} from "../core/block-serving.js";
import { buildInjectionPayload } from "../core/build-injection-payload.js";

// ---------------------------------------------------------------------------
// 0.7.1 Contextual Runtime — structured MCP outputs
//
// Every MCP tool that participates in the contextual-runtime contract
// returns a `structuredContent` payload tagged with a stable protocol
// id. External consumers parse this payload directly — no markdown
// parsing required, no string-format drift across releases.
// The text `content` field is preserved for human-readable Claude /
// Cursor display, but it is NOT the integration surface.
//
// The protocol literal is exported so external code (provider
// implementations, tests, downstream MCP clients) can pin to it
// rather than re-typing the string.
// ---------------------------------------------------------------------------

/** Stable protocol id for the contextual-runtime structured payloads. */
export const CONTEXTUAL_RUNTIME_PROTOCOL =
  "tracebase.contextual_runtime.v1" as const;

/**
 * Coerce a precisely-typed structured payload into the
 * `Record<string, unknown>` shape the MCP SDK expects at the
 * `structuredContent` boundary.
 *
 * The SDK declares `structuredContent` as
 * `z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>` which
 * compiles to `Record<string, unknown>`. Object literals in TS do
 * not widen to that automatically (no implicit index signature on
 * named types), so we localize the coercion to one helper rather
 * than scattering `as unknown as Record<…>` casts across handlers.
 *
 * The runtime shape is the source of truth — this assertion only
 * adjusts the type, never the value.
 */
export function toMcpStructured<T extends object>(
  payload: T,
): Record<string, unknown> {
  return payload as unknown as Record<string, unknown>;
}

/** Narrow shape of a single block hit as it appears on the wire. */
export interface StructuredBlockHit {
  id: string;
  situation: string;
  calibratedProb: number;
  evidenceRefs: Array<{ traceId: string; role: string }>;
}

/** Narrow shape of a single fact hit as it appears on the wire. */
export interface StructuredFactHit {
  id: string;
  statement: string;
  confidence: number;
}

/** Narrow shape of an injection summary as it appears on the wire. */
export interface StructuredInjectionSummary {
  blockIds: string[];
  factIds: string[];
  tokensEstimate: number;
}

/**
 * Structured payload returned by `get_reasoning_patterns`.
 *
 * `shouldInject` is the binding gate for the integrator: it mirrors
 * `passesGate` semantics from `BlockServer.recall` — when false, the
 * agent must not surface any of the listed blocks/facts as injected
 * context. Blocks and facts are still listed (with calibrated
 * probability) so analytics and shadow-arm tooling have something to
 * audit; `injected` is undefined when `shouldInject === false`.
 *
 * `controlReason` is set whenever the query landed in a control arm
 * (manual `shadow:true` or experimental holdout). Treat it as a
 * structured tag, not a marketing label — `holdout` runs feed the
 * causal cohort, `shadow` runs feed the wall-clock estimate.
 */
export interface ReasoningPatternsStructured {
  protocol: typeof CONTEXTUAL_RUNTIME_PROTOCOL;
  queryId: string;
  shouldInject: boolean;
  shadow: boolean;
  controlReason?: "holdout" | "shadow";
  blocks: StructuredBlockHit[];
  facts: StructuredFactHit[];
  injected?: StructuredInjectionSummary;
}

/**
 * Build the structured payload for `get_reasoning_patterns`.
 *
 * Parameters mirror what `mcp.ts` already computes (the recall result
 * + its rendered injection payload), so this helper is a pure
 * shape-shifter — the source-of-truth values stay in
 * `BlockServer.recall` / `buildInjectionPayload`. Pulling the wire
 * shape here keeps the MCP handler small and lets unit tests assert
 * the contract without a full SDK boot.
 */
export function toReasoningPatternsStructured(
  result: RecallV2Result,
): ReasoningPatternsStructured {
  const passingBlocks = result.blocks.filter((h) => h.passesGate);
  const passingFacts = result.facts.filter((h) => h.passesGate);

  const blocks: StructuredBlockHit[] = result.blocks.map(
    blockHitToStructured,
  );
  const facts: StructuredFactHit[] = result.facts.map(factHitToStructured);

  const out: ReasoningPatternsStructured = {
    protocol: CONTEXTUAL_RUNTIME_PROTOCOL,
    queryId: result.queryId,
    shouldInject: result.shouldInject,
    shadow: result.shadow,
    blocks,
    facts,
  };
  if (result.controlReason) out.controlReason = result.controlReason;

  if (result.shouldInject) {
    // Reuse the production injection-payload builder so the token
    // estimate the integrator sees matches the cost actually paid
    // when the rendered text is forwarded into the model context.
    // No re-implementation; same code path, same numbers.
    const payload = buildInjectionPayload(result);
    out.injected = {
      blockIds: passingBlocks.map((h) => h.block.id),
      factIds: passingFacts.map((h) => h.fact.id),
      tokensEstimate: payload.tokensEstimate,
    };
  }

  return out;
}

function blockHitToStructured(hit: BlockHit): StructuredBlockHit {
  // refs come from BlockServer.recall already capped to refLimit (3
  // by default). They're audit-bearing, so always surface them — but
  // only the (traceId, role) pair, never any free-form notes.
  const evidenceRefs = (hit.refs ?? []).map((ref) => ({
    traceId: ref.traceId,
    role: ref.role,
  }));
  return {
    id: hit.block.id,
    situation: hit.block.trigger.situation,
    calibratedProb: hit.calibratedProb,
    evidenceRefs,
  };
}

function factHitToStructured(hit: FactHit): StructuredFactHit {
  return {
    id: hit.fact.id,
    statement: hit.fact.statement,
    confidence: hit.fact.confidence,
  };
}

/**
 * Structured payload returned by `record_reasoning_outcome`.
 *
 * Mirrors the inputs the MCP handler already attributed to the query
 * (intersected with what was actually injected — see
 * `resolveUsedItems`), plus the wall-clock duration the runtime
 * recorded for the run when the agent supplied one. The outcome ledger
 * is the canonical source of `usedBlockIds` / `usedFactIds`; this
 * payload is just the synchronous read-back so the calling provider
 * can confirm what was credited.
 */
export interface OutcomeStructured {
  protocol: typeof CONTEXTUAL_RUNTIME_PROTOCOL;
  outcome: {
    queryId: string;
    resolved: boolean;
    usedBlockIds: string[];
    usedFactIds: string[];
    durationMs?: number;
    /**
     * May-2026 B1.6 — cascade provenance for this query.
     *
     * Present iff a retrieval event for `queryId` is recoverable. The
     * agent reads this to know whether its run was on the cascade arm
     * (reranker-assisted) or the sync arm — a meaningful diagnostic
     * when post-mortem'ing why a pattern surfaced or didn't. Surfacing
     * fallback reason is the difference between "the cascade chose this
     * block" and "the cascade fell back to BM25 ordering and BM25
     * chose this block" — both legitimate, very different signals.
     */
    cascade?: OutcomeCascadeProvenance;
  };
}

/**
 * Provenance block attached to outcome responses. Optional fields are
 * absent on the sync arm; `viaCascade: false` is the explicit
 * "sync recall path" marker so consumers don't have to infer.
 */
export interface OutcomeCascadeProvenance {
  /** True iff the retrieval went through BlockServer.recallAsync (cascade path). */
  viaCascade: boolean;
  /** Cascade policy version, e.g. "linear+rerank+mmr.v1". Present only on cascade arm. */
  policyId?: string;
  /** Concrete reranker that ran, e.g. "minilm" / "cloud" / "noop". Present only on cascade arm. */
  rerankerName?: string;
  /** True iff the reranker call collapsed to the pre-rerank ordering. */
  fellBack?: boolean;
  /** Reason for fallback when `fellBack: true`. */
  fallbackReason?: "timeout" | "error" | "null" | "empty" | "validation";
}

/**
 * Recover cascade provenance for a queryId by reading its retrieval
 * event from the analytics log. Returns `null` when no retrieval
 * event exists (e.g. legacy queryId from before B1.2, or a malformed
 * queryId the agent fabricated) — callers should treat that as
 * "no provenance available, don't render the cascade line".
 *
 * Pure read; never throws. Used by `record_reasoning_outcome` to
 * surface cascade metadata in the agent-facing response.
 */
export function lookupCascadeProvenance(
  store: BlockStore,
  queryId: string,
): OutcomeCascadeProvenance | null {
  let retrieval: Record<string, unknown> | null = null;
  try {
    const events = store.readEvents({ queryId, limit: 100 });
    for (const ev of events) {
      if (ev.event === "retrieval") {
        retrieval = ev as unknown as Record<string, unknown>;
        break;
      }
    }
  } catch {
    return null;
  }
  if (!retrieval) return null;

  const policyId = typeof retrieval.cascadePolicyId === "string" ? retrieval.cascadePolicyId : undefined;
  const rerankerName = typeof retrieval.rerankerName === "string" ? retrieval.rerankerName : undefined;
  const fellBack = typeof retrieval.rerankerFellBack === "boolean" ? retrieval.rerankerFellBack : undefined;
  const fallbackReasonRaw = retrieval.rerankerFallbackReason;
  const fallbackReason =
    fallbackReasonRaw === "timeout" ||
    fallbackReasonRaw === "error" ||
    fallbackReasonRaw === "null" ||
    fallbackReasonRaw === "empty" ||
    fallbackReasonRaw === "validation"
      ? fallbackReasonRaw
      : undefined;

  const viaCascade = policyId !== undefined;
  return {
    viaCascade,
    ...(policyId !== undefined ? { policyId } : {}),
    ...(rerankerName !== undefined ? { rerankerName } : {}),
    ...(fellBack !== undefined ? { fellBack } : {}),
    ...(fallbackReason !== undefined ? { fallbackReason } : {}),
  };
}

/**
 * Structured payload returned by `store_reasoning_pattern`.
 *
 * `isNew=false` means the pattern collapsed onto an existing block
 * with the same trigger fingerprint — the original block id is
 * returned and a `supporting` case ref attached. Callers don't have
 * to do anything different; the pattern is reusable either way.
 */
export interface StorePatternStructured {
  protocol: typeof CONTEXTUAL_RUNTIME_PROTOCOL;
  pattern: {
    blockId: string;
    isNew: boolean;
    situation: string;
  };
}

/**
 * Structured payload returned by `delete_pattern` and
 * `delete_project_fact`. `kind` distinguishes the two surfaces so a
 * provider can route the deletion event to the right audit ledger.
 *
 * `deleted=false` is NOT an error — it means the id was not present
 * in the store (no-op, no audit row). The wrapping `ok:true` reflects
 * "the request was processed cleanly", not "something was actually
 * removed". This matches `BlockStore.hardDeleteBlock` /
 * `BlockStore.hardDeleteFact` semantics.
 */
export interface DeletionStructured {
  protocol: typeof CONTEXTUAL_RUNTIME_PROTOCOL;
  deletion: {
    ok: true;
    deleted: boolean;
    id: string;
    kind: "block" | "fact";
  };
}

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

// ---------------------------------------------------------------------------
// delete_pattern (GDPR Art. 17 hard-delete) — capture-side erasure
// ---------------------------------------------------------------------------

const DELETE_REASON_MIN_LEN = 4;
const DELETE_REASON_MAX_LEN = 500;

export interface DeletePatternArgs {
  /** Block id to hard-delete. */
  id: string;
  /** Human-readable reason; stored verbatim in `audit_deletes.reason`. */
  reason: string;
  /**
   * Identity of the caller. The MCP tool wires this to a fixed surface
   * tag (`"mcp:delete_pattern"`) so the audit log distinguishes
   * tool-driven erasures from CLI / SDK paths. Optional for direct
   * library callers.
   */
  requestingPrincipal?: string;
}

export interface DeletePatternResult {
  ok: true;
  /** False when the id did not exist (no audit row written). */
  deleted: boolean;
  id: string;
}

/**
 * Hard-delete a reasoning pattern by id and write a tombstone to
 * `audit_deletes`. Thin wrapper over `BlockStore.hardDeleteBlock`
 * that adds input validation:
 *
 *   - `id` must be a non-empty string.
 *   - `reason` must be 4..500 chars after trim.
 *
 * Both writes (block delete + audit insert) happen in a single
 * transaction inside `hardDeleteBlock`; on failure neither side
 * persists.
 *
 * Privacy invariant: the audit row stores only `(id, block_id,
 * deleted_at, reason, requesting_principal)`. The deleted block's
 * body fields (situation / mechanism / unlock / verification) are
 * NEVER preserved — that would defeat the erasure purpose. Callers
 * MUST NOT pass block content as the `reason` field; the gate above
 * caps reason length at 500 chars and the audit schema has no
 * column for body text.
 *
 * Idempotent: a missing id returns `{ ok: true, deleted: false }`
 * with no audit row written and no error.
 */
export function deletePattern(
  store: BlockStore,
  args: DeletePatternArgs,
): DeletePatternResult {
  const id = (args.id ?? "").trim();
  const reason = (args.reason ?? "").trim();

  if (id.length === 0) {
    throw new StorePatternValidationError(`field "id" is required`);
  }
  if (reason.length < DELETE_REASON_MIN_LEN) {
    throw new StorePatternValidationError(
      `field "reason" is too short (min ${DELETE_REASON_MIN_LEN} chars after trim)`,
    );
  }
  if (reason.length > DELETE_REASON_MAX_LEN) {
    throw new StorePatternValidationError(
      `field "reason" is too long (max ${DELETE_REASON_MAX_LEN} chars)`,
    );
  }

  const deleted = store.hardDeleteBlock(id, reason, args.requestingPrincipal);
  return { ok: true, deleted, id };
}

// ---------------------------------------------------------------------------
// delete_project_fact (GDPR Art. 17 hard-delete) — semantic-side erasure.
//
// Parallels deletePattern. Project facts (L4 semantic memory) are
// served by the same recall path that surfaces blocks; if a user
// requests erasure of a captured fact, the deletion must be just as
// total — body removed from project_facts, FTS index swept by the
// existing AFTER DELETE trigger, audit row written to
// audit_fact_deletes for compliance. Same input contract, same
// idempotency: missing id → ok:true, deleted:false, no audit row.
// ---------------------------------------------------------------------------

export interface DeleteProjectFactArgs {
  /** Fact id to hard-delete. */
  id: string;
  /** Human-readable reason; stored verbatim in `audit_fact_deletes.reason`. */
  reason: string;
  /** Optional caller identity (default: "mcp:delete_project_fact" at the tool layer). */
  requestingPrincipal?: string;
}

export interface DeleteProjectFactResult {
  ok: true;
  /** False when the id did not exist (no audit row written). */
  deleted: boolean;
  id: string;
}

/**
 * Hard-delete a project fact by id and write a tombstone to
 * `audit_fact_deletes`. Validation contract is identical to
 * `deletePattern`:
 *   - `id` must be a non-empty string.
 *   - `reason` must be 4..500 chars after trim.
 *
 * Privacy invariant: the audit row stores only `(id, fact_id,
 * deleted_at, reason, requesting_principal)`. The deleted fact's
 * statement is NEVER preserved.
 */
export function deleteProjectFact(
  store: BlockStore,
  args: DeleteProjectFactArgs,
): DeleteProjectFactResult {
  const id = (args.id ?? "").trim();
  const reason = (args.reason ?? "").trim();

  if (id.length === 0) {
    throw new StorePatternValidationError(`field "id" is required`);
  }
  if (reason.length < DELETE_REASON_MIN_LEN) {
    throw new StorePatternValidationError(
      `field "reason" is too short (min ${DELETE_REASON_MIN_LEN} chars after trim)`,
    );
  }
  if (reason.length > DELETE_REASON_MAX_LEN) {
    throw new StorePatternValidationError(
      `field "reason" is too long (max ${DELETE_REASON_MAX_LEN} chars)`,
    );
  }

  const deleted = store.hardDeleteFact(id, reason, args.requestingPrincipal);
  return { ok: true, deleted, id };
}
