/**
 * 0.7.1 Contextual Runtime — provider boundary
 *
 * Defines the narrow interface an external integrator gates TraceBase
 * behind inside their host runtime. The contract has four entry points:
 *
 *   beforeTask     — recall hypotheses for the current problem
 *   recordOutcome  — close the self-correction loop with attribution
 *   capturePattern — write a reusable pattern back into memory
 *   erase          — GDPR Art. 17 hard-delete (block or fact)
 *
 * Every method input / output type is provider-agnostic: no
 * `BlockHit`, `RecallV2Result`, or other internal type leaks across
 * the boundary. The integrator can mock this interface end-to-end
 * without pulling in a single TraceBase internal, and can drop a
 * different memory backend (or remove the layer entirely) by
 * swapping `TracebaseRuntimeProvider` for another implementation.
 *
 * Design constraints:
 *   - Local-first. No network call inside any handler.
 *   - Zero coupling to any specific host SDK.
 *   - Returned shapes use the same `tracebase.contextual_runtime.v1`
 *     protocol envelope as the structured MCP outputs, so a single
 *     consumer parser handles both surfaces.
 *
 * The implementation reuses the production engines (`BlockServer`,
 * `EventEmitter`, capture/outcome helpers) — there is no second
 * serving stack inside this module. That keeps the eval valid:
 * lift is attributable to the existing retrieval + gating + outcome
 * ledger, not to a parallel codepath.
 */

import { BlockStore } from "../core/block-store.js";
import { BlockServer, resolveProductionGateThreshold } from "../core/block-serving.js";
import { routerServingOptions } from "../experiments/reasoning-router-rollout.js";
import {
  EventEmitter,
  emitAgentUsed,
  emitFactAgentUsed,
  emitOutcome,
} from "../core/analytics.js";
import { loadBlockCalibrator } from "../lifecycle/calibrator.js";
import { runReasoningPatternsRecall } from "../server/reasoning-patterns-entry.js";
import { findProjectRoot, readHoldoutConfig } from "../core/config.js";
import type { HoldoutConfig } from "../types.js";
import {
  collectInjectedFromQuery,
  CONTEXTUAL_RUNTIME_PROTOCOL,
  deletePattern,
  deleteProjectFact,
  resolveUsedItems,
  storeReasoningPattern,
  toReasoningPatternsStructured,
  type ReasoningPatternsStructured,
} from "../server/mcp-v2-helpers.js";

// ---------------------------------------------------------------------------
// Interface — what the integrator sees
// ---------------------------------------------------------------------------

/** Inputs to `beforeTask` — describe the current problem. */
export interface BeforeTaskInput {
  /** Free-text problem description (drives lexical recall). */
  problem: string;
  /** Optional language fingerprint hint (e.g. "typescript"). */
  language?: string;
  /** Optional framework hint (e.g. "react"). */
  framework?: string;
  /** Optional error type (e.g. "TypeError"). */
  errorType?: string;
  /** Public APIs implicated in the problem (e.g. ["fs.readFile"]). */
  apiSurface?: string[];
  /** Project / repo scope (e.g. "repo:org/app") — used by fact retrieval. */
  scope?: string;
  /** Caller-supplied correlation id for eval / benchmark runs. */
  runId?: string;
  /** True forces the query into a manual shadow control (no injection). */
  shadow?: boolean;
  /** Cap blocks returned (default 5). */
  limit?: number;
  /**
   * Cap facts returned. The 0.7.1 pilot defaults this to 0 (procedural
   * memory only). Set explicitly to enable fact serving.
   */
  factLimit?: number;
}

/**
 * Result of `beforeTask` — the structured-content payload from
 * `get_reasoning_patterns`, identical shape to the MCP surface so a
 * single parser handles both transports.
 */
export type BeforeTaskResult = ReasoningPatternsStructured;

/** Inputs to `recordOutcome` — close the loop after the task ran. */
export interface RecordOutcomeInput {
  /** queryId returned by a previous `beforeTask` call. */
  queryId: string;
  /** Did the task resolve (tests pass, bug fixed, etc.)? */
  resolved: boolean;
  /**
   * Wall-clock duration in ms. The pilot harness measures this from
   * `beforeTask` start to `recordOutcome` arrival; agents may also
   * self-report. Powers the causal time-to-resolution metric.
   */
  durationMs?: number;
  /** Steps the agent took. Optional. */
  steps?: number;
  /** Tokens spent on the task. Optional. */
  tokens?: number;
  /** True if injection appears to have caused a regression. */
  regressed?: boolean;
  /**
   * Shorthand: true credits every injected pattern; absent / false
   * credits nothing. Overridden by usedBlockIds / usedFactIds.
   */
  usedPattern?: boolean;
  /** Specific block ids the agent actually used. */
  usedBlockIds?: string[];
  /** Specific fact ids the agent actually used. */
  usedFactIds?: string[];
  /** Same runId as on the retrieval, if any. */
  runId?: string;
}

