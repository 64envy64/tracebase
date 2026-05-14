/**
 * Analytics — event export, ingestion, and aggregation (Phase 3).
 *
 * Design doc §L6 treats the append-only JSONL log as the canonical record.
 * Our BlockStore already persists events to SQLite for fast queries; this
 * module adds the two missing pieces:
 *
 *   • `JsonlEventSink` — an append-only JSONL writer that mirrors each
 *     SQLite event. Intended use: wire it into `BlockServer` so every
 *     retrieval / injection is durably recorded on disk even if the DB
 *     is ever wiped or migrated.
 *
 *   • Aggregation helpers — compute the metrics that §L6 binds to the
 *     helpfulness definition. Helpful ≠ retrieved; helpful ≠ injected.
 *     A block is credited `helpful` only on (injection ∧ agent_used ∧
 *     resolved). Counterproductive = (injection ∧ agent_used ∧ ¬resolved).
 *     Shadow queries never contribute to helpful/counterproductive;
 *     they are the reference distribution for resolved lift.
 *
 *   • Emission helpers — typed thin wrappers for middleware / evaluators
 *     to post `agent_used` and `outcome` events without having to
 *     re-derive the event schema.
 *
 * No distillation, no lifecycle repair — those are Phase 4 and 5.
 */
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type {
  AnalyticsEvent,
  RetrievalEvent,
  InjectionEvent,
  AgentUsedEvent,
  OutcomeEvent,
  FactInjectionEvent,
  FactAgentUsedEvent,
} from "../types.js";
import type { BlockStore } from "./block-store.js";
import {
  emptyToolFamilyCounts,
  toolFamilyOf,
  type ToolFamily,
} from "../runtime/tool-family.js";

// ---------------------------------------------------------------------------
// JSONL sink
// ---------------------------------------------------------------------------

/**
 * Append-only JSONL writer. Each event is serialized on its own line and
 * flushed via `appendFileSync` — POSIX O_APPEND gives per-line atomicity
 * for payloads under the filesystem block size (events are well below).
 *
 * The sink is intentionally stateless beyond the path. Re-construct it
 * freely; no handle leaks.
 */
