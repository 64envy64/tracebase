/**
 * BlockServer — v2 serving base (docs/DESIGN_v2.md §L5, Phase 2).
 *
 * Pipeline:
 *     query + invariants
 *       │
 *       ├─► hard-invariant prefilter (active blocks + active facts only)
 *       │
 *       ▼
 *     lexical ranker  (FTS5 BM25 over trigger-only fields for blocks,
 *                      statement for facts)
 *       │
 *       ▼
 *     optional: semantic reranker  (plug-in slot; identity by default)
 *       │
 *       ▼
 *     calibrated gate (Calibrator slot; identity pass-through by default)
 *       │
 *       ▼
 *     injection as HYPOTHESIS  (formatInjection; never imperative)
 *
 * Non-negotiable:
 *   • Body fields never contribute to scoring.
 *   • Case refs are attached to every returned block for audit.
 *   • A shadow query skips injection but still emits events.
 *   • Calibrator is pluggable — when the isotonic calibrator ships in
 *     Phase 5, it drops into the same slot with no schema change.
 */
import { randomUUID } from "node:crypto";
import type { BlockStore } from "./block-store.js";
import { EventEmitter, type SideSink } from "./analytics.js";
import { shouldHoldOut } from "../experiments/holdout.js";
import type {
  ReasoningBlock,
  BlockCaseRef,
  BlockInvariants,
  ProjectFact,
  RetrievalEvent,
  InjectionEvent,
  FactInjectionEvent,
} from "../types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BlockRecallQuery {
  /** Free-text query: error message, task description, or both. */
  text: string;
  /**
   * Hard pre-filter. If query sets language=python, any block whose
   * `trigger.invariants.language` is also set to a different language is
   * eliminated before ranking. Unset fields = no filtering on that
   * dimension.
   */
  invariants?: BlockInvariants;
  /** For fact scope filtering (e.g. "repo:myorg/app"). */
  scope?: string;
  /** Max blocks. Default 5. */
  limit?: number;
  /** Max facts. Default 5. */
  factLimit?: number;
  /** Max case refs to attach per block. Default 3. */
  refLimit?: number;
  /** Shadow control query — events emitted but no injection fires. Default false. */
  shadow?: boolean;
  /** Optional caller-supplied query id for correlation. Default auto-uuid. */
  queryId?: string;
  /** Optional run id for grouping events in analytics. */
  runId?: string;
  /**
   * Optional experimental-holdout input. When provided *and* the
   * query is eligible (at least one candidate retrieved) *and* the
   * deterministic assignment lands the query in the holdout cohort,
   * `recall` suppresses injection for the run and marks the
   * retrieval event with `controlReason: "holdout"`.
   *
   * Default off: when `experiment` is omitted, behaviour is 100%
   * identical to pre-Phase-3 serving — no holdout, no new event
   * fields, no side effects. A caller that supplies `experiment`
   * without a `fingerprint` is a silent no-op: deterministic
   * assignment requires the fingerprint, and we would rather skip
   * the experiment for that run than fabricate a cohort.
   */
  experiment?: ExperimentInput;
}

/**
 * Deterministic holdout-assignment input for one retrieval call.
 * See `src/experiments/holdout.ts` for the assignment semantics.
 */
export interface ExperimentInput {
  /** Holdout rate on [0, 1]. 0 disables, 1 always holds out. */
  rate: number;
  /**
   * Workspace-scoped salt — must be stable per workspace and
   * isolated across workspaces. Supplied by the caller.
   */
  salt: string;
  /**
   * Stable query fingerprint. Same problem shape → same cohort.
   * When missing, the experiment is silently skipped for this run
   * (safe no-op) rather than falling back to a non-deterministic
   * decision.
   */
  fingerprint?: string;
}

export interface BlockHit {
  block: ReasoningBlock;
  /** Normalized 0..1 ranker score (higher = more relevant). */
  score: number;
  /** Gate output: calibrated P(helpful). Identity by default. */
  calibratedProb: number;
  /**
   * Binding contract: true iff this hit WILL be included in the
   * injection payload AND produce an `injection` analytics event.
   * False for hits below the gate threshold and for every hit of a
   * shadow query. Consumers formatting the prompt must filter by
   * this flag — otherwise prompt content drifts from analytics.
   */
  passesGate: boolean;
  /** Top-N case refs for audit. Never used in scoring. */
  refs: BlockCaseRef[];
}