/** Result of `recordOutcome` — read-back of what was credited. */
export interface RecordOutcomeResult {
  protocol: typeof CONTEXTUAL_RUNTIME_PROTOCOL;
  outcome: {
    queryId: string;
    resolved: boolean;
    usedBlockIds: string[];
    usedFactIds: string[];
    durationMs?: number;
  };
}

/** Inputs to `capturePattern` — write a reusable pattern. */
export interface CapturePatternInput {
  /** Trigger statement — when does this pattern apply? */
  situation: string;
  /** Why the fix works — the underlying mechanism. */
  mechanism: string;
  /** The concrete change or action that resolves it. */
  unlock: string;
  /** How to verify the fix worked. */
  verification: string;
  /** Approaches that don't work. */
  deadEnds?: string[];
  language?: string;
  framework?: string;
  errorType?: string;
  apiSurface?: string[];
  /** Originating queryId, when this capture follows a recall. */
  queryId?: string;
}

/** Result of `capturePattern`. */
export interface CapturePatternResult {
  protocol: typeof CONTEXTUAL_RUNTIME_PROTOCOL;
  pattern: {
    blockId: string;
    /** True if a new block was inserted; false if collapsed onto existing. */
    isNew: boolean;
    situation: string;
  };
}

/** Inputs to `erase` — GDPR Art. 17 hard-delete. */
export interface EraseMemoryInput {
  /** Block id (kind="block") or fact id (kind="fact"). */
  id: string;
  /** Human-readable reason; stored in the audit ledger. */
  reason: string;
  /**
   * Which substrate to erase from. Procedural ("block") and semantic
   * ("fact") have separate ledgers (`audit_deletes` /
   * `audit_fact_deletes`); the discriminator selects the right one.
   */
  kind: "block" | "fact";
  /** Optional caller identity; defaults to "provider:erase". */
  requestingPrincipal?: string;
}

/** Result of `erase`. */
export interface EraseMemoryResult {
  protocol: typeof CONTEXTUAL_RUNTIME_PROTOCOL;
  deletion: {
    ok: true;
    /** False when the id did not exist (no audit row written, no error). */
    deleted: boolean;
    id: string;
    kind: "block" | "fact";
  };
}

/**
 * Contextual Runtime provider — the boundary the integrator gates
 * memory behind. All methods are async so a different backend (e.g.
 * a network-bound store) can implement the same contract without
 * changing call sites.
 *
 * `close` is optional; in-process backends should implement it to
 * release SQLite handles cleanly when the host shuts down.
 */
export interface ContextualRuntimeProvider {
  beforeTask(input: BeforeTaskInput): Promise<BeforeTaskResult>;
  recordOutcome(input: RecordOutcomeInput): Promise<RecordOutcomeResult>;
  capturePattern(input: CapturePatternInput): Promise<CapturePatternResult>;
  erase(input: EraseMemoryInput): Promise<EraseMemoryResult>;
  close?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Implementation — TraceBase-backed
// ---------------------------------------------------------------------------

/** Construction options for the in-process TraceBase provider. */
export interface CreateTracebaseRuntimeProviderOptions {
  /**
   * Path to the SQLite file backing the contextual store. The
   * provider opens its own handle (single-writer through WAL) and
   * closes it on `close()`.
   */
  storagePath: string;
  /**
   * Optional project root. When omitted, walks up from
   * `process.cwd()` via `findProjectRoot`. Used to read the
   * holdout-experiment config fresh on every `beforeTask` call so
   * `tracebase experiment enable|disable` takes effect without a
   * provider restart.
   */
  basePath?: string;
  /**
   * Override the holdout config loader. Tests use this to inject a
   * deterministic experiment without writing a config file.
   */
  readHoldoutConfig?: () => HoldoutConfig | null;
}

/**
 * In-process TraceBase implementation of `ContextualRuntimeProvider`.
 *
 * Wraps the existing `BlockServer` / `EventEmitter` /
 * capture-helpers stack — no parallel serving path. The pilot
 * measurement validity follows from this: lift observed against the
 * provider boundary IS lift attributable to the production engines.
 */
export class TracebaseRuntimeProvider implements ContextualRuntimeProvider {
  private readonly blockStore: BlockStore;
  private readonly blockServer: BlockServer;
  private readonly eventEmitter: EventEmitter;
  private readonly readHoldoutConfig: () => HoldoutConfig | null;
  private closed = false;

  constructor(opts: CreateTracebaseRuntimeProviderOptions) {
    this.blockStore = new BlockStore(opts.storagePath);
    this.blockServer = new BlockServer(this.blockStore, {
      calibrator: loadBlockCalibrator(this.blockStore),
      gateThreshold: resolveProductionGateThreshold(),
      // Router V2 rollout (TRACEBASE_REASONING_ROUTER=off|shadow|on); default off.
      ...routerServingOptions(),
    });
    this.eventEmitter = new EventEmitter(this.blockStore);
    if (opts.readHoldoutConfig) {
      this.readHoldoutConfig = opts.readHoldoutConfig;
    } else {
      const projectBase =
        opts.basePath ?? findProjectRoot(process.cwd()) ?? process.cwd();
      this.readHoldoutConfig = () => readHoldoutConfig(projectBase);
    }
  }

