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
} from "../types.js";
import type { BlockStore } from "./block-store.js";

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
 * number imported. Skips events that fail schema validation (wrong type
 * / missing fields).
 *
 * Use case: migrating between deployments, restoring from backup, or
 * sharing trace runs between developers.
 */
export function importEventsFromJsonl(store: BlockStore, path: string): number {
  if (!existsSync(path)) return 0;
  const text = readFileSync(path, "utf8");
  let n = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let ev: AnalyticsEvent;
    try {
      ev = JSON.parse(line) as AnalyticsEvent;
      if (!isValidEvent(ev)) continue;
    } catch {
      continue;
    }
    const extra = extractExtra(ev as unknown as Record<string, unknown>);
    store.appendEvent(ev, extra);
    n++;
  }
  return n;
}

function isValidEvent(ev: unknown): ev is AnalyticsEvent {
  if (!ev || typeof ev !== "object") return false;
  const e = ev as Record<string, unknown>;
  if (typeof e.ts !== "number") return false;
  if (typeof e.queryId !== "string") return false;
  return e.event === "retrieval" || e.event === "injection"
      || e.event === "agent_used" || e.event === "outcome";
}

function extractExtra(raw: Record<string, unknown>): { runId?: string } {
  const out: { runId?: string } = {};
  if (typeof raw.runId === "string") out.runId = raw.runId;
  return out;
}

// ---------------------------------------------------------------------------
// Emission helpers for agent_used and outcome
// ---------------------------------------------------------------------------

/**
 * Emit an `agent_used` event for a given (queryId, blockId) pair.
 * Middleware / evaluator wrappers call this after they observe that the
 * agent's output resembled the injected block (e.g. Jaccard ≥ τ on the
 * agent's patch vs. the block's unlock text, or explicit mention by id).
 */
export function emitAgentUsed(
  store: BlockStore,
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
  store.appendEvent(ev, { runId: args.runId });
  return ev;
}

/**
 * Emit an `outcome` event for a task run. `control=true` marks the
 * query as part of the shadow control group (no injection was shown).
 * `resolved` is the grader-verified pass/fail, not a self-report.
 */
export function emitOutcome(
  store: BlockStore,
  args: {
    queryId: string;
    resolved: boolean;
    control: boolean;
    regressed?: boolean;
    tokens?: number;
    steps?: number;
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
  };
  store.appendEvent(ev, { runId: args.runId });
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
}

export interface RetrievalSplit {
  total: number;
  shadow: number;
  treatment: number;
}

export interface OutcomeSplit {
  totalTreatment: number;
  totalShadow: number;
  resolvedTreatment: number;
  resolvedShadow: number;
  /** Raw token usage per outcome, if tokens were recorded. */
  tokensTreatment: number[];
  tokensShadow: number[];
}

export interface AggregateRates {
  /**
   * Fraction of non-shadow retrievals that produced at least one
   * injection. Measures how often the gate actually fires in the wild.
   */
  coverage: number;
  /** agent_used ÷ injection. null when no injections yet. */
  hitRate: number | null;
  /** helpful ÷ injection, per design definition. null when no injections. */
  helpfulRate: number | null;
  /** counterproductive ÷ injection. null when no injections. */
  counterproductiveRate: number | null;
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
  counterproductive: number;
  neutral: number;
}

export interface EventAggregates {
  counts: AggregateCounts;
  retrieval: RetrievalSplit;
  outcome: OutcomeSplit;
  rates: AggregateRates;
  perBlock: PerBlockStats[];
  /** The window used; undefined on either side means "open-ended". */
  window: { afterTs?: number; beforeTs?: number };
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

  const counts: AggregateCounts = { retrieval: 0, injection: 0, agentUsed: 0, outcome: 0 };

  // Indexes.
  const shadowByQuery = new Map<string, boolean>();
  const injectionsByQuery = new Map<string, Set<string>>();  // queryId → blockIds
  const agentUsedByQuery = new Map<string, Set<string>>();
  const outcomeByQuery = new Map<string, OutcomeEvent>();
  const retrievalTreatment = new Set<string>();  // queryIds with non-shadow retrieval
  const retrievalShadow = new Set<string>();