export interface FactHit {
  fact: ProjectFact;
  /** Raw ranker score; currently fact.confidence until Phase 5's fact calibrator ships. */
  score: number;
  /**
   * Gated probability: score after any calibrator. Currently equals
   * `score` (no fact-side calibrator yet), but the field is present
   * so downstream consumers can treat blocks and facts symmetrically.
   */
  calibratedProb: number;
  /**
   * Binding contract: true iff this fact WILL appear in the
   * injection payload AND produce a `fact_injection` analytics
   * event. False below gate and for shadow queries. Parallel to
   * BlockHit.passesGate.
   */
  passesGate: boolean;
}

export interface RecallV2Result {
  queryId: string;
  shadow: boolean;
  blocks: BlockHit[];
  facts: FactHit[];
  /**
   * Whether the server recommends injection at all. False if:
   *   - this is a shadow query, or
   *   - no hit exceeds the gate threshold.
   */
  shouldInject: boolean;
}

export type Calibrator = (score: number, block: ReasoningBlock) => number;

export const identityCalibrator: Calibrator = (score) => score;

export interface BlockServerOptions {
  /**
   * Minimum calibrated probability for `shouldInject = true`.
   * Default 0 — everything passes. Bump in production once the
   * isotonic calibrator is fitted.
   */
  gateThreshold?: number;
  /** Maps raw ranker score + block → P(helpful). Identity by default. */
  calibrator?: Calibrator;
  /**
   * If true, emit retrieval / injection events to the store's event log.
   * Default true. Tests can disable for noise-free assertions.
   */
  emitEvents?: boolean;
  /** Override Date.now() for deterministic tests. */
  now?: () => number;
  /**
   * Unified emission channel. When provided, retrieval / injection
   * events flow through this emitter and benefit from whatever side
   * sinks it carries. If unset, a default emitter is built from
   * `store` and (optionally) `sideSink`.
   *
   * Prefer this over `sideSink` when `emitAgentUsed` / `emitOutcome`
   * are also called in the same deployment — a single shared emitter
   * ensures all four event types reach the same destinations.
   */
  emitter?: EventEmitter;
  /**
   * Convenience: when no `emitter` is provided, this side-channel is
   * attached to the default emitter for retrieval / injection events.
   * Ignored when `emitter` is provided (configure the emitter instead).
   * Errors are swallowed so a bad sink never breaks retrieval.
   */
  sideSink?: SideSink;
}

// ---------------------------------------------------------------------------
// BlockServer
// ---------------------------------------------------------------------------

export class BlockServer {
  private readonly store: BlockStore;
  private readonly gateThreshold: number;
  private readonly calibrator: Calibrator;
  private readonly emitEvents: boolean;
  private readonly now: () => number;
  private readonly emitter: EventEmitter;

  constructor(store: BlockStore, opts: BlockServerOptions = {}) {
    this.store = store;
    this.gateThreshold = opts.gateThreshold ?? 0;
    this.calibrator = opts.calibrator ?? identityCalibrator;
    this.emitEvents = opts.emitEvents ?? true;
    this.now = opts.now ?? Date.now;
    // Unified emission: either the caller-supplied emitter (preferred,
    // shared with emit helpers) or a fresh one wrapping the store and
    // optional sideSink shim.
    this.emitter = opts.emitter ?? new EventEmitter(store, opts.sideSink);
  }