  async beforeTask(input: BeforeTaskInput): Promise<BeforeTaskResult> {
    // B1.2: runReasoningPatternsRecall is async. The Provider does
    // not wire in a cascade-config loader, so this stays on the sync
    // recall() path internally — the await resolves on the same tick.
    const result = await runReasoningPatternsRecall(this.blockServer, input, {
      readHoldoutConfig: this.readHoldoutConfig,
    });
    return toReasoningPatternsStructured(result);
  }

  async recordOutcome(
    input: RecordOutcomeInput,
  ): Promise<RecordOutcomeResult> {
    const injected = collectInjectedFromQuery(this.blockStore, input.queryId);
    const resolved = resolveUsedItems(injected, {
      ...(input.usedPattern !== undefined ? { usedPattern: input.usedPattern } : {}),
      ...(input.usedBlockIds !== undefined ? { usedBlocks: input.usedBlockIds } : {}),
      ...(input.usedFactIds !== undefined ? { usedFacts: input.usedFactIds } : {}),
    });

    for (const blockId of resolved.usedBlockIds) {
      emitAgentUsed(this.eventEmitter, {
        queryId: input.queryId,
        blockId,
        matchSignal: "explicit",
        matchScore: 1.0,
        // C2.1 — SDK runtime equivalent of MCP record_reasoning_outcome.
        // First-party attestation, same evidence ladder.
        evidenceStrength: "explicit",
        evidenceKind: "record_reasoning_outcome",
        ...(input.runId ? { runId: input.runId } : {}),
      });
    }
    for (const factId of resolved.usedFactIds) {
      emitFactAgentUsed(this.eventEmitter, {
        queryId: input.queryId,
        factId,
        matchSignal: "explicit",
        matchScore: 1.0,
        ...(input.runId ? { runId: input.runId } : {}),
      });
    }

    emitOutcome(this.eventEmitter, {
      queryId: input.queryId,
      resolved: input.resolved,
      control: false,
      ...(input.regressed !== undefined ? { regressed: input.regressed } : {}),
      ...(input.tokens !== undefined ? { tokens: input.tokens } : {}),
      ...(input.steps !== undefined ? { steps: input.steps } : {}),
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
    });

    return {
      protocol: CONTEXTUAL_RUNTIME_PROTOCOL,
      outcome: {
        queryId: input.queryId,
        resolved: input.resolved,
        usedBlockIds: resolved.usedBlockIds,
        usedFactIds: resolved.usedFactIds,
        ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      },
    };
  }

  async capturePattern(
    input: CapturePatternInput,
  ): Promise<CapturePatternResult> {
    const result = storeReasoningPattern(this.blockStore, input);
    return {
      protocol: CONTEXTUAL_RUNTIME_PROTOCOL,
      pattern: {
        blockId: result.blockId,
        isNew: result.isNew,
        situation: result.situation,
      },
    };
  }

  async erase(input: EraseMemoryInput): Promise<EraseMemoryResult> {
    if (input.kind === "block") {
      const result = deletePattern(this.blockStore, {
        id: input.id,
        reason: input.reason,
        requestingPrincipal: input.requestingPrincipal ?? "provider:erase",
      });
      return {
        protocol: CONTEXTUAL_RUNTIME_PROTOCOL,
        deletion: {
          ok: true,
          deleted: result.deleted,
          id: result.id,
          kind: "block",
        },
      };
    }
    const result = deleteProjectFact(this.blockStore, {
      id: input.id,
      reason: input.reason,
      requestingPrincipal: input.requestingPrincipal ?? "provider:erase",
    });
    return {
      protocol: CONTEXTUAL_RUNTIME_PROTOCOL,
      deletion: {
        ok: true,
        deleted: result.deleted,
        id: result.id,
        kind: "fact",
      },
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.blockStore.close();
  }

  /**
   * Escape hatch for tests and the pilot harness — exposes the
   * underlying BlockStore so seed data can be loaded without going
   * through `capturePattern` (which runs the capture gate). Not
   * intended for production callers; the public surface is the four
   * `ContextualRuntimeProvider` methods above.
   */
  _internalBlockStore(): BlockStore {
    return this.blockStore;
  }
}

/**
 * Convenience factory. Most callers want `new TracebaseRuntimeProvider`
 * — this exists as the symmetrical pair to `createRuntime` from
 * `src/sdk/runtime.ts` so existing patterns transfer.
 */
export function createTracebaseRuntimeProvider(
  opts: CreateTracebaseRuntimeProviderOptions,
): TracebaseRuntimeProvider {
  return new TracebaseRuntimeProvider(opts);
}
