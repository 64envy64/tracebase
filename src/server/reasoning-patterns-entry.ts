/**
 * `get_reasoning_patterns` MCP handler, extracted as a plain
 * function so the runtime wiring from Phase 3.4.1 — experiment
 * config → fingerprint → `buildHoldoutInput` → `BlockServer.recall`
 * — can be unit-tested without standing up the MCP SDK.
 *
 * May-2026 B1.2 made this async: when the cascade rollout fires for
 * this query, the entry calls `BlockServer.recallAsync()` (full
 * cascade); otherwise the existing sync `recall()` path.
 *
 * The MCP server entry (`src/server/mcp.ts`) delegates here; no
 * extra serving math lives anywhere else.
 */
import { fingerprint } from "../core/fingerprint.js";
import type {
  BlockRecallQuery,
  BlockServer,
  RecallV2Result,
} from "../core/block-serving.js";
import type { HoldoutConfig, CascadeConfig, BlockInvariants } from "../types.js";
import { buildHoldoutInput } from "../experiments/serving.js";
import { shouldUseCascade } from "../experiments/cascade-rollout.js";

export interface ReasoningPatternsArgs {
  /** Free-text problem description. */
  problem: string;
  language?: string;
  framework?: string;
  errorType?: string;
  apiSurface?: string[];
  scope?: string;
  runId?: string;
  limit?: number;
  factLimit?: number;
  shadow?: boolean;
  /**
   * Per-call gate override. Threads through to `BlockRecallQuery.gateOverride`.
   * Set by the drift-trigger path in `recallForPrompt`; production traffic
   * leaves this undefined so the configured gate stands.
   */
  gateOverride?: number;
}

export interface ReasoningPatternsDeps {
  /**
   * Called on every invocation so `tracebase experiment
   * enable|disable` in a terminal takes effect without restarting
   * the MCP server. Returns `null` when no experiment is
   * configured or when the on-disk payload is malformed — both
   * cases resolve to default-off serving.
   */
  readHoldoutConfig: () => HoldoutConfig | null;
  /**
   * Called on every invocation so `tracebase cascade set-rate` /
   * `enable|disable` take effect without restart, matching the
   * holdout config lifecycle. Returns `null` when cascade is not
   * configured or the on-disk payload is malformed — both fall
   * through to the sync `recall()` path.
   *
   * Optional for back-compat: callers that don't supply this loader
   * keep the pre-B1.2 sync-only behaviour. The MCP server wires it
   * in once B1.2 ships; test fixtures can stub it.
   */
  readCascadeConfig?: () => CascadeConfig | null;
  /** Deterministic fingerprint factory. Overridable for tests. */
  fingerprintFactory?: (
    problem: string,
    ctx: { language?: string; framework?: string; errorType?: string },
  ) => string;
}

/**
 * Run `BlockServer.recall` with the full Phase 3.4.1 wiring:
 *   - deterministic fingerprint derived from the problem + shape
 *     invariants (same problem → same cohort);
 *   - holdout config read fresh through the injected loader;
 *   - `ExperimentInput` built via `buildHoldoutInput` — undefined
 *     whenever the preconditions fail, which collapses to the
 *     pre-Phase-3 default-off code path.
 *
 * BlockServer still never touches config globals; this function
 * owns the translation from persisted state to `ExperimentInput`.
 */
export async function runReasoningPatternsRecall(
  blockServer: BlockServer,
  args: ReasoningPatternsArgs,
  deps: ReasoningPatternsDeps,
): Promise<RecallV2Result> {
  const invariants: BlockInvariants = {};
  if (args.language) invariants.language = args.language;
  if (args.framework) invariants.framework = args.framework;
  if (args.errorType) invariants.errorType = args.errorType;
  if (args.apiSurface) invariants.apiSurface = args.apiSurface;

  const fpCtx = {
    ...(args.language ? { language: args.language } : {}),
    ...(args.framework ? { framework: args.framework } : {}),
    ...(args.errorType ? { errorType: args.errorType } : {}),
  };
  const fpFactory =
    deps.fingerprintFactory ?? ((problem, ctx) => fingerprint(problem, ctx).hash);
  const problemFingerprint = fpFactory(args.problem, fpCtx);

  const experiment = buildHoldoutInput(deps.readHoldoutConfig(), problemFingerprint);

  const query: BlockRecallQuery = {
    text: args.problem,
    invariants,
    ...(args.scope ? { scope: args.scope } : {}),
    ...(args.runId ? { runId: args.runId } : {}),
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
    ...(args.factLimit !== undefined ? { factLimit: args.factLimit } : {}),
    shadow: args.shadow ?? false,
    ...(experiment ? { experiment } : {}),
    ...(args.gateOverride !== undefined ? { gateOverride: args.gateOverride } : {}),
  };

  // B1.2 cascade rollout: deterministic per-query decision.
  //   • `readCascadeConfig` absent  → sync recall (pre-B1.2 behaviour).
  //   • config disabled / rate=0    → sync recall.
  //   • fingerprint lands in cohort → async recallAsync (cascade).
  // The decision is logged on the retrieval event via cascadePolicyId,
  // so analytics can A/B sync-vs-async helpful-rate without an extra
  // side-channel. Holdout (control) and cascade (treatment) are
  // orthogonal — a query can be in the cascade arm AND in the holdout
  // cohort simultaneously, in which case shadow semantics win and no
  // injection fires regardless of which recall variant ran.
  // Phase C hybrid retrieval rollout — orthogonal to the cascade decision.
  //   off    → serve the existing sparse path unchanged.
  //   on     → serve the fused hybrid slate (recallHybrid; fail-open to sparse).
  //   shadow → serve the existing sparse path unchanged, then compute the
  //            hybrid comparison side-by-side and emit local-only telemetry.
  const retrievalMode = blockServer.retrievalRollout;
  if (retrievalMode === "on") {
    return blockServer.recallHybrid(query);
  }

  const cascadeConfig = deps.readCascadeConfig ? deps.readCascadeConfig() : null;
  const served = shouldUseCascade(problemFingerprint, cascadeConfig)
    ? await blockServer.recallAsync(query)
    : blockServer.recall(query);
  if (retrievalMode === "shadow") {
    await blockServer.emitHybridComparison(query, served.queryId);
  }
  // Phase D.1 — two-view query-compiler comparison (orthogonal shadow lane).
  if (blockServer.queryCompilerRollout === "shadow") {
    const summary = await blockServer.emitQueryCompilerComparison(query, served.queryId);
    if (summary) served.shadowQueryCompiler = summary;
  }
  return served;
}