  /**
   * Run retrieval. Returns hits plus a `shouldInject` recommendation.
   * Emits a `retrieval` event (always) and one `injection` event per
   * block and one `fact_injection` event per fact that pass the gate
   * (unless the query is shadow). Blocks and facts attribute
   * independently at aggregation time.
   */
  recall(query: BlockRecallQuery): RecallV2Result {
    const queryId = query.queryId ?? randomUUID();
    const manualShadow = query.shadow ?? false;
    const limit = query.limit ?? 5;
    const factLimit = query.factLimit ?? 5;
    const refLimit = query.refLimit ?? 3;

    const blocks = this.searchBlocks(query.text, query.invariants, limit);
    const rawFacts = this.searchFacts(query.text, query.invariants, query.scope, factLimit);

    // Pre-compute calibrated probabilities once. Both the holdout
    // eligibility decision and the final BlockHit / FactHit
    // construction below key off the exact same calibrated value,
    // so a query cannot be "eligible for holdout" but then fail to
    // produce an injection in treatment, nor vice-versa.
    const blockCalibrated = blocks.map(({ block, score }) => ({
      block,
      score,
      calibratedProb: clamp01(this.calibrator(score, block)),
      refs: this.store.listCaseRefs(block.id).slice(0, refLimit),
    }));
    const factCalibrated = rawFacts.map(({ fact, score }) => ({
      fact,
      score,
      calibratedProb: clamp01(fact.confidence),
    }));

    // Phase 3.2 — experimental holdout.
    //
    // Only applies when:
    //   1. the caller did not already set a manual shadow (manual
    //      shadow stays exactly as it was; it keeps an undefined
    //      `controlReason` for back-compat so analytics still treats
    //      it as diagnostic-only);
    //   2. the query is gate-eligible — at least one block or fact
    //      candidate would pass the calibrator + gateThreshold
    //      *absent* the holdout. A run whose candidates all fall
    //      below the gate would not emit any injection event in
    //      treatment either, so marking such a run as holdout would
    //      contaminate the control cohort with "nothing-to-compare"
    //      queries and understate the causal lift;
    //   3. the experiment input is complete — `rate`, `salt`, and a
    //      `fingerprint` all present. A missing fingerprint is a
    //      silent no-op: without it assignment cannot be
    //      deterministic, and we would rather skip the experiment
    //      than fabricate a cohort;
    //   4. the deterministic `shouldHoldOut` decision lands this
    //      fingerprint in the holdout.
    //
    // When all four conditions hold, the run is treated as shadow
    // (no injection events, passesGate = false everywhere,
    // shouldInject = false, formatInjection renders empty) and the
    // retrieval event carries `controlReason: "holdout"`.
    const wouldInjectAbsentShadow =
      blockCalibrated.some((h) => h.calibratedProb >= this.gateThreshold) ||
      factCalibrated.some((h) => h.calibratedProb >= this.gateThreshold);
    const holdoutApplied =
      !manualShadow &&
      wouldInjectAbsentShadow &&
      !!query.experiment?.fingerprint &&
      shouldHoldOut(
        query.experiment.fingerprint,
        query.experiment.rate,
        query.experiment.salt,
      );
    const shadow = manualShadow || holdoutApplied;
    const controlReason: "shadow" | "holdout" | undefined = holdoutApplied ? "holdout" : undefined;

    // Finalise hits. `passesGate` is the single-source-of-truth the
    // injection formatter and analytics emission both key off, and
    // it reuses the calibrator output computed above so holdout
    // eligibility and downstream gate decision cannot drift.
    const blockHits: BlockHit[] = blockCalibrated.map((h) => ({
      block: h.block,
      score: h.score,
      calibratedProb: h.calibratedProb,
      passesGate: !shadow && h.calibratedProb >= this.gateThreshold,
      refs: h.refs,
    }));

    // Facts: no calibrator slot yet (Phase 5). Same gate threshold
    // as blocks; per-item-type thresholds can be introduced later
    // without changing the event schema.
    const factHits: FactHit[] = factCalibrated.map((h) => ({
      fact: h.fact,
      score: h.score,
      calibratedProb: h.calibratedProb,
      passesGate: !shadow && h.calibratedProb >= this.gateThreshold,
    }));

    // shouldInject: true iff any hit passes the gate. passesGate
    // already encodes "not shadow", so this is a simple disjunction.
    const shouldInject =
      blockHits.some((h) => h.passesGate) || factHits.some((h) => h.passesGate);

    // Emit events. One injection event per hit with passesGate=true —
    // one-to-one correspondence with what the formatter will render.
    if (this.emitEvents) {
      this.emitRetrieval(queryId, blockHits, factHits, shadow, controlReason, query.runId);
      for (const h of blockHits) {
        if (h.passesGate) this.emitInjection(queryId, h, query.runId);
      }
      for (const h of factHits) {
        if (h.passesGate) this.emitFactInjection(queryId, h, query.runId);
      }
    }

    return {
      queryId,
      shadow,
      blocks: blockHits,
      facts: factHits,
      shouldInject,
    };
  }

  // -------------------------------------------------------------------------
  // Private: block retrieval
  // -------------------------------------------------------------------------