  for (const ev of events) {
    switch (ev.event) {
      case "retrieval": {
        counts.retrieval++;
        shadowByQuery.set(ev.queryId, ev.shadow);
        if (ev.shadow) retrievalShadow.add(ev.queryId);
        else retrievalTreatment.add(ev.queryId);
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
    }
  }

  // Per-block roll-up.
  const perBlockMap = new Map<string, PerBlockStats>();
  function bumpBlock(id: string, field: keyof Omit<PerBlockStats, "blockId">): void {
    let row = perBlockMap.get(id);
    if (!row) {
      row = { blockId: id, retrieved: 0, injected: 0, agentUsed: 0, helpful: 0, counterproductive: 0, neutral: 0 };
      perBlockMap.set(id, row);
    }
    row[field] = (row[field] as number) + 1;
  }

  // retrieved counts use the retrieval event's candidate list.
  for (const ev of events) {
    if (ev.event !== "retrieval") continue;
    for (const c of ev.candidates) bumpBlock(c.blockId, "retrieved");
  }

  // For each queryId that has both injection(s) and an outcome, classify.
  for (const [queryId, blockIds] of injectionsByQuery) {
    const used = agentUsedByQuery.get(queryId) ?? new Set<string>();
    const outcome = outcomeByQuery.get(queryId);
    for (const bId of blockIds) {
      bumpBlock(bId, "injected");
      if (used.has(bId)) bumpBlock(bId, "agentUsed");

      if (!outcome) continue; // no classification without an outcome
      if (used.has(bId)) {
        if (outcome.resolved) bumpBlock(bId, "helpful");
        else bumpBlock(bId, "counterproductive");
      } else {
        bumpBlock(bId, "neutral");
      }
    }
  }

  // Outcome split.
  const outcomeSplit: OutcomeSplit = {
    totalTreatment: 0,
    totalShadow: 0,
    resolvedTreatment: 0,
    resolvedShadow: 0,
    tokensTreatment: [],
    tokensShadow: [],
  };
  for (const outcome of outcomeByQuery.values()) {
    if (outcome.control) {
      outcomeSplit.totalShadow++;
      if (outcome.resolved) outcomeSplit.resolvedShadow++;
      if (typeof outcome.tokens === "number") outcomeSplit.tokensShadow.push(outcome.tokens);
    } else {
      outcomeSplit.totalTreatment++;
      if (outcome.resolved) outcomeSplit.resolvedTreatment++;
      if (typeof outcome.tokens === "number") outcomeSplit.tokensTreatment.push(outcome.tokens);
    }
  }

  // Rates.
  // Coverage: non-shadow queries that had at least one injection.
  const treatmentWithInjection = [...retrievalTreatment].filter((qid) =>
    (injectionsByQuery.get(qid)?.size ?? 0) > 0,
  ).length;
  const coverage = retrievalTreatment.size > 0
    ? treatmentWithInjection / retrievalTreatment.size
    : 0;

  // Sum helpful / counterproductive / agentUsed across per-block rows.
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

  const rates: AggregateRates = {
    coverage,
    hitRate: injectedTotal > 0 ? agentUsedTotal / injectedTotal : null,
    helpfulRate: injectedTotal > 0 ? helpfulTotal / injectedTotal : null,
    counterproductiveRate: injectedTotal > 0 ? counterTotal / injectedTotal : null,
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

  return {
    counts,
    retrieval: {
      total: retrievalTreatment.size + retrievalShadow.size,
      shadow: retrievalShadow.size,
      treatment: retrievalTreatment.size,
    },
    outcome: outcomeSplit,
    rates,
    perBlock: [...perBlockMap.values()].sort((a, b) => b.helpful - a.helpful),
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
export type { RetrievalEvent, InjectionEvent, AgentUsedEvent, OutcomeEvent, AnalyticsEvent };
