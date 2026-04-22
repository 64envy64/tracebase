/**
 * `get_reasoning_patterns` MCP handler, extracted as a plain
 * function so the runtime wiring from Phase 3.4.1 — experiment
 * config → fingerprint → `buildHoldoutInput` → `BlockServer.recall`
 * — can be unit-tested without standing up the MCP SDK.
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
import type { HoldoutConfig, BlockInvariants } from "../types.js";
import { buildHoldoutInput } from "../experiments/serving.js";

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
export function runReasoningPatternsRecall(
  blockServer: BlockServer,
  args: ReasoningPatternsArgs,
  deps: ReasoningPatternsDeps,
): RecallV2Result {
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
  };
  return blockServer.recall(query);
}