  private searchBlocks(
    text: string,
    invariants: BlockInvariants | undefined,
    limit: number,
  ): Array<{ block: ReasoningBlock; score: number }> {
    const fts = this.sanitizeFtsQuery(text);
    if (!fts) return [];

    const invLang = invariants?.language ?? null;
    const invFw = invariants?.framework ?? null;
    const invErr = invariants?.errorType ?? null;
    const queryApi = invariants?.apiSurface ?? [];

    // Over-fetch so that after the prefilter we still have enough candidates.
    // We over-fetch more generously when an apiSurface constraint is in
    // play because the JS-side intersection may reject a fair chunk.
    const fetchSize = Math.max(limit * (queryApi.length > 0 ? 8 : 4), 20);

    // Hard prefilter encoded in WHERE: if the block sets an invariant AND
    // the query sets the same invariant, they must agree. Unset = accept.
    const sql = `
      SELECT rb.*, bm25(reasoning_blocks_fts, 2.0, 1.0) AS raw_rank
      FROM reasoning_blocks_fts
      JOIN reasoning_blocks rb ON rb.rowid = reasoning_blocks_fts.rowid
      WHERE reasoning_blocks_fts MATCH @fts
        AND rb.status = 'active'
        AND (rb.trig_language   IS NULL OR @inv_lang IS NULL OR rb.trig_language   = @inv_lang)
        AND (rb.trig_framework  IS NULL OR @inv_fw   IS NULL OR rb.trig_framework  = @inv_fw)
        AND (rb.trig_error_type IS NULL OR @inv_err  IS NULL OR rb.trig_error_type = @inv_err)
      ORDER BY raw_rank
      LIMIT @fetchSize
    `;

    let rows: Array<Record<string, unknown> & { raw_rank: number }>;
    try {
      rows = this.store.rawDb.prepare(sql).all({
        fts,
        inv_lang: invLang,
        inv_fw: invFw,
        inv_err: invErr,
        fetchSize,
      }) as Array<Record<string, unknown> & { raw_rank: number }>;
    } catch {
      // FTS query failure (malformed tokens etc.) — return nothing rather
      // than silently corrupting ranking.
      return [];
    }

    if (rows.length === 0) return [];

    // apiSurface is stored as a JSON array. SQLite json_each/EXISTS would
    // work but adds significant SQL complexity for a rarely-triggered
    // filter; intersect in JS on the over-fetched candidate set instead.
    // Semantics: if query supplies a non-empty apiSurface AND the block
    // supplies a non-empty apiSurface, require at least one element
    // overlap. Either side empty = accept (same rule as scalar invariants).
    const filtered = queryApi.length > 0
      ? rows.filter((r) => {
          let blockApi: string[] = [];
          try {
            blockApi = JSON.parse(r.trig_api_surface as string) as string[];
          } catch {
            blockApi = [];
          }
          if (blockApi.length === 0) return true;
          const qSet = new Set(queryApi);
          return blockApi.some((a) => qSet.has(a));
        })
      : rows;

    if (filtered.length === 0) return [];

    // FTS5 bm25 returns negative values; lower == better. Convert to
    // positive "relevance" and query-level-normalize to 0..1.
    const relevances = filtered.map((r) => -r.raw_rank);
    const maxRel = Math.max(...relevances, Number.EPSILON);
    return filtered.slice(0, limit).map((r) => ({
      block: this.storeRowToBlock(r),
      score: clamp01(-r.raw_rank / maxRel),
    }));
  }

  private searchFacts(
    text: string,
    invariants: BlockInvariants | undefined,
    scope: string | undefined,
    limit: number,
  ): Array<{ fact: ProjectFact; score: number }> {
    // Store-side retrieval already applies hard-invariant prefilter,
    // hierarchical scope resolution, and FTS when text is present.
    // Scoring is confidence-based until Phase 5 ships a fact calibrator.
    const facts = this.store.searchFacts({
      text,
      scope,
      invariants,
      status: "active",
      limit,
    });
    return facts.map((fact) => ({ fact, score: fact.confidence }));
  }