export class JsonlEventSink {
  constructor(public readonly path: string) {
    const dir = dirname(path);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  /**
   * Append one event. The optional `extra` payload is merged at the top
   * level (so `runId`, caller-supplied tags, etc. remain discoverable
   * without re-nesting the original event).
   */
  append(event: AnalyticsEvent, extra?: Record<string, unknown>): void {
    const row = extra ? { ...event, ...extra } : event;
    appendFileSync(this.path, JSON.stringify(row) + "\n");
  }

  /** Read every event. Skips malformed lines rather than throwing. */
  readAll(): AnalyticsEvent[] {
    if (!existsSync(this.path)) return [];
    const text = readFileSync(this.path, "utf8");
    const out: AnalyticsEvent[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as AnalyticsEvent);
      } catch {
        // Corrupt line — skip. In production we'd log; here we stay silent.
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Export / import between BlockStore (SQLite) and JSONL
// ---------------------------------------------------------------------------

/**
 * One-shot export of all events from the BlockStore to a JSONL file.
 * Overwrites any existing file at `path`. Returns the number written.
 *
 * runId survives the round-trip: after the Phase 3 fix, `readEvents`
 * returns events with their `runId` already embedded at the top level,
 * so `sink.append(event)` writes it as-is and `importEventsFromJsonl`
 * recovers it via the same top-level field.
 */
export function exportEventsToJsonl(store: BlockStore, path: string): number {
  const sink = new JsonlEventSink(path);
  // Clear by writing an empty file first — mkdir + truncate semantics.
  const dir = dirname(path);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  try {
    // Truncate.
    appendFileSync(path, "", { flag: "w" });
  } catch {
    // Creating it from scratch is fine too.
  }
  const events = store.readEvents({ limit: 1_000_000 });
  for (const ev of events) sink.append(ev);
  return events.length;
}

/**
 * One-shot import of events from JSONL into the BlockStore. Returns the
 * number imported. Events that fail strict per-variant schema
 * validation are skipped rather than imported with missing fields —
 * half-valid events would silently corrupt aggregate metrics.
 */
export function importEventsFromJsonl(store: BlockStore, path: string): number {
  if (!existsSync(path)) return 0;
  const text = readFileSync(path, "utf8");
  let n = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isValidEvent(parsed)) continue;
    // After isValidEvent, the top-level runId (if any) is already on the
    // parsed object — `appendEvent` preserves it via event.runId.
    store.appendEvent(parsed);
    n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Strict per-variant event validation.
//
// A half-valid event (missing required fields for its union case) would
// silently miscount aggregates. Validate each case strictly so imports
// reject bad rows at the boundary rather than letting them contaminate
// the event log.
// ---------------------------------------------------------------------------

function isValidEvent(ev: unknown): ev is AnalyticsEvent {
  if (!ev || typeof ev !== "object") return false;
  const e = ev as Record<string, unknown>;
  if (typeof e.ts !== "number" || !Number.isFinite(e.ts)) return false;
  if (typeof e.queryId !== "string" || e.queryId.length === 0) return false;
  if (e.runId !== undefined && typeof e.runId !== "string") return false;

  switch (e.event) {
    case "retrieval":        return isValidRetrieval(e);
    case "injection":        return isValidInjection(e);
    case "agent_used":       return isValidAgentUsed(e);
    case "outcome":          return isValidOutcome(e);
    case "fact_injection":   return isValidFactInjection(e);
    case "fact_agent_used":  return isValidFactAgentUsed(e);
    default:                 return false;
  }
}

function isValidRetrieval(e: Record<string, unknown>): boolean {
  if (typeof e.shadow !== "boolean") return false;
  if (!Array.isArray(e.candidates)) return false;
  for (const c of e.candidates) {
    if (!c || typeof c !== "object") return false;
    const cc = c as Record<string, unknown>;
    if (typeof cc.blockId !== "string" || cc.blockId.length === 0) return false;
    if (typeof cc.score !== "number" || !Number.isFinite(cc.score)) return false;
  }
  // factCandidates is optional; when present, validate its shape.
  if (e.factCandidates !== undefined) {
    if (!Array.isArray(e.factCandidates)) return false;
    for (const c of e.factCandidates) {
      if (!c || typeof c !== "object") return false;
      const cc = c as Record<string, unknown>;
      if (typeof cc.factId !== "string" || cc.factId.length === 0) return false;
      if (typeof cc.score !== "number" || !Number.isFinite(cc.score)) return false;
    }
  }
  return true;
}

function isValidInjection(e: Record<string, unknown>): boolean {
  if (typeof e.blockId !== "string" || e.blockId.length === 0) return false;
  if (typeof e.score !== "number" || !Number.isFinite(e.score)) return false;
  if (e.calibratedProb !== undefined &&
      (typeof e.calibratedProb !== "number" || !Number.isFinite(e.calibratedProb))) {
    return false;
  }
  return true;
}

function isValidAgentUsed(e: Record<string, unknown>): boolean {
  if (typeof e.blockId !== "string" || e.blockId.length === 0) return false;
  if (e.matchSignal !== "jaccard" && e.matchSignal !== "embedding" && e.matchSignal !== "explicit") {
    return false;
  }
  if (typeof e.matchScore !== "number" || !Number.isFinite(e.matchScore)) return false;
  return true;
}

function isValidOutcome(e: Record<string, unknown>): boolean {
  if (typeof e.resolved !== "boolean") return false;
  if (typeof e.control !== "boolean") return false;
  if (e.regressed !== undefined && typeof e.regressed !== "boolean") return false;
  if (e.tokens !== undefined && (typeof e.tokens !== "number" || !Number.isFinite(e.tokens))) return false;
  if (e.steps !== undefined && (typeof e.steps !== "number" || !Number.isFinite(e.steps))) return false;
  if (e.durationMs !== undefined && (typeof e.durationMs !== "number" || !Number.isFinite(e.durationMs))) return false;
  // attribution is optional. Absent === explicit (backwards-compat).
  // Anything other than the closed union must reject — otherwise a
  // JSONL import with `attribution: "garbage"` would slip through
  // and get silently counted as explicit by computeAggregates'
  // verifiedHelpfulRuns gate (which only excludes the literal
  // "inferred"). Tightening here is the only place that catches
  // malformed external feeds.
  if (e.attribution !== undefined && e.attribution !== "explicit" && e.attribution !== "inferred") {
    return false;
  }
  return true;
}

function isValidFactInjection(e: Record<string, unknown>): boolean {
  if (typeof e.factId !== "string" || e.factId.length === 0) return false;
  if (typeof e.score !== "number" || !Number.isFinite(e.score)) return false;
  if (e.calibratedProb !== undefined &&
      (typeof e.calibratedProb !== "number" || !Number.isFinite(e.calibratedProb))) {
    return false;
  }
  return true;
}

function isValidFactAgentUsed(e: Record<string, unknown>): boolean {
  if (typeof e.factId !== "string" || e.factId.length === 0) return false;
  if (e.matchSignal !== "jaccard" && e.matchSignal !== "embedding" && e.matchSignal !== "explicit") {
    return false;
  }
  if (typeof e.matchScore !== "number" || !Number.isFinite(e.matchScore)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// EventEmitter — unified emission with optional side-sink fan-out.
//
// Motivation: without this abstraction, a high-volume client could
// easily wire a JSONL sink into `BlockServer` (covering retrieval +
// injection) but forget to thread the same sink through
// `emitAgentUsed` / `emitOutcome` — producing a silent undercount.
// EventEmitter carries the sink and the store together so any emission
// surface gets both destinations for free.
// ---------------------------------------------------------------------------

export type SideSink = (
  event: AnalyticsEvent,
  extra?: { runId?: string },
) => void;

export class EventEmitter {
  constructor(
    private readonly store: BlockStore,
    private readonly sideSink?: SideSink,
  ) {}

  /** Persist the event to SQLite and fan out to the side sink if set. */
  emit(event: AnalyticsEvent, extra?: { runId?: string }): void {
    this.store.appendEvent(event, extra);
    if (this.sideSink) {
      try {
        this.sideSink(event, extra);
      } catch {
        // Bad side sinks must never break emission.
      }
    }
  }

  /** Convenience: the underlying BlockStore (for callers that need both). */
  get blockStore(): BlockStore {
    return this.store;
  }
}

type EmitTarget = BlockStore | EventEmitter;

function toEmitter(target: EmitTarget): EventEmitter {
  return target instanceof EventEmitter ? target : new EventEmitter(target);
}

// ---------------------------------------------------------------------------
// Emission helpers for agent_used and outcome
// ---------------------------------------------------------------------------

/**
 * Emit an `agent_used` event for a given (queryId, blockId) pair.
 * Middleware / evaluator wrappers call this after they observe that the
 * agent's output resembled the injected block (e.g. Jaccard ≥ τ on the
 * agent's patch vs. the block's unlock text, or explicit mention by id).
 *
 * Accepts either a BlockStore (back-compat, no side-sink fan-out) or an
 * EventEmitter (will also fan out to a JSONL sink if configured).
 */
export function emitAgentUsed(
  target: EmitTarget,
  args: {
    queryId: string;
    blockId: string;
    matchSignal: "jaccard" | "embedding" | "explicit";
    matchScore: number;
    ts?: number;
    runId?: string;
  },
): AgentUsedEvent {
  const ev: AgentUsedEvent = {
    ts: args.ts ?? Date.now(),
    queryId: args.queryId,
    event: "agent_used",
    blockId: args.blockId,
    matchSignal: args.matchSignal,
    matchScore: args.matchScore,
  };
  toEmitter(target).emit(ev, args.runId !== undefined ? { runId: args.runId } : undefined);
  return ev;
}

/**
 * Fact-side analogue of `emitAgentUsed`. Called by middleware /
 * evaluators when the agent's output shows observable evidence the
 * agent acted on a ProjectFact (matched statement, cited id, etc.).
 * Fact helpfulness is scored independently from block helpfulness.
 */
export function emitFactAgentUsed(
  target: EmitTarget,
  args: {
    queryId: string;
    factId: string;
    matchSignal: "jaccard" | "embedding" | "explicit";
    matchScore: number;
    ts?: number;
    runId?: string;
  },
): FactAgentUsedEvent {
  const ev: FactAgentUsedEvent = {
    ts: args.ts ?? Date.now(),
    queryId: args.queryId,
    event: "fact_agent_used",
    factId: args.factId,
    matchSignal: args.matchSignal,
    matchScore: args.matchScore,
  };
  toEmitter(target).emit(ev, args.runId !== undefined ? { runId: args.runId } : undefined);
  return ev;
}

/**
 * Emit an `outcome` event for a task run. `control=true` marks the
 * query as part of the shadow control group (no injection was shown).
 * `resolved` is the grader-verified pass/fail, not a self-report.
 *
 * Accepts either a BlockStore (back-compat) or an EventEmitter (fans
 * out to the configured side sink in addition to SQLite).
 */
export function emitOutcome(
  target: EmitTarget,
  args: {
    queryId: string;
    resolved: boolean;
    control: boolean;
    regressed?: boolean;
    tokens?: number;
    steps?: number;
    /**
     * Wall-clock duration in ms. Required by `computeUsageMetrics`
     * for the causal latency lift — the headline integration
     * metric. 0.7.1 wires this end-to-end via the MCP
     * `record_reasoning_outcome` tool and the
     * `ContextualRuntimeProvider.recordOutcome` boundary; older
     * call sites that omit it stay backwards-compatible.
     */
    durationMs?: number;
    /**
     * Provenance marker. Omit (default) when the canonical MCP /
     * SDK path is calling — outcome is treated as explicit. Pass
     * `"inferred"` from the Stop-hook attribution layer so
     * downstream metrics can show verified vs estimated splits.
     */
    attribution?: "explicit" | "inferred";
    ts?: number;
    runId?: string;
  },
): OutcomeEvent {
  const ev: OutcomeEvent = {
    ts: args.ts ?? Date.now(),
    queryId: args.queryId,
    event: "outcome",
    resolved: args.resolved,
    control: args.control,
    ...(args.regressed !== undefined ? { regressed: args.regressed } : {}),
    ...(args.tokens !== undefined ? { tokens: args.tokens } : {}),
    ...(args.steps !== undefined ? { steps: args.steps } : {}),
    ...(args.durationMs !== undefined ? { durationMs: args.durationMs } : {}),
    ...(args.attribution !== undefined ? { attribution: args.attribution } : {}),
  };
  toEmitter(target).emit(ev, args.runId !== undefined ? { runId: args.runId } : undefined);
  return ev;
}

// ---------------------------------------------------------------------------
// Aggregation — the §L6 helpfulness definition
// ---------------------------------------------------------------------------

export interface AggregateCounts {
  retrieval: number;
  injection: number;
  agentUsed: number;
  outcome: number;
  factInjection: number;
  factAgentUsed: number;
}

export interface RetrievalSplit {
  total: number;
  shadow: number;
  treatment: number;
  /**
   * 0.5.7 §C — sum of `injectedTokensEstimate` across every
   * retrieval event in the window. Used by `computeUsageMetrics`
   * to compute `netTokenImpact = tokensLift.value -
   * totalInjectedTokensEstimate`. Always finite; 0 when no
   * retrievals happened or none cleared the budget.
   */
  totalInjectedTokensEstimate: number;
}

export interface OutcomeSplit {
  totalTreatment: number;
  totalShadow: number;
  resolvedTreatment: number;
  resolvedShadow: number;
  /** Raw token usage per outcome, if tokens were recorded. */
  tokensTreatment: number[];
  tokensShadow: number[];
  /** Raw wall-clock duration per outcome, if `durationMs` was recorded. */
  durationsTreatment: number[];
  durationsShadow: number[];
}

/**
 * One arm of the Phase 3 causal split — either the assisted arm
 * (shadow === false AND at least one injection event fired for the
 * queryId) or the experimental holdout arm (retrieval event with
 * shadow === true AND controlReason === "holdout").
 *
 * `resolved` counts outcomes with `resolved === true`. `tokens` and
 * `durations` are raw per-outcome arrays (only populated when the
 * outcome event carried them) so downstream math can decide whether
 * to compute per-run means, totals, or confidence intervals without
 * being forced through an intermediate aggregate.
 */
export interface CausalCohort {
  /** Distinct queryIds in this arm that have an outcome event. */
  n: number;
  /** Absolute count of `outcome.resolved === true` in this arm. */
  resolved: number;
  /** Raw outcome.tokens values for the arm, if present. */
  tokens: number[];
  /** Raw outcome.durationMs values for the arm, if present. */
  durations: number[];
}

/**
 * Causal comparison split.
 *
 * Classification is strictly by `retrieval.controlReason`:
 *
 *   - `assisted`        — retrieval event with shadow === false AND
 *                          at least one injection (block or fact)
 *                          event for the queryId. A shadow === false
 *                          run with zero injection events never
 *                          reached the agent with memory; the
 *                          treatment arm for causal purposes is only
 *                          the runs that were actually assisted.
 *   - `holdout`         — retrieval event with shadow === true AND
 *                          controlReason === "holdout". These are
 *                          gate-eligible runs withheld from
 *                          injection by the deterministic
 *                          experimental assignment in Phase 3.2.
 *   - manual / legacy   — shadow === true with any other
 *                          controlReason (undefined or "shadow")
 *                          NEVER enters either arm. The existing
 *                          diagnostic `OutcomeSplit` still covers
 *                          those events; Phase 1's `estimated`
 *                          metrics still consume them.
 */
export interface CausalSplit {
  assisted: CausalCohort;
  holdout: CausalCohort;
}

/**
 * Funnel-stage counts, each defined as a *distinct queryId* count so
 * that `eligible ≥ recalled ≥ injected ≥ used ≥ helpful` holds
 * monotonically over any window. This is the single event-log-derived
 * surface the UI consumes — the dashboard never re-derives these.
 */
export interface AggregateFunnel {
  /** Distinct queryIds that produced any retrieval event (treatment + shadow). */
  eligibleRuns: number;
  /** Subset of eligibleRuns where retrieval returned at least one candidate. */
  recalledRuns: number;
  /** Distinct queryIds with at least one injection (block or fact). */
  injectedRuns: number;
  /** Distinct queryIds with at least one agent_used or fact_agent_used event. */
  usedRuns: number;
  /**
   * Distinct queryIds satisfying the §L6 helpfulness definition:
   * injection ∧ agent_used ∧ outcome.resolved. At least one
   * (injected block or fact, used, resolved) triple per query.
   * Counts BOTH explicit and Stop-hook-inferred outcomes — see
   * `verifiedHelpfulRuns` for the explicit-only subset.
   */
  helpfulRuns: number;
  /**
   * Subset of `helpfulRuns` whose outcome event was reported
   * through the canonical path (MCP `record_reasoning_outcome` /
   * SDK middleware) — i.e. the agent itself attested to the
   * resolution. Outcomes written by the Stop-hook attribution
   * layer (`attribution: "inferred"`) are excluded here so a
   * soft heuristic-derived resolution can't pose as grader-
   * verified. Backwards-compat: events without `attribution`
   * are treated as explicit and DO count here.
   */
  verifiedHelpfulRuns: number;
}

export interface AggregateRates {
  /**
   * Fraction of non-shadow retrievals that produced at least one
   * injection (block OR fact). Measures how often the gate actually
   * fires in the wild.
   */
  coverage: number;
  // Block-level rates (procedural memory L2).
  /** agent_used ÷ injection for blocks. null when no block injections. */
  hitRate: number | null;
  /** helpful ÷ injection for blocks, per §L6. null when no block injections. */
  helpfulRate: number | null;
  /** counterproductive ÷ injection for blocks. null when no block injections. */
  counterproductiveRate: number | null;
  // Fact-level rates (semantic memory L4). Computed symmetrically.
  /** fact_agent_used ÷ fact_injection. null when no fact injections. */
  factHitRate: number | null;
  /** helpful ÷ fact_injection, using the parallel §L6 helpfulness definition. */
  factHelpfulRate: number | null;
  /** counterproductive ÷ fact_injection. null when no fact injections. */
  factCounterproductiveRate: number | null;
  /**
   * Resolved-rate lift of treatment (injected) minus shadow (control).
   * null when either arm is empty; this is the only aggregate that
   * requires a non-empty shadow group.
   */
  resolvedLift: number | null;
  /** Mean tokens(treatment) − mean tokens(shadow). null if either empty. */
  tokenLift: number | null;
}

export interface PerBlockStats {
  blockId: string;
  retrieved: number;
  injected: number;
  agentUsed: number;
  helpful: number;
  /**
   * Subset of `helpful` whose outcome event carried
   * `attribution: "explicit"` (or no attribution field, treated as
   * explicit for backwards-compat). Excludes Stop-hook-inferred
   * resolutions. Kept in the SAME unit as `helpful` (per-block
   * sum) so callers can subtract for the inferred portion without
   * fighting the queryId-distinct funnel counters.
   */
  verifiedHelpful: number;
  counterproductive: number;
  neutral: number;
}

/** Parallel stats for facts (L4 semantic memory). */
export interface PerFactStats {
  factId: string;
  retrieved: number;
  injected: number;
  agentUsed: number;
  helpful: number;
  /** Same provenance-aware subset of `helpful` as on PerBlockStats. */
  verifiedHelpful: number;
  counterproductive: number;
  neutral: number;
}

export interface AggregateIntegrity {
  /**
   * Number of queries where the retrieval event's `shadow` flag
   * disagreed with the outcome event's `control` flag. Retrieval's
   * flag is treated as authoritative (it reflects what actually
   * happened at serving time); this counter surfaces data-quality
   * issues rather than silently distorting lift metrics.
   */
  shadowControlMismatches: number;
  /**
   * Number of outcome events that had no corresponding retrieval
   * event in the aggregation window. Such outcomes fall back to the
   * outcome's own `control` field for classification.
   */
  outcomesWithoutRetrieval: number;
}

export interface EventAggregates {
  counts: AggregateCounts;
  retrieval: RetrievalSplit;
  outcome: OutcomeSplit;
  rates: AggregateRates;
  /** Funnel-stage counts, queryId-deduplicated. See AggregateFunnel. */
  funnel: AggregateFunnel;
  /**
   * Phase 3 causal split, keyed strictly on `retrieval.controlReason`.
   * See `CausalSplit` for the exact cohort rules. Zero-filled when no
   * assisted / holdout data is present — consumers distinguish "no
   * experiment running" from "experiment running but no outcomes yet"
   * by checking cohort.n.
   */
  causal: CausalSplit;
  perBlock: PerBlockStats[];
  /** Per-fact stats; parallel structure to perBlock. */
  perFact: PerFactStats[];
  /**
   * Integrity diagnostics. Non-zero values do not invalidate the
   * metrics — they signal that upstream instrumentation has data-
   * quality issues a caller may want to fix before trusting lift.
   */
  integrity: AggregateIntegrity;
  /**
   * 0.7.0 §6 stable §2 — per-mechanism aggregates derived from the
   * 0.7-rc.1+ event stream. Walked once over the same event
   * iteration as the rest of `EventAggregates` (no extra DB reads).
   * Cloud-allowlist shape is mirrored exactly: counts + closed-enum
   * histograms only. Free-form fields (paths, fileIds, sessionId,
   * argKey, raw toolName, summary text) NEVER enter this object —
   * tally is by closed-enum bucket key, not by source string.
   */
  mechanisms: MechanismAggregates;
  /** The window used; undefined on either side means "open-ended". */
  window: { afterTs?: number; beforeTs?: number };
}

// ---------------------------------------------------------------------------
// 0.7.0 §6 stable §2 — mechanism aggregates
// ---------------------------------------------------------------------------

/** Closed-enum summarizer values (matches cloud allowlist). */
export type MechanismSummarizer = "heuristic" | "embedding" | "llm";

/** Closed-enum context-fold skip reasons (matches cloud allowlist). */
export type MechanismFoldReason =
  | "no-new-turns"
  | "hash-collision"
  | "leakage"
  | "injection"
  | "below-threshold";

/** Closed-enum loop-redirect anchor kinds (matches cloud allowlist). */
export type MechanismLoopKind = "block" | "file";

/** Closed-enum prompt-cache surfaces (matches cloud allowlist). */
export type MechanismCacheSurface = "anthropic" | "openai";

/** Closed-enum injection-rejection patterns (matches cloud allowlist). */
export type MechanismInjectionPattern =
  | "role-override"
  | "persona-flip"
  | "system-spoof"
  | "delimiter-spoof"
  | "exfil-prompt"
  | "tool-coercion";

const FOLD_REASONS: readonly MechanismFoldReason[] = [
  "no-new-turns",
  "hash-collision",
  "leakage",
  "injection",
  "below-threshold",
] as const;

const LOOP_KINDS: readonly MechanismLoopKind[] = ["block", "file"] as const;

const CACHE_SURFACES: readonly MechanismCacheSurface[] = [
  "anthropic",
  "openai",
] as const;

const INJECTION_PATTERNS: readonly MechanismInjectionPattern[] = [
  "role-override",
  "persona-flip",
  "system-spoof",
  "delimiter-spoof",
  "exfil-prompt",
  "tool-coercion",
] as const;

const SUMMARIZERS: readonly MechanismSummarizer[] = [
  "heuristic",
  "embedding",
  "llm",
] as const;

export interface MechanismAggregates {
  fileIndex: {
    completedCount: number;
    bytesSummarized: number;
    durationMs: number;
    pending: number;
    skippedCount: number;
    bySummarizer: Record<MechanismSummarizer, number>;
  };
  fileMemory: {
    recallCount: number;
    tokensInjected: number;
    bytesAvoided: number;
  };
  toolSupervision: {
    warnCount: number;
    suppressedCount: number;
    byFamily: Record<ToolFamily, number>;
  };
  loopRedirect: {
    redirectCount: number;
    fallbackCount: number;
    byKind: Record<MechanismLoopKind, number>;
  };
  contextFold: {
    chunkCount: number;
    tokensBeforeSum: number;
    tokensAfterSum: number;
    skipCount: number;
    bySummarizer: Record<MechanismSummarizer, number>;
    byReason: Record<MechanismFoldReason, number>;
  };
  injectionRejected: {
    rejectCount: number;
    byPattern: Record<MechanismInjectionPattern, number>;
  };
  promptCache: {
    hitCount: number;
    tokensSavedSum: number;
    bySurface: Record<MechanismCacheSurface, number>;
  };
}

function emptySummarizerCounts(): Record<MechanismSummarizer, number> {
  return { heuristic: 0, embedding: 0, llm: 0 };
}

function emptyFoldReasonCounts(): Record<MechanismFoldReason, number> {
  return {
    "no-new-turns": 0,
    "hash-collision": 0,
    leakage: 0,
    injection: 0,
    "below-threshold": 0,
  };
}

function emptyLoopKindCounts(): Record<MechanismLoopKind, number> {
  return { block: 0, file: 0 };
}

function emptyCacheSurfaceCounts(): Record<MechanismCacheSurface, number> {
  return { anthropic: 0, openai: 0 };
}

function emptyInjectionPatternCounts(): Record<MechanismInjectionPattern, number> {
  return {
    "role-override": 0,
    "persona-flip": 0,
    "system-spoof": 0,
    "delimiter-spoof": 0,
    "exfil-prompt": 0,
    "tool-coercion": 0,
  };
}

function emptyMechanismAggregates(): MechanismAggregates {
  return {
    fileIndex: {
      completedCount: 0,
      bytesSummarized: 0,
      durationMs: 0,
      pending: 0,
      skippedCount: 0,
      bySummarizer: emptySummarizerCounts(),
    },
    fileMemory: { recallCount: 0, tokensInjected: 0, bytesAvoided: 0 },
    toolSupervision: {
      warnCount: 0,
      suppressedCount: 0,
      byFamily: emptyToolFamilyCounts(),
    },
    loopRedirect: {
      redirectCount: 0,
      fallbackCount: 0,
      byKind: emptyLoopKindCounts(),
    },
    contextFold: {
      chunkCount: 0,
      tokensBeforeSum: 0,
      tokensAfterSum: 0,
      skipCount: 0,
      bySummarizer: emptySummarizerCounts(),
      byReason: emptyFoldReasonCounts(),
    },
    injectionRejected: {
      rejectCount: 0,
      byPattern: emptyInjectionPatternCounts(),
    },
    promptCache: {
      hitCount: 0,
      tokensSavedSum: 0,
      bySurface: emptyCacheSurfaceCounts(),
    },
  };
}

/**
 * Tally one event into the mechanism aggregates. Pure: only the
 * supplied event mutates `aggs` (caller mutates a fresh object).
 *
 * Closed-enum invariant: free-form values that don't match the
 * frozen vocabulary fall on the floor — they NEVER widen the
 * histogram. The cloud allowlist drops anything outside the
 * declared keys at the wire either way; failing closed here keeps
 * the local aggregate honest with what would actually ship.
 */
function tallyMechanismEvent(
  aggs: MechanismAggregates,
  ev: AnalyticsEvent,
): void {
  switch (ev.event) {
    case "file_index.completed": {
      aggs.fileIndex.completedCount += 1;
      aggs.fileIndex.bytesSummarized += ev.bytesSummarized;
      aggs.fileIndex.durationMs += ev.durationMs;
      // `pending` is the queue size at end of THIS walk; the
      // window-summed view tracks the running tally so a dashboard
      // sees "indexer made N walks, total scanned, current backlog".
      aggs.fileIndex.pending = ev.pending;
      if (SUMMARIZERS.includes(ev.summarizer)) {
        aggs.fileIndex.bySummarizer[ev.summarizer] += 1;
      }
      break;
    }
    case "file_index.skipped": {
      aggs.fileIndex.skippedCount += 1;
      // `reason` is intentionally NOT tallied here — the spec
      // omits a reason histogram for fileIndex.skipped because
      // the reason set is open-ended (binary / too-large / future
      // reasons). Total count is enough signal for the dashboard.
      break;
    }
    case "file_memory.recalled": {
      aggs.fileMemory.recallCount += 1;
      aggs.fileMemory.tokensInjected += ev.tokensInjected;
      aggs.fileMemory.bytesAvoided += ev.bytesAvoided;
      // ev.fileIds is read-once and discarded — never enters the
      // aggregate, so paths/ids cannot leak through this surface.
      break;
    }
    case "tool_supervision.warned": {
      aggs.toolSupervision.warnCount += 1;
      const family = toolFamilyOf(ev.toolName);
      aggs.toolSupervision.byFamily[family] += 1;
      break;
    }
    case "tool_supervision.suppressed": {
      aggs.toolSupervision.suppressedCount += 1;
      const family = toolFamilyOf(ev.toolName);
      aggs.toolSupervision.byFamily[family] += 1;
      // ev.argKey + raw ev.toolName never read into the aggregate —
      // the family bucket is the only thing that ships.
      break;
    }
    case "loop.redirected": {
      aggs.loopRedirect.redirectCount += 1;
      if (LOOP_KINDS.includes(ev.anchorKind)) {
        aggs.loopRedirect.byKind[ev.anchorKind] += 1;
      }
      break;
    }
    case "loop.fallback": {
      aggs.loopRedirect.fallbackCount += 1;
      break;
    }
    case "context.folded": {
      aggs.contextFold.chunkCount += 1;
      aggs.contextFold.tokensBeforeSum += ev.tokensBefore;
      aggs.contextFold.tokensAfterSum += ev.tokensAfter;
      if (SUMMARIZERS.includes(ev.summarizer)) {
        aggs.contextFold.bySummarizer[ev.summarizer] += 1;
      }
      // ev.sessionId + ev.chunkRange never read into the aggregate.
      break;
    }
    case "context.fold_skipped": {
      aggs.contextFold.skipCount += 1;
      if (FOLD_REASONS.includes(ev.reason)) {
        aggs.contextFold.byReason[ev.reason] += 1;
      }
      break;
    }
    case "store.injection_rejected": {
      aggs.injectionRejected.rejectCount += 1;
      if (
        (INJECTION_PATTERNS as readonly string[]).includes(ev.patternName)
      ) {
        aggs.injectionRejected.byPattern[
          ev.patternName as MechanismInjectionPattern
        ] += 1;
      }
      // Unknown / future pattern names fall on the floor — the
      // cloud allowlist would drop them at the wire either way.
      break;
    }
    case "cache.prompt_hit": {
      aggs.promptCache.hitCount += 1;
      aggs.promptCache.tokensSavedSum += ev.tokensSaved;
      if (CACHE_SURFACES.includes(ev.surface)) {
        aggs.promptCache.bySurface[ev.surface] += 1;
      }
      break;
    }
    default:
      // Other event kinds (retrieval / injection / outcome / etc.)
      // are not mechanism-side; their aggregates live elsewhere on
      // EventAggregates.
      break;
  }
}

export interface AggregateOptions {
  afterTs?: number;
  beforeTs?: number;
  /** Restrict to a single run. */
  runId?: string;
}

/**
 * Compute aggregates from the BlockStore event log.
 *
 * The helpfulness definition is the one in design doc §L6, verbatim:
 *   helpful       = injection ∧ agent_used ∧ outcome.resolved
 *   counter       = injection ∧ agent_used ∧ ¬outcome.resolved
 *   neutral       = injection ∧ ¬ agent_used
 *   shadow        = retrieval.shadow = true (no injection shown)
 * Attribution is by (queryId, blockId) pairs. Multiple injections for
 * the same queryId are supported; a queryId with N injections gets
 * joined against the single outcome event for that queryId.
 */
export function computeAggregates(
  store: BlockStore,
  opts: AggregateOptions = {},
): EventAggregates {
  const events = store.readEvents({
    afterTs: opts.afterTs,
    beforeTs: opts.beforeTs,
    runId: opts.runId,
    limit: 1_000_000,
  });

  const counts: AggregateCounts = {
    retrieval: 0, injection: 0, agentUsed: 0, outcome: 0,
    factInjection: 0, factAgentUsed: 0,
  };

  // 0.5.7 §C — running sum of injection-side token estimates.
  // Each retrieval event carries an `injectedTokensEstimate` that
  // captures the token cost of `additionalContext` for that
  // query; total across the window is the input-side spend that
  // `netTokenImpact` subtracts from `tokensLift.value`.
  let totalInjectedTokensEstimate = 0;

  // Indexes.
  const shadowByQuery = new Map<string, boolean>();
  const injectionsByQuery = new Map<string, Set<string>>();  // queryId → blockIds
  const agentUsedByQuery = new Map<string, Set<string>>();
  const outcomeByQuery = new Map<string, OutcomeEvent>();
  const retrievalTreatment = new Set<string>();  // queryIds with non-shadow retrieval
  const retrievalShadow = new Set<string>();
  // Fact-side indexes — parallel to the block-side ones.
  const factInjectionsByQuery = new Map<string, Set<string>>();
  const factAgentUsedByQuery = new Map<string, Set<string>>();
  // Funnel bookkeeping. Each Set tracks distinct queryIds at that stage
  // so the final funnel counts are monotonic and dedupe-safe.
  const eligibleQueries = new Set<string>();
  const recalledQueries = new Set<string>();
  // Phase 3 — per-queryId cohort classification. `controlReason` is
  // recorded verbatim from the retrieval event so "undefined on a
  // shadow: true event" (legacy/manual diagnostic) is distinguishable
  // from an explicit "holdout" tag. Only the explicit "holdout" tag
  // enters the causal numbers; everything else is either assisted,
  // manual shadow (diagnostic only), or ineligible.
  const controlReasonByQuery = new Map<string, "shadow" | "holdout" | undefined>();

  // 0.7.0 §6 stable §2 — mechanism aggregates. Tallied in the same
  // event walk so we make exactly one pass over `events`.
  const mechanisms = emptyMechanismAggregates();

  for (const ev of events) {
    // Mechanism tally runs first — it dispatches on its own event-
    // kind subset and is a no-op on retrieval/injection/etc. The
    // existing switch below handles those.
    tallyMechanismEvent(mechanisms, ev);

    switch (ev.event) {
      case "retrieval": {
        counts.retrieval++;
        shadowByQuery.set(ev.queryId, ev.shadow);
        controlReasonByQuery.set(ev.queryId, ev.controlReason);
        if (ev.shadow) retrievalShadow.add(ev.queryId);
        else retrievalTreatment.add(ev.queryId);
        // 0.5.7 §C — tally injection cost. Legacy events without
        // the field contribute 0; treating undefined as 0 keeps
        // mixed-version stores honest (we under-count rather than
        // hallucinating cost).
        if (typeof ev.injectedTokensEstimate === "number") {
          totalInjectedTokensEstimate += ev.injectedTokensEstimate;
        }
        eligibleQueries.add(ev.queryId);
        const anyCandidates =
          ev.candidates.length > 0 || (ev.factCandidates?.length ?? 0) > 0;
        if (anyCandidates) recalledQueries.add(ev.queryId);
        break;
      }
      case "injection": {
        counts.injection++;
        let set = injectionsByQuery.get(ev.queryId);
        if (!set) { set = new Set(); injectionsByQuery.set(ev.queryId, set); }
        set.add(ev.blockId);
        break;
      }
      case "agent_used": {
        counts.agentUsed++;
        let set = agentUsedByQuery.get(ev.queryId);
        if (!set) { set = new Set(); agentUsedByQuery.set(ev.queryId, set); }
        set.add(ev.blockId);
        break;
      }
      case "outcome": {
        counts.outcome++;
        outcomeByQuery.set(ev.queryId, ev);
        break;
      }
      case "fact_injection": {
        counts.factInjection++;
        let set = factInjectionsByQuery.get(ev.queryId);
        if (!set) { set = new Set(); factInjectionsByQuery.set(ev.queryId, set); }
        set.add(ev.factId);
        break;
      }
      case "fact_agent_used": {
        counts.factAgentUsed++;
        let set = factAgentUsedByQuery.get(ev.queryId);
        if (!set) { set = new Set(); factAgentUsedByQuery.set(ev.queryId, set); }
        set.add(ev.factId);
        break;
      }
    }
  }

  // Per-block roll-up.
  const perBlockMap = new Map<string, PerBlockStats>();
  function bumpBlock(id: string, field: keyof Omit<PerBlockStats, "blockId">): void {
    let row = perBlockMap.get(id);
    if (!row) {
      row = { blockId: id, retrieved: 0, injected: 0, agentUsed: 0, helpful: 0, verifiedHelpful: 0, counterproductive: 0, neutral: 0 };
      perBlockMap.set(id, row);
    }
    row[field] = (row[field] as number) + 1;
  }

  // Per-fact roll-up (same shape).
  const perFactMap = new Map<string, PerFactStats>();
  function bumpFact(id: string, field: keyof Omit<PerFactStats, "factId">): void {
    let row = perFactMap.get(id);
    if (!row) {
      row = { factId: id, retrieved: 0, injected: 0, agentUsed: 0, helpful: 0, verifiedHelpful: 0, counterproductive: 0, neutral: 0 };
      perFactMap.set(id, row);
    }
    row[field] = (row[field] as number) + 1;
  }

  // retrieved counts use the retrieval event's candidate lists.
  // Blocks come from `candidates`; facts from the optional `factCandidates`.
  for (const ev of events) {
    if (ev.event !== "retrieval") continue;
    for (const c of ev.candidates) bumpBlock(c.blockId, "retrieved");
    if (ev.factCandidates) {
      for (const c of ev.factCandidates) bumpFact(c.factId, "retrieved");
    }
  }

  // For each queryId that has block injection(s), classify against outcome.
  for (const [queryId, blockIds] of injectionsByQuery) {
    const used = agentUsedByQuery.get(queryId) ?? new Set<string>();
    const outcome = outcomeByQuery.get(queryId);
    for (const bId of blockIds) {
      bumpBlock(bId, "injected");
      if (used.has(bId)) bumpBlock(bId, "agentUsed");

      if (!outcome) continue; // no classification without an outcome
      if (used.has(bId)) {
        if (outcome.resolved) {
          bumpBlock(bId, "helpful");
          // verifiedHelpful = same unit as helpful, restricted to
          // outcomes the canonical MCP/SDK path wrote. Absent
          // attribution counts as explicit for backwards-compat
          // (pre-attribution events all fall through here).
          if (outcome.attribution !== "inferred") {
            bumpBlock(bId, "verifiedHelpful");
          }
        } else {
          bumpBlock(bId, "counterproductive");
        }
      } else {
        bumpBlock(bId, "neutral");
      }
    }
  }

  // Fact-side classification — symmetric to block side.
  for (const [queryId, factIds] of factInjectionsByQuery) {
    const used = factAgentUsedByQuery.get(queryId) ?? new Set<string>();
    const outcome = outcomeByQuery.get(queryId);
    for (const fId of factIds) {
      bumpFact(fId, "injected");
      if (used.has(fId)) bumpFact(fId, "agentUsed");

      if (!outcome) continue;
      if (used.has(fId)) {
        if (outcome.resolved) {
          bumpFact(fId, "helpful");
          if (outcome.attribution !== "inferred") {
            bumpFact(fId, "verifiedHelpful");
          }
        } else {
          bumpFact(fId, "counterproductive");
        }
      } else {
        bumpFact(fId, "neutral");
      }
    }
  }

  // Outcome split — classify each outcome as shadow or treatment using
  // the retrieval event's `shadow` flag as authoritative. If the outcome
  // has no matching retrieval event in the window, fall back to its own
  // `control` field but flag it. Mismatches between retrieval.shadow
  // and outcome.control are counted for integrity reporting.
  const outcomeSplit: OutcomeSplit = {
    totalTreatment: 0,
    totalShadow: 0,
    resolvedTreatment: 0,
    resolvedShadow: 0,
    tokensTreatment: [],
    tokensShadow: [],
    durationsTreatment: [],
    durationsShadow: [],
  };
  let shadowControlMismatches = 0;
  let outcomesWithoutRetrieval = 0;
  for (const [queryId, outcome] of outcomeByQuery) {
    const retrievalShadow = shadowByQuery.get(queryId);
    let effectiveShadow: boolean;
    if (retrievalShadow === undefined) {
      outcomesWithoutRetrieval++;
      effectiveShadow = outcome.control;
    } else {
      effectiveShadow = retrievalShadow;
      if (retrievalShadow !== outcome.control) shadowControlMismatches++;
    }
    if (effectiveShadow) {
      outcomeSplit.totalShadow++;
      if (outcome.resolved) outcomeSplit.resolvedShadow++;
      if (typeof outcome.tokens === "number") outcomeSplit.tokensShadow.push(outcome.tokens);
      if (typeof outcome.durationMs === "number") outcomeSplit.durationsShadow.push(outcome.durationMs);
    } else {
      outcomeSplit.totalTreatment++;
      if (outcome.resolved) outcomeSplit.resolvedTreatment++;
      if (typeof outcome.tokens === "number") outcomeSplit.tokensTreatment.push(outcome.tokens);
      if (typeof outcome.durationMs === "number") outcomeSplit.durationsTreatment.push(outcome.durationMs);
    }
  }

  // Rates.
  // Coverage: non-shadow queries that had at least one injection of
  // ANY kind (block or fact). Reflects "how often does the gate fire".
  const treatmentWithInjection = [...retrievalTreatment].filter((qid) =>
    (injectionsByQuery.get(qid)?.size ?? 0) > 0 ||
    (factInjectionsByQuery.get(qid)?.size ?? 0) > 0,
  ).length;
  const coverage = retrievalTreatment.size > 0
    ? treatmentWithInjection / retrievalTreatment.size
    : 0;

  // Sum per-block rates.
  let helpfulTotal = 0;
  let counterTotal = 0;
  let agentUsedTotal = 0;
  let injectedTotal = 0;
  for (const row of perBlockMap.values()) {
    helpfulTotal += row.helpful;
    counterTotal += row.counterproductive;
    agentUsedTotal += row.agentUsed;
    injectedTotal += row.injected;
  }

  // Sum per-fact rates.
  let factHelpfulTotal = 0;
  let factCounterTotal = 0;
  let factAgentUsedTotal = 0;
  let factInjectedTotal = 0;
  for (const row of perFactMap.values()) {
    factHelpfulTotal += row.helpful;
    factCounterTotal += row.counterproductive;
    factAgentUsedTotal += row.agentUsed;
    factInjectedTotal += row.injected;
  }

  const rates: AggregateRates = {
    coverage,
    hitRate: injectedTotal > 0 ? agentUsedTotal / injectedTotal : null,
    helpfulRate: injectedTotal > 0 ? helpfulTotal / injectedTotal : null,
    counterproductiveRate: injectedTotal > 0 ? counterTotal / injectedTotal : null,
    factHitRate: factInjectedTotal > 0 ? factAgentUsedTotal / factInjectedTotal : null,
    factHelpfulRate: factInjectedTotal > 0 ? factHelpfulTotal / factInjectedTotal : null,
    factCounterproductiveRate: factInjectedTotal > 0 ? factCounterTotal / factInjectedTotal : null,
    resolvedLift: null,
    tokenLift: null,
  };
  if (outcomeSplit.totalTreatment > 0 && outcomeSplit.totalShadow > 0) {
    rates.resolvedLift =
      outcomeSplit.resolvedTreatment / outcomeSplit.totalTreatment -
      outcomeSplit.resolvedShadow / outcomeSplit.totalShadow;
  }
  if (outcomeSplit.tokensTreatment.length > 0 && outcomeSplit.tokensShadow.length > 0) {
    rates.tokenLift =
      mean(outcomeSplit.tokensTreatment) - mean(outcomeSplit.tokensShadow);
  }

  // Funnel — queryId-deduplicated and derived from the indexes built
  // above. Each stage is a *subset* of the previous by definition
  // (injection implies retrieval ran; helpful implies injection + used
  // + resolved), so the numbers are monotonically non-increasing.
  const injectedQueries = new Set<string>();
  for (const qid of injectionsByQuery.keys()) injectedQueries.add(qid);
  for (const qid of factInjectionsByQuery.keys()) injectedQueries.add(qid);

  const usedQueries = new Set<string>();
  for (const qid of agentUsedByQuery.keys()) usedQueries.add(qid);
  for (const qid of factAgentUsedByQuery.keys()) usedQueries.add(qid);

  const helpfulQueries = new Set<string>();
  const verifiedHelpfulQueries = new Set<string>();
  for (const qid of injectedQueries) {
    if (!usedQueries.has(qid)) continue;
    const outcome = outcomeByQuery.get(qid);
    if (!outcome?.resolved) continue;
    helpfulQueries.add(qid);
    // verifiedHelpfulRuns excludes outcomes the Stop-hook
    // attribution layer wrote heuristically — only explicit MCP /
    // SDK signals count as a grader-verified resolution. Absence of
    // the field means "explicit" (pre-existing rows + canonical
    // path); only `attribution === "inferred"` is excluded.
    if (outcome.attribution !== "inferred") verifiedHelpfulQueries.add(qid);
  }

  const funnel: AggregateFunnel = {
    eligibleRuns: eligibleQueries.size,
    recalledRuns: recalledQueries.size,
    injectedRuns: injectedQueries.size,
    usedRuns: usedQueries.size,
    helpfulRuns: helpfulQueries.size,
    verifiedHelpfulRuns: verifiedHelpfulQueries.size,
  };

  // Phase 3 causal split — classify each queryId with an outcome
  // strictly by retrieval.controlReason. Legacy / manual shadow
  // (controlReason undefined or "shadow") never enters either arm.
  const causal: CausalSplit = {
    assisted: { n: 0, resolved: 0, tokens: [], durations: [] },
    holdout: { n: 0, resolved: 0, tokens: [], durations: [] },
  };
  for (const [queryId, outcome] of outcomeByQuery) {
    const wasShadow = shadowByQuery.get(queryId) ?? outcome.control;
    const reason = controlReasonByQuery.get(queryId);
    let arm: "assisted" | "holdout" | null = null;
    if (wasShadow && reason === "holdout") {
      arm = "holdout";
    } else if (!wasShadow && injectedQueries.has(queryId)) {
      // Assisted arm: non-shadow runs that actually received an
      // injection. A shadow=false run whose gate filtered every
      // candidate did not reach the agent with memory and therefore
      // does not belong in the causal comparison.
      arm = "assisted";
    }
    if (!arm) continue;
    const bucket = causal[arm];
    bucket.n++;
    if (outcome.resolved) bucket.resolved++;
    if (typeof outcome.tokens === "number") bucket.tokens.push(outcome.tokens);
    if (typeof outcome.durationMs === "number") bucket.durations.push(outcome.durationMs);
  }

  return {
    counts,
    retrieval: {
      total: retrievalTreatment.size + retrievalShadow.size,
      shadow: retrievalShadow.size,
      treatment: retrievalTreatment.size,
      totalInjectedTokensEstimate,
    },
    outcome: outcomeSplit,
    rates,
    funnel,
    causal,
    perBlock: [...perBlockMap.values()].sort((a, b) => b.helpful - a.helpful),
    perFact: [...perFactMap.values()].sort((a, b) => b.helpful - a.helpful),
    integrity: {
      shadowControlMismatches,
      outcomesWithoutRetrieval,
    },
    mechanisms,
    window: {
      ...(opts.afterTs !== undefined ? { afterTs: opts.afterTs } : {}),
      ...(opts.beforeTs !== undefined ? { beforeTs: opts.beforeTs } : {}),
    },
  };
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

// Re-exports so consumers do not need two imports.
export type {
  RetrievalEvent,
  InjectionEvent,
  AgentUsedEvent,
  OutcomeEvent,
  FactInjectionEvent,
  FactAgentUsedEvent,
  AnalyticsEvent,
};