  private sanitizeFtsQuery(query: string): string {
    const cleaned = query.replace(/[*"():^~{}[\]\\]/g, " ").trim();
    if (!cleaned) return "";
    const words = cleaned.split(/\s+/).filter(Boolean);
    if (words.length === 0) return "";
    const joiner = words.length <= 3 ? " " : " OR ";
    return words.map((w) => `"${w}"`).join(joiner);
  }

  /**
   * Build a ReasoningBlock from a raw row. We reach into the private
   * mapper by round-tripping through the store, but since the row came
   * from the same table, we can call `getBlock` by id for correctness.
   * This avoids duplicating the mapper here.
   */
  private storeRowToBlock(row: Record<string, unknown>): ReasoningBlock {
    const id = row.id as string;
    const b = this.store.getBlock(id);
    if (!b) {
      throw new Error(`block ${id} vanished between rank and fetch`);
    }
    return b;
  }

  // -------------------------------------------------------------------------
  // Event emission
  // -------------------------------------------------------------------------

  private emitRetrieval(
    queryId: string,
    blockHits: BlockHit[],
    factHits: FactHit[],
    shadow: boolean,
    controlReason: "shadow" | "holdout" | undefined,
    runId?: string,
  ): void {
    const ev: RetrievalEvent = {
      ts: this.now(),
      queryId,
      event: "retrieval",
      candidates: blockHits.map((h) => ({ blockId: h.block.id, score: h.score })),
      shadow,
      // Only write `controlReason` when we have one. Manual shadow
      // keeps an undefined tag so back-compat readers classify it
      // as diagnostic. Only experimental holdout carries "holdout".
      ...(controlReason ? { controlReason } : {}),
      ...(factHits.length > 0
        ? { factCandidates: factHits.map((h) => ({ factId: h.fact.id, score: h.score })) }
        : {}),
    };
    this.emitter.emit(ev, runId !== undefined ? { runId } : undefined);
  }

  private emitInjection(queryId: string, hit: BlockHit, runId?: string): void {
    const ev: InjectionEvent = {
      ts: this.now(),
      queryId,
      event: "injection",
      blockId: hit.block.id,
      score: hit.score,
      calibratedProb: hit.calibratedProb,
    };
    this.emitter.emit(ev, runId !== undefined ? { runId } : undefined);
  }

  private emitFactInjection(queryId: string, hit: FactHit, runId?: string): void {
    const ev: FactInjectionEvent = {
      ts: this.now(),
      queryId,
      event: "fact_injection",
      factId: hit.fact.id,
      score: hit.score,
      calibratedProb: hit.calibratedProb,
    };
    this.emitter.emit(ev, runId !== undefined ? { runId } : undefined);
  }
}

// ---------------------------------------------------------------------------
// Injection formatter — HYPOTHESIS framing, never imperative.
// ---------------------------------------------------------------------------

export interface InjectionFormatOptions {
  format?: "markdown" | "xml";
  /** Include block id + case ref ids for audit. Default true. */
  includeAudit?: boolean;
  /** Include project facts section. Default true. */
  includeFacts?: boolean;
}

/**
 * Turn a recall result into a text blob to inject into the agent's prompt.
 *
 * Gate contract: the formatter renders *exactly* the hits that the
 * server decided to inject (hit.passesGate === true) and nothing else.
 * Low-confidence hits stay in `result.blocks` / `result.facts` for
 * inspection but never reach the prompt — this keeps the injection
 * payload and the `injection` / `fact_injection` analytics events in
 * one-to-one correspondence. Shadow queries always render empty.
 *
 * Framing is always declarative-hypothesis:
 *   "A prior case with a similar signature suggests that …"
 *   "You can verify this by …"
 * Never imperative. The agent is free to ignore it if the current task
 * does not actually match the block's mechanism.
 */
export function formatInjection(
  result: RecallV2Result,
  opts: InjectionFormatOptions = {},
): string {
  const format = opts.format ?? "markdown";
  const includeAudit = opts.includeAudit ?? true;
  const includeFacts = opts.includeFacts ?? true;

  // If the server decided not to inject anything (shadow query, or no
  // hit cleared the gate), render empty — even if candidate lists are
  // non-empty. Candidates exist for debugging; the prompt does not.
  if (!result.shouldInject) return "";

  // Filter by the gate contract. Hits with passesGate=false are
  // debug-only; they would otherwise leak into the prompt without a
  // matching injection event.
  const renderableBlocks = result.blocks.filter((h) => h.passesGate);
  const renderableFacts = result.facts.filter((h) => h.passesGate);
  if (renderableBlocks.length === 0 && renderableFacts.length === 0) {
    return "";
  }

  const lines: string[] = [];
  if (format === "markdown") {
    if (renderableBlocks.length > 0) {
      lines.push("## Prior reasoning hypotheses");
      lines.push("");
      lines.push(
        "_The following are hypotheses drawn from prior cases — they may or may not apply to the current task. Consider each, verify independently, discard if the mechanism does not match._",
      );
      lines.push("");
      for (const hit of renderableBlocks) {
        lines.push(renderBlockHitMarkdown(hit, includeAudit));
        lines.push("");
      }
    }
    if (includeFacts && renderableFacts.length > 0) {
      lines.push("## Known project facts");
      lines.push("");
      for (const f of renderableFacts) {
        lines.push(renderFactHitMarkdown(f, includeAudit));
      }
    }
  } else {
    // XML (for LLMs tuned for XML tagging).
    if (renderableBlocks.length > 0) {
      lines.push("<prior_reasoning>");
      for (const hit of renderableBlocks) {
        lines.push(renderBlockHitXml(hit, includeAudit));
      }
      lines.push("</prior_reasoning>");
    }
    if (includeFacts && renderableFacts.length > 0) {
      lines.push("<project_facts>");
      for (const f of renderableFacts) {
        lines.push(renderFactHitXml(f, includeAudit));
      }
      lines.push("</project_facts>");
    }
  }

  return lines.join("\n").trimEnd();
}

function renderBlockHitMarkdown(hit: BlockHit, audit: boolean): string {
  const parts: string[] = [];
  parts.push(`### Hypothesis: ${hit.block.trigger.situation}`);
  parts.push("");
  parts.push(`_If this pattern applies:_ the mechanism is *${hit.block.body.mechanism}*.`);
  if (hit.block.body.deadEnds.length > 0) {
    parts.push("");
    parts.push("_Known dead ends to avoid:_");
    for (const de of hit.block.body.deadEnds) parts.push(`- ${de}`);
  }
  parts.push("");
  parts.push(`_Possible unlock:_ ${hit.block.body.unlock}`);
  parts.push("");
  parts.push(`_You can verify by:_ ${hit.block.body.verification}`);
  if (audit) {
    parts.push("");
    const refList = hit.refs.map((r) => `${r.traceId} (${r.role})`).join(", ");
    parts.push(
      `<sub>Audit: block ${hit.block.id}, calibrated ${hit.calibratedProb.toFixed(2)}, evidence: ${refList || "none"}</sub>`,
    );
  }
  return parts.join("\n");
}

function renderBlockHitXml(hit: BlockHit, audit: boolean): string {
  const parts: string[] = [];
  parts.push(`  <hypothesis id="${hit.block.id}" calibrated="${hit.calibratedProb.toFixed(3)}">`);
  parts.push(`    <situation>${escapeXml(hit.block.trigger.situation)}</situation>`);
  parts.push(`    <mechanism>${escapeXml(hit.block.body.mechanism)}</mechanism>`);
  if (hit.block.body.deadEnds.length > 0) {
    parts.push("    <dead_ends>");
    for (const de of hit.block.body.deadEnds) {
      parts.push(`      <item>${escapeXml(de)}</item>`);
    }
    parts.push("    </dead_ends>");
  }
  parts.push(`    <unlock>${escapeXml(hit.block.body.unlock)}</unlock>`);
  parts.push(`    <verification>${escapeXml(hit.block.body.verification)}</verification>`);
  if (audit) {
    for (const r of hit.refs) {
      parts.push(`    <evidence trace="${escapeXml(r.traceId)}" role="${r.role}"/>`);
    }
  }
  parts.push("  </hypothesis>");
  return parts.join("\n");
}

function renderFactHitMarkdown(f: FactHit, audit: boolean): string {
  const tag = `(${f.fact.factType}, scope=${f.fact.scope})`;
  const audStr = audit ? ` <sub>[id ${f.fact.id}, conf ${f.fact.confidence.toFixed(2)}]</sub>` : "";
  return `- **${tag}** ${f.fact.statement}${audStr}`;
}

function renderFactHitXml(f: FactHit, audit: boolean): string {
  const auditAttrs = audit
    ? ` id="${f.fact.id}" confidence="${f.fact.confidence.toFixed(3)}"`
    : "";
  return `  <fact scope="${escapeXml(f.fact.scope)}" type="${f.fact.factType}"${auditAttrs}>${escapeXml(f.fact.statement)}</fact>`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
