import type { ApplicabilityCanaryConfig, CascadeConfig, HoldoutConfig, TraceBaseConfig } from "../types.js";
import { ReasoningLayer } from "../core/engine.js";
import Database from "better-sqlite3";
import { BlockStore } from "../core/block-store.js";
import { BlockServer, formatInjection, resolveProductionGateThreshold } from "../core/block-serving.js";
import { EventEmitter, emitAgentUsed, emitFactAgentUsed, emitOutcome } from "../core/analytics.js";
import { loadBlockCalibrator } from "../lifecycle/calibrator.js";
import { maybeRefitCalibrator } from "../lifecycle/calibrator-refit.js";
import {
  buildRerankerFromCascadeConfig,
  extractCascadeKnobs,
} from "../experiments/cascade-rollout.js";
import { routerServingOptions } from "../experiments/reasoning-router-rollout.js";
import { reasoningRetrievalOptions } from "../experiments/reasoning-retrieval-rollout.js";
import { reasoningEvidenceOptions } from "../experiments/reasoning-evidence-rollout.js";
import { reasoningQueryCompilerOptions } from "../experiments/reasoning-query-compiler-rollout.js";
import { reasoningApplicabilityOptions } from "../experiments/reasoning-applicability-rollout.js";
import {
  computeCascadeComparison,
  type CascadeComparison,
} from "../lifecycle/cascade-compare.js";
import {
  collectInjectedFromQuery,
  CONTEXTUAL_RUNTIME_PROTOCOL,
  deletePattern,
  deleteProjectFact,
  lookupCascadeProvenance,
  resolveUsedItems,
  storeReasoningPattern,
  StorePatternValidationError,
  toMcpStructured,
  toReasoningPatternsStructured,
  type DeletionStructured,
  type OutcomeStructured,
  type StorePatternStructured,
} from "./mcp-v2-helpers.js";
import { findProjectRoot, readCascadeConfig, readHoldoutConfig, readApplicabilityCanaryConfig } from "../core/config.js";
import { runReasoningPatternsRecall } from "./reasoning-patterns-entry.js";
import { readBreakerSnapshot, noteCanaryActivityIfActive } from "../experiments/canary-breaker.js";

/**
 * Options bag for `startMcpServer`. Keeps the signature open for
 * future server-level knobs without breaking existing callers.
 */
export interface StartMcpServerOptions {
  /**
   * Project root used to resolve `.tracebase/config.json` for
   * runtime reads (e.g. the holdout experiment state). When
   * omitted, `startMcpServer` walks up from `process.cwd()` via
   * `findProjectRoot`. Callers that already know the project root
   * (the CLI `serve` command, tests) should pass it explicitly —
   * deriving it from `config.storagePath` is wrong because
   * `storagePath` can live outside the project root.
   */
  basePath?: string;
  /**
   * Boot the MCP server through its full initialization pipeline
   * (load SDK, open SQLite, construct BlockStore / BlockServer /
   * ReasoningLayer, register every tool) but skip binding the stdio
   * transport — instead print a single "READY\n" line to stdout and
   * resolve. This is how `tracebase doctor` verifies a live install
   * actually boots, catching a missing SDK, a corrupted memory.db,
   * or a tool-registration regression before Claude Code restarts
   * and shows "✗ Failed to connect".
   */
  selftest?: boolean;
}

/**
 * Start TraceBase as an MCP (Model Context Protocol) server.
 * Exposes recall, store, search, and feedback as MCP tools.
 *
 * This enables Claude Code and other MCP-compatible agents to
 * directly query and store reasoning traces.
 */
export async function startMcpServer(
  config: TraceBaseConfig,
  opts: StartMcpServerOptions = {},
): Promise<void> {
  // Dynamic import — kept dynamic so the CLI startup path doesn't
  // eagerly parse the SDK when the user just runs `tracebase status`.
  // `@modelcontextprotocol/sdk` is now a hard dependency (see
  // package.json); `npx -y tracebase-ai@latest serve --mcp` pulls it
  // in automatically.
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StdioServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/stdio.js"
  );
  const { z } = await import("zod");

  const layer = new ReasoningLayer(config);

  // v2 block-store + block-server over the same SQLite file. Separate
  // connection (BlockStore opens its own) — the two stores share the
  // file, not the handle, which is supported by better-sqlite3 under
  // WAL (the mode TraceStore sets). The block-server picks up a
  // calibrator if one has been fitted by Phase 5.2; otherwise the
  // identity fallback runs and gate=0 lets everything through.
  const blockDb = new Database(config.storagePath);
  const blockStore = new BlockStore(blockDb);

  // Phase 3.4.2 — project base for reading runtime experiment config
  // fresh on every `get_reasoning_patterns` call. Fresh reads mean
  // `tracebase experiment enable|disable` (holdout) and
  // `tracebase cascade enable|set-rate` (B1.2) take effect without
  // restarting the MCP server.
  //
  // IMPORTANT: project root is NOT derived from `config.storagePath`.
  // `storagePath` can legitimately point outside the project
  // directory (custom DB location), and reverse-engineering the
  // project root from it silently falls back to default-off when
  // the layout isn't canonical. Callers pass `basePath` explicitly;
  // otherwise we walk up from `process.cwd()` via
  // `findProjectRoot`, which is the same resolver every other CLI
  // command uses.
  const projectBasePath =
    opts.basePath ?? findProjectRoot(process.cwd()) ?? process.cwd();
  const holdoutConfigLoader: () => HoldoutConfig | null = () =>
    readHoldoutConfig(projectBasePath);
  const cascadeConfigLoader: () => CascadeConfig | null = () =>
    readCascadeConfig(projectBasePath);
  // Phase D.4 — fresh-per-call canary config loader (default off; explicit opt-in).
  const canaryConfigLoader: () => ApplicabilityCanaryConfig | null = () =>
    readApplicabilityCanaryConfig(projectBasePath);

  // B1.2: construct the reranker ONCE at boot from the cascade config.
  // This is the only thing in the cascade pipeline that's process-
  // lifetime — every other knob (rollout rate, MMR lambda, timeout) is
  // hot-reloaded on each call. Changing the reranker kind requires a
  // restart because BlockServer captures the reference at construction.
  // The fail-safe path returns NoopReranker on any malformed config so
  // a broken cascade.json can never wedge the MCP server.
  const bootCascadeConfig = cascadeConfigLoader();
  const reranker = buildRerankerFromCascadeConfig(bootCascadeConfig);
  const cascadeKnobs = extractCascadeKnobs(bootCascadeConfig);

  const blockServer = new BlockServer(blockStore, {
    calibrator: loadBlockCalibrator(blockStore),
    gateThreshold: resolveProductionGateThreshold(),
    reranker,
    ...cascadeKnobs,
    // Router V2 rollout (TRACEBASE_REASONING_ROUTER=off|shadow|on); default off.
    ...routerServingOptions(),
    // Phase C hybrid retrieval rollout (TRACEBASE_REASONING_RETRIEVAL=off|shadow|on); default off.
    ...reasoningRetrievalOptions(),
    // Phase C.2 ServingEvidenceV3 rollout (TRACEBASE_REASONING_EVIDENCE=off|shadow); default off.
    ...reasoningEvidenceOptions(),
    // Phase D.1 two-view query-compiler rollout (TRACEBASE_REASONING_QUERY_COMPILER=off|shadow); default off.
    ...reasoningQueryCompilerOptions(),
    // Phase D.2 applicability-reranker rollout (TRACEBASE_REASONING_APPLICABILITY=off|shadow); default off.
    ...reasoningApplicabilityOptions(),
  });
  const eventEmitter = new EventEmitter(blockStore);

  const server = new McpServer({
    name: "tracebase",
    version: "0.1.0",
  });

  // --- Tool: recall ---
  server.tool(
    "recall",
    "CALL THIS BEFORE starting any debugging, bug-fixing, or problem-solving task. " +
    "Searches institutional memory for previously solved similar problems. " +
    "If a match is found, you can reuse the solution instead of solving from scratch — " +
    "saving time and tokens. Returns traces ranked by multi-signal similarity.",
    {
      problem: z.string().describe("Description of the current problem"),
      language: z.string().optional().describe("Programming language"),
      framework: z.string().optional().describe("Framework (react, express, etc.)"),
      errorType: z.string().optional().describe("Error type (TypeError, ENOENT, etc.)"),
      limit: z.number().optional().default(5).describe("Max results"),
    },
    async (args) => {
      const results = layer.recall({
        problem: args.problem,
        limit: args.limit,
        context: {
          language: args.language,
          framework: args.framework,
          errorType: args.errorType,
        },
      });

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No matching traces found. This appears to be a new problem.",
            },
          ],
        };
      }

      const text = results
        .map((r, i) => {
          const t = r.trace;
          return [
            `## ${i + 1}. [${r.matchType}] score: ${r.score.toFixed(2)}`,
            `**Problem:** ${t.problem.description}`,
            `**Solution:** ${t.solution.summary}`,
            t.solution.explanation ? `**Explanation:** ${t.solution.explanation}` : "",
            t.solution.diff ? `**Diff:**\n\`\`\`\n${t.solution.diff}\n\`\`\`` : "",
            `*${[t.problem.language, t.problem.framework, t.problem.errorType].filter(Boolean).join(" · ")}*`,
            `ID: ${t.id}`,
          ]
            .filter(Boolean)
            .join("\n");
        })
        .join("\n\n---\n\n");

      return {
        content: [{ type: "text" as const, text }],
      };
    },
  );

  // --- Tool: store ---
  server.tool(
    "store",
    "CALL THIS AFTER solving any problem, fixing a bug, or completing a task. " +
    "Records the problem-solution pair in institutional memory so future agents " +
    "(including yourself in later sessions) can recall this solution instantly " +
    "instead of re-deriving it. Include the error type, language, and framework for best matching.",
    {
      problemDescription: z.string().describe("What was the problem?"),
      solutionSummary: z.string().describe("What fixed it?"),
      outcome: z
        .enum(["success", "failure", "partial"])
        .default("success")
        .describe("Did the solution work?"),
      language: z.string().optional().describe("Programming language"),
      framework: z.string().optional().describe("Framework"),
      errorType: z.string().optional().describe("Error type"),
      filePath: z.string().optional().describe("Related file path"),
      explanation: z.string().optional().describe("Detailed explanation"),
      diff: z.string().optional().describe("Code diff"),
      tags: z.array(z.string()).optional().describe("Tags for categorization"),
    },
    async (args) => {
      const trace = layer.storeTrace({
        problem: {
          description: args.problemDescription,
          errorType: args.errorType,
          filePath: args.filePath,
          language: args.language,
          framework: args.framework,
          tags: args.tags ?? [],
        },
        solution: {
          summary: args.solutionSummary,
          steps: [],
          outcome: args.outcome,
          explanation: args.explanation,
          diff: args.diff,
        },
        metadata: {
          agent: "mcp-client",
          source: "mcp",
        },
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Stored reasoning trace ${trace.id}\nFingerprint: ${trace.problem.fingerprint.slice(0, 16)}...`,
          },
        ],
      };
    },
  );

  // --- Tool: search ---
  server.tool(
    "search",
    "Full-text search through stored reasoning traces.",
    {
      query: z.string().describe("Search query"),
      limit: z.number().optional().default(10).describe("Max results"),
    },
    async (args) => {
      const results = layer.search(args.query, args.limit);

      if (results.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No results found." }],
        };
      }

      const text = results
        .map(
          (t, i) =>
            `${i + 1}. [${t.solution.outcome}] ${t.solution.summary}\n   ${t.problem.description.slice(0, 100)}`,
        )
        .join("\n\n");

      return {
        content: [{ type: "text" as const, text }],
      };
    },
  );

  // --- Tool: feedback ---
  server.tool(
    "feedback",
    "Report whether a recalled trace was helpful. Improves future recall quality.",
    {
      traceId: z.string().describe("ID of the trace"),
      helpful: z.boolean().describe("Was the recalled solution helpful?"),
    },
    async (args) => {
      layer.feedback(args.traceId, args.helpful);
      return {
        content: [
          {
            type: "text" as const,
            text: `Feedback recorded for ${args.traceId}: ${args.helpful ? "helpful" : "not helpful"}`,
          },
        ],
      };
    },
  );

  // --- Tool: explain ---
  server.tool(
    "explain",
    "Show why recall ranked results the way it did — full signal breakdown with adaptive weights.",
    {
      problem: z.string().describe("Problem to explain ranking for"),
      limit: z.number().optional().default(3).describe("Max results to explain"),
    },
    async (args) => {
      const results = layer.recall({
        problem: args.problem,
        limit: args.limit,
        minScore: 0.01,
      });
      const weights = layer.getWeights();

      if (results.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No matching traces found." }],
        };
      }

      const lines: string[] = [
        `**Adaptive Weights:** BM25=${weights.bm25.toFixed(3)} Jaccard=${weights.jaccard.toFixed(3)} Structural=${weights.structural.toFixed(3)} Cosine=${weights.cosine.toFixed(3)} Freshness=${weights.freshness.toFixed(3)}`,
        "",
      ];

      for (const [i, r] of results.entries()) {
        const s = r.signals;
        lines.push(
          `## ${i + 1}. Score: ${r.score.toFixed(4)} (${r.matchType})`,
          `**Problem:** ${r.trace.problem.description.slice(0, 120)}`,
          `**Solution:** ${r.trace.solution.summary.slice(0, 120)}`,
          `**Signals:**`,
          `  BM25: ${s.bm25.toFixed(3)} × ${weights.bm25.toFixed(3)} = ${(s.bm25 * weights.bm25).toFixed(3)}`,
          `  Jaccard: ${s.jaccard.toFixed(3)} × ${weights.jaccard.toFixed(3)} = ${(s.jaccard * weights.jaccard).toFixed(3)}`,
          `  Structural: ${s.structural.toFixed(3)} × ${weights.structural.toFixed(3)} = ${(s.structural * weights.structural).toFixed(3)}`,
          `  Cosine: ${s.cosine.toFixed(3)} × ${weights.cosine.toFixed(3)} = ${(s.cosine * weights.cosine).toFixed(3)}`,
          `  Freshness: ${s.freshness.toFixed(3)} × ${weights.freshness.toFixed(3)} = ${(s.freshness * weights.freshness).toFixed(3)}`,
          `**Quality:** ${r.trace.quality.helpfulCount}/${r.trace.quality.recallCount} helpful (score: ${r.trace.quality.score.toFixed(2)})`,
          r.trace.provenance?.author ? `**Provenance:** ${r.trace.provenance.origin}, by ${r.trace.provenance.author}` : "",
          `ID: ${r.trace.id}`,
          "---",
        );
      }

      return {
        content: [{ type: "text" as const, text: lines.filter(Boolean).join("\n") }],
      };
    },
  );

  // --- Tool: stats ---
  server.tool(
    "stats",
    "Get storage statistics for the reasoning memory.",
    {},
    async () => {
      const s = layer.stats();
      const cascade = cascadeConfigLoader();
      const cascadeComparison = computeCascadeComparison(blockStore, {
        afterTs: Date.now() - 7 * 86_400_000,
      });
      const text = [
        `Total traces: ${s.totalTraces}`,
        `Successful: ${s.successfulTraces} | Failed: ${s.failedTraces} | Partial: ${s.partialTraces}`,
        `Avg quality: ${s.avgQualityScore.toFixed(3)}`,
        `Recalls: ${s.totalRecalls} (${s.totalHelpful} helpful)`,
        renderCascadeStats(cascade, cascadeComparison),
        s.topLanguages.length > 0
          ? `Languages: ${s.topLanguages.map((l) => `${l.language}(${l.count})`).join(", ")}`
          : "",
        s.topFrameworks.length > 0
          ? `Frameworks: ${s.topFrameworks.map((f) => `${f.framework}(${f.count})`).join(", ")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n");

      return { content: [{ type: "text" as const, text }] };
    },
  );

  // --- Tool: get_reasoning_patterns (v2) ---
  //
  // 0.7.1 Contextual Runtime — registered via `registerTool` so the
  // response carries a typed `structuredContent` payload alongside
  // the human-readable text. Provider integrations parse
  // `structuredContent.protocol === "tracebase.contextual_runtime.v1"`
  // and the fields below; the markdown-shaped `text` is for human
  // visualisation in Claude Desktop / Cursor and is NOT the
  // integration surface.
  //
  // Description framing: this tool is now a *fallback*. In hosts that
  // support pre-prompt hooks (Claude Code), `tracebase inject-context`
  // already attaches a `<tracebase queryId="…">` block to the agent's
  // context before the model runs — there's no need to make the
  // agent call this tool too. The description steers the agent to
  // use the silent block when present and call this tool only when
  // the host has no hook surface or when the agent decides mid-thread
  // that it wants more patterns.
  server.registerTool(
    "get_reasoning_patterns",
    {
      description:
        "Fetch prior reasoning patterns relevant to a problem. In hosts that support " +
        "pre-prompt injection (Claude Code), the patterns are normally injected silently " +
        "into your context as a `<tracebase queryId='…'>…</tracebase>` block — check there first. " +
        "Use this tool only when no such block was injected (Cursor today; Claude Code if the hook " +
        "isn't installed) or when you decide mid-thread that you need more patterns. " +
        "Returns hypotheses to verify against the current task, plus a queryId for record_reasoning_outcome.",
      inputSchema: {
        problem: z.string().describe("Description of the current problem, bug, or task"),
        language: z.string().optional().describe("Programming language"),
        framework: z.string().optional().describe("Framework (react, django, astropy, etc.)"),
        errorType: z.string().optional().describe("Error type (TypeError, NullPointerException, etc.)"),
        apiSurface: z
          .array(z.string())
          .optional()
          .describe("Public APIs implicated (e.g. ['inspect.isfunction'])"),
        scope: z.string().optional().describe("Fact scope, e.g. 'repo:myorg/app'"),
        runId: z.string().optional().describe("Correlation id for eval / benchmark runs"),
        shadow: z
          .boolean()
          .optional()
          .describe("True to treat this query as a shadow control (no injection fires)"),
        limit: z.number().optional().describe("Max blocks to return (default 5)"),
        factLimit: z.number().optional().describe("Max facts to return (default 5)"),
      },
      outputSchema: {
        protocol: z.literal(CONTEXTUAL_RUNTIME_PROTOCOL),
        queryId: z.string(),
        shouldInject: z.boolean(),
        shadow: z.boolean(),
        controlReason: z.enum(["holdout", "shadow"]).optional(),
        blocks: z.array(
          z.object({
            id: z.string(),
            situation: z.string(),
            calibratedProb: z.number(),
            evidenceRefs: z.array(
              z.object({ traceId: z.string(), role: z.string() }),
            ),
          }),
        ),
        facts: z.array(
          z.object({
            id: z.string(),
            statement: z.string(),
            confidence: z.number(),
          }),
        ),
        injected: z
          .object({
            blockIds: z.array(z.string()),
            factIds: z.array(z.string()),
            tokensEstimate: z.number(),
          })
          .optional(),
      },
    },
    async (args) => {
      // Delegate to the shared entry helper; see
      // `src/server/reasoning-patterns-entry.ts` for the wiring
      // contract (fingerprint → buildHoldoutInput → recall) and
      // for the unit-test suite that proves it.
      //
      // B1.2: the entry is now async because the cascade rollout
      // decision routes some queries through `recallAsync()`. The
      // sync path remains the default when cascade is disabled or
      // when the fingerprint lands outside the rollout cohort —
      // exactly the gating that keeps the new ranking machinery
      // measurable without exposing it to 100% of traffic.
      const result = await runReasoningPatternsRecall(blockServer, args, {
        readHoldoutConfig: holdoutConfigLoader,
        readCascadeConfig: cascadeConfigLoader,
        readCanaryConfig: canaryConfigLoader,
        // D.4.2 — circuit-breaker hot-path gate + post-exposure ingestion trigger.
        readBreakerSnapshot: () => readBreakerSnapshot(projectBasePath),
        noteCanaryActivity: () => noteCanaryActivityIfActive(projectBasePath, blockStore),
      });

      const formatted = formatInjection(result, {
        format: "markdown",
        includeAudit: true,
        includeFacts: true,
      });

      const header =
        `queryId: ${result.queryId}\n` +
        (result.shadow
          ? "shadow: true (control run — no patterns surfaced)"
          : result.shouldInject
            ? `patterns: ${result.blocks.filter((h) => h.passesGate).length} block(s), ${result.facts.filter((h) => h.passesGate).length} fact(s)`
            : "no high-confidence patterns cleared the gate");

      // Brief, non-narrating guidance. The agent already saw the
      // hypothesis framing in the body; it doesn't need a sermon.
      const guidance = result.shouldInject
        ? "Use the patterns below as background hypotheses to verify against the current task. When you finish, call record_reasoning_outcome with this queryId."
        : "No patterns applied. When you finish, call record_reasoning_outcome with this queryId so future retrievals stay calibrated.";

      const body =
        formatted && formatted.trim().length > 0
          ? formatted
          : "_no applicable patterns cleared the gate for this query_";

      return {
        content: [
          {
            type: "text" as const,
            text: `${header}\n\n${guidance}\n\n${body}`,
          },
        ],
        structuredContent: toMcpStructured(toReasoningPatternsStructured(result)),
      };
    },
  );

  // --- Tool: record_reasoning_outcome (v2) ---
  //
  // 0.7.1 Contextual Runtime — `durationMs` is wired through to
  // `OutcomeEvent.durationMs` so `computeUsageMetrics` can derive
  // the causal latency lift (time-to-resolution between holdout
  // and assisted cohorts).
  // The MCP tool surface is the source of truth for the agent's
  // self-reported wall-clock; provider-side harnesses MAY override
  // by computing duration themselves and passing it through.
  server.registerTool(
    "record_reasoning_outcome",
    {
      description:
        "CALL THIS WHEN YOU FINISH a task (solved, gave up, or regressed). " +
        "Takes the queryId from a prior get_reasoning_patterns call. Emits agent_used events for " +
        "the specific patterns you actually used and an outcome event for the task. " +
        "This closes the self-correction loop — future calibrations get real outcomes.",
      inputSchema: {
        queryId: z.string().describe("queryId returned by get_reasoning_patterns"),
        resolved: z.boolean().describe("Did the task resolve (tests pass, bug fixed, etc.)?"),
        usedPattern: z
          .boolean()
          .optional()
          .describe("Shorthand: true = credit every injected pattern; omit/false = none"),
        usedBlocks: z
          .array(z.string())
          .optional()
          .describe("Specific block IDs you used (overrides usedPattern)"),
        usedFacts: z
          .array(z.string())
          .optional()
          .describe("Specific fact IDs you used (overrides usedPattern)"),
        tokens: z.number().optional().describe("Tokens spent on the task"),
        steps: z.number().optional().describe("Steps/actions the agent took"),
        durationMs: z
          .number()
          .optional()
          .describe(
            "Wall-clock time the task took, in milliseconds. " +
              "Powers the causal time-to-resolution metric in computeUsageMetrics.",
          ),
        regressed: z
          .boolean()
          .optional()
          .describe("True if the injected pattern appears to have caused a regression"),
        runId: z.string().optional().describe("Same runId as on the retrieval, if any"),
      },
      outputSchema: {
        protocol: z.literal(CONTEXTUAL_RUNTIME_PROTOCOL),
        outcome: z.object({
          queryId: z.string(),
          resolved: z.boolean(),
          usedBlockIds: z.array(z.string()),
          usedFactIds: z.array(z.string()),
          durationMs: z.number().optional(),
          // May-2026 B1.6 — cascade provenance so the agent can
          // observe whether the retrieval that produced its slate
          // was reranker-assisted, and whether the reranker fell
          // back. Absent when the queryId can't be located in the
          // event log.
          cascade: z
            .object({
              viaCascade: z.boolean(),
              policyId: z.string().optional(),
              rerankerName: z.string().optional(),
              fellBack: z.boolean().optional(),
              fallbackReason: z.enum(["timeout", "error", "null", "empty", "validation"]).optional(),
            })
            .optional(),
        }),
      },
    },
    async (args) => {
      const injected = collectInjectedFromQuery(blockStore, args.queryId);
      const cascade = lookupCascadeProvenance(blockStore, args.queryId);
      const resolved = resolveUsedItems(injected, {
        ...(args.usedPattern !== undefined ? { usedPattern: args.usedPattern } : {}),
        ...(args.usedBlocks !== undefined ? { usedBlocks: args.usedBlocks } : {}),
        ...(args.usedFacts !== undefined ? { usedFacts: args.usedFacts } : {}),
      });

      for (const blockId of resolved.usedBlockIds) {
        emitAgentUsed(eventEmitter, {
          queryId: args.queryId,
          blockId,
          matchSignal: "explicit",
          matchScore: 1.0,
          // C2.1 — first-party attestation is the canonical strong
          // evidence path. Both fields stamped so aggregators don't
          // have to fall through the matchSignal back-compat ladder.
          evidenceStrength: "explicit",
          evidenceKind: "record_reasoning_outcome",
          ...(args.runId ? { runId: args.runId } : {}),
        });
      }
      for (const factId of resolved.usedFactIds) {
        emitFactAgentUsed(eventEmitter, {
          queryId: args.queryId,
          factId,
          matchSignal: "explicit",
          matchScore: 1.0,
          ...(args.runId ? { runId: args.runId } : {}),
        });
      }

      emitOutcome(eventEmitter, {
        queryId: args.queryId,
        resolved: args.resolved,
        control: false,
        ...(args.regressed !== undefined ? { regressed: args.regressed } : {}),
        ...(args.tokens !== undefined ? { tokens: args.tokens } : {}),
        ...(args.steps !== undefined ? { steps: args.steps } : {}),
        ...(args.durationMs !== undefined ? { durationMs: args.durationMs } : {}),
        ...(args.runId ? { runId: args.runId } : {}),
      });
      // D.4.2 — outcome-side breaker ingestion (gated to canary-active; no-op when off).
      noteCanaryActivityIfActive(projectBasePath, blockStore);

      // Every-run-learning loop: outcome just landed → maybe refit the
      // calibrator. The function is internally cheap (one COUNT(*) when
      // below threshold, a full PAVA fit when above) and swallows all
      // exceptions, so the outcome-recording surface stays load-bearing
      // even if the calibrator pipeline trips.
      maybeRefitCalibrator({ store: blockStore, server: blockServer });

      // When the task resolved but no prior pattern was credited, the
      // agent has just learned something that isn't in memory yet.
      // Without an explicit capture call the next run will re-derive
      // it from scratch. We surface that fact in the response so the
      // agent doesn't walk away thinking the loop closed itself.
      const novelResolvedCase =
        args.resolved === true &&
        resolved.usedBlockIds.length === 0 &&
        resolved.usedFactIds.length === 0;
      const captureHint = novelResolvedCase
        ? "\n\nThis looks like a novel resolved case. If the fix is reusable, call " +
          "store_reasoning_pattern with the situation, mechanism, unlock, and verification " +
          "so future get_reasoning_patterns calls can surface it as a hypothesis. " +
          "Without this, the next agent will re-derive the same solution from scratch."
        : "";

      // Cascade provenance line in the agent-facing text. The agent
      // reading this learns: "my recall was reranker-assisted vs not",
      // and on fellBack=true, "the reranker collapsed to BM25 — the
      // patterns I saw came from lexical scoring, not the cross-encoder".
      // This is the difference between trusting a hit and second-guessing.
      let cascadeLine = "";
      if (cascade) {
        if (!cascade.viaCascade) {
          cascadeLine = "\n  cascade:     sync recall (cascade rollout not active for this query)";
        } else if (cascade.fellBack) {
          const reason = cascade.fallbackReason ? ` (${cascade.fallbackReason})` : "";
          cascadeLine = `\n  cascade:     fell back to BM25 ordering${reason} — reranker did not influence this slate`;
        } else {
          cascadeLine = `\n  cascade:     reranker-assisted via ${cascade.rerankerName ?? "unknown"}`;
        }
      }

      const summary =
        `Recorded outcome for ${args.queryId}:\n` +
        `  resolved=${args.resolved}\n` +
        `  used blocks: ${resolved.usedBlockIds.length}/${injected.blockIds.length}\n` +
        `  used facts:  ${resolved.usedFactIds.length}/${injected.factIds.length}` +
        (args.durationMs !== undefined ? `\n  durationMs:  ${args.durationMs}` : "") +
        cascadeLine +
        captureHint;

      const structured: OutcomeStructured = {
        protocol: CONTEXTUAL_RUNTIME_PROTOCOL,
        outcome: {
          queryId: args.queryId,
          resolved: args.resolved,
          usedBlockIds: resolved.usedBlockIds,
          usedFactIds: resolved.usedFactIds,
          ...(args.durationMs !== undefined ? { durationMs: args.durationMs } : {}),
          ...(cascade ? { cascade } : {}),
        },
      };

      return {
        content: [{ type: "text" as const, text: summary }],
        structuredContent: toMcpStructured(structured),
      };
    },
  );

  // --- Tool: store_reasoning_pattern (v2 capture) ---
  //
  // Closes the capture half of the loop. The legacy `store` tool
  // writes v1 ReasoningTrace rows; those do NOT feed
  // `get_reasoning_patterns`. This tool writes directly into the v2
  // reasoning_blocks table, so the next retrieval on a similar
  // problem can surface the block.
  //
  // Framing in the description is load-bearing: we tell the agent
  // WHY it matters (without this, no compounding), not just WHAT the
  // tool does. A vague description is the fastest way to get an
  // agent to skip the call entirely.
  server.registerTool(
    "store_reasoning_pattern",
    {
      description:
        "CALL THIS when you resolved a task from scratch — no prior pattern applied. " +
        "Writes a reusable reasoning pattern into the retrieval store so future " +
        "get_reasoning_patterns calls can surface it as a hypothesis. " +
        "Without this call, institutional memory does not grow: the next agent " +
        "facing the same problem will re-derive the solution from scratch. " +
        "Duplicate patterns (same trigger fingerprint) collapse into one block " +
        "with an additional supporting case ref.",
      inputSchema: {
        situation: z.string().describe(
          "When does this pattern apply? Short trigger statement — e.g. " +
          "'Pytest collects the wrong package when sys.path has a shadowing module'",
        ),
        mechanism: z.string().describe("Why the fix works — the underlying cause"),
        unlock: z.string().describe("The concrete action or change that resolves it"),
        verification: z.string().describe(
          "How to verify the fix worked (tests, logs, manual check)",
        ),
        deadEnds: z.array(z.string()).optional().describe(
          "Approaches that don't work — warn future agents away from them",
        ),
        language: z.string().optional(),
        framework: z.string().optional(),
        errorType: z.string().optional(),
        apiSurface: z.array(z.string()).optional().describe(
          "Public APIs implicated (e.g. ['inspect.isfunction'])",
        ),
        queryId: z.string().optional().describe(
          "queryId from the get_reasoning_patterns call that triggered this " +
          "capture. Used to trace the block back to the query that produced it.",
        ),
      },
      outputSchema: {
        protocol: z.literal(CONTEXTUAL_RUNTIME_PROTOCOL),
        pattern: z.object({
          blockId: z.string(),
          isNew: z.boolean(),
          situation: z.string(),
        }),
      },
    },
    async (args) => {
      try {
        const result = storeReasoningPattern(blockStore, args);
        const tag = result.isNew
          ? "stored new reasoning pattern"
          : "reinforced existing pattern (fingerprint match)";
        const audit =
          `id: ${result.blockId}\n` +
          `  situation: ${result.situation}\n` +
          `  isNew: ${result.isNew}`;
        const structured: StorePatternStructured = {
          protocol: CONTEXTUAL_RUNTIME_PROTOCOL,
          pattern: {
            blockId: result.blockId,
            isNew: result.isNew,
            situation: result.situation,
          },
        };
        return {
          content: [
            {
              type: "text" as const,
              text: `${tag}\n${audit}\n\nFuture get_reasoning_patterns calls with a similar trigger will now return this as a hypothesis.`,
            },
          ],
          structuredContent: toMcpStructured(structured),
        };
      } catch (error) {
        if (error instanceof StorePatternValidationError) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `store_reasoning_pattern rejected: ${error.message}\n\n` +
                  "Each of situation / mechanism / unlock / verification must be a short, " +
                  "concrete sentence. A pattern with empty fields is noise, not memory.",
              },
            ],
            isError: true,
          };
        }
        throw error;
      }
    },
  );

  // --- Tool: delete_pattern (GDPR Art. 17 hard-delete) ---
  //
  // Hard-deletes a reasoning_blocks row by id and writes an
  // audit_deletes tombstone in a single transaction. The deleted
  // block's body is NEVER preserved in the audit row — only id,
  // timestamp, reason, and the calling tool surface as the
  // requesting_principal. CASCADE on block_case_refs sweeps
  // attached refs so erasure is total at the storage layer.
  server.registerTool(
    "delete_pattern",
    {
      description:
        "Hard-delete a stored reasoning pattern by id. Removes the block " +
        "from retrieval and writes an audit row to audit_deletes for " +
        "compliance trail (id, reason, timestamp, calling tool surface). " +
        "Block content is NEVER preserved in the audit row. Use when a " +
        "user requests erasure (GDPR Art. 17) or a captured pattern is " +
        "known wrong / stale and outcome calibration alone is too slow. " +
        "Returns { ok: true, deleted: boolean, id }; deleted=false when " +
        "the id did not exist (no audit row written, no error).",
      inputSchema: {
        id: z.string().describe(
          "Block id to delete. Returned by get_reasoning_patterns / " +
          "list_patterns / store_reasoning_pattern.",
        ),
        reason: z.string().min(4).max(500).describe(
          "Human-readable reason for deletion (4..500 chars). Stored " +
          "verbatim in audit_deletes.reason; do not include block " +
          "body content here — the audit log is meant to outlive the " +
          "block, but its content is not.",
        ),
      },
      outputSchema: {
        protocol: z.literal(CONTEXTUAL_RUNTIME_PROTOCOL),
        deletion: z.object({
          ok: z.literal(true),
          deleted: z.boolean(),
          id: z.string(),
          kind: z.literal("block"),
        }),
      },
    },
    async (args) => {
      try {
        const result = deletePattern(blockStore, {
          id: args.id,
          reason: args.reason,
          requestingPrincipal: "mcp:delete_pattern",
        });
        const tag = result.deleted
          ? `hard-deleted pattern ${result.id} and wrote audit row`
          : `no pattern with id ${result.id} found (no-op; no audit row written)`;
        const structured: DeletionStructured = {
          protocol: CONTEXTUAL_RUNTIME_PROTOCOL,
          deletion: {
            ok: true,
            deleted: result.deleted,
            id: result.id,
            kind: "block",
          },
        };
        return {
          content: [
            {
              type: "text" as const,
              text: `${tag}\nresult: ${JSON.stringify(result)}`,
            },
          ],
          structuredContent: toMcpStructured(structured),
        };
      } catch (error) {
        if (error instanceof StorePatternValidationError) {
          return {
            content: [
              { type: "text" as const, text: `delete_pattern rejected: ${error.message}` },
            ],
            isError: true,
          };
        }
        throw error;
      }
    },
  );

  // --- Tool: delete_project_fact (GDPR Art. 17 hard-delete, L4) ---
  //
  // Sibling of `delete_pattern` for the semantic-memory substrate.
  // Same input contract (id + reason), same idempotency semantics,
  // same structured output shape — the only differences are the
  // target row (project_facts → audit_fact_deletes) and the
  // `kind: "fact"` discriminator on the structured payload so a
  // calling provider can route the deletion event to the correct
  // ledger.
  //
  // Adding this tool now (even though the 0.7.1 pilot defaults
  // factLimit=0 and never serves facts) keeps the GDPR story
  // symmetric: erasure works on every memory surface TraceBase
  // exposes, not just the procedural one.
  server.registerTool(
    "delete_project_fact",
    {
      description:
        "Hard-delete a stored project fact (L4 semantic memory) by id. " +
        "Removes the fact from retrieval and writes an audit row to " +
        "audit_fact_deletes for compliance trail (id, reason, timestamp, " +
        "calling tool surface). Fact content is NEVER preserved in the " +
        "audit row. Use when a user requests erasure (GDPR Art. 17) or a " +
        "captured fact is known wrong / stale. Returns { ok: true, " +
        "deleted: boolean, id, kind: 'fact' }; deleted=false when the id " +
        "did not exist (no audit row written, no error).",
      inputSchema: {
        id: z.string().describe(
          "Fact id to delete. Returned by recall / list APIs that surface project facts.",
        ),
        reason: z.string().min(4).max(500).describe(
          "Human-readable reason for deletion (4..500 chars). Stored " +
          "verbatim in audit_fact_deletes.reason; do not include fact " +
          "body content here — the audit log is meant to outlive the " +
          "fact, but its content is not.",
        ),
      },
      outputSchema: {
        protocol: z.literal(CONTEXTUAL_RUNTIME_PROTOCOL),
        deletion: z.object({
          ok: z.literal(true),
          deleted: z.boolean(),
          id: z.string(),
          kind: z.literal("fact"),
        }),
      },
    },
    async (args) => {
      try {
        const result = deleteProjectFact(blockStore, {
          id: args.id,
          reason: args.reason,
          requestingPrincipal: "mcp:delete_project_fact",
        });
        const tag = result.deleted
          ? `hard-deleted fact ${result.id} and wrote audit row`
          : `no fact with id ${result.id} found (no-op; no audit row written)`;
        const structured: DeletionStructured = {
          protocol: CONTEXTUAL_RUNTIME_PROTOCOL,
          deletion: {
            ok: true,
            deleted: result.deleted,
            id: result.id,
            kind: "fact",
          },
        };
        return {
          content: [
            {
              type: "text" as const,
              text: `${tag}\nresult: ${JSON.stringify(result)}`,
            },
          ],
          structuredContent: toMcpStructured(structured),
        };
      } catch (error) {
        if (error instanceof StorePatternValidationError) {
          return {
            content: [
              { type: "text" as const, text: `delete_project_fact rejected: ${error.message}` },
            ],
            isError: true,
          };
        }
        throw error;
      }
    },
  );

  // --- Tool: list_patterns (v2, diagnostic) ---
  server.tool(
    "list_patterns",
    "Diagnostic: list recent active reasoning blocks in the store. " +
    "Useful when you want to see what patterns exist without running a query.",
    {
      limit: z.number().optional().describe("Max entries (default 10)"),
      status: z.enum(["active", "candidate", "demoted", "merged", "retired"]).optional(),
    },
    async (args) => {
      const blocks = blockStore.listBlocks({
        status: args.status ?? "active",
        limit: args.limit ?? 10,
        orderBy: "updated_at",
      });
      if (blocks.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No matching blocks." }],
        };
      }
      const lines = blocks.map((b, i) => {
        const inv = b.trigger.invariants;
        const tags = [inv.language, inv.framework, inv.errorType].filter(Boolean).join(" · ");
        return `${i + 1}. [${b.status}] ${b.trigger.situation}\n   ${tags ? `_${tags}_\n   ` : ""}id=${b.id}  helpful=${b.stats.timesHelpful}/${b.stats.timesInjected}  wilson=${b.quality.wilsonLowerBound.toFixed(3)}`;
      });
      return { content: [{ type: "text" as const, text: lines.join("\n\n") }] };
    },
  );

  // Graceful shutdown — use once() to avoid listener accumulation
  const cleanup = () => {
    layer.close();
    blockStore.close();
    process.exit(0);
  };
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);

  // Selftest: every tool is registered and every dependency (SDK,
  // SQLite, BlockStore, ReasoningLayer) initialized at this point.
  // The user-facing contract for `tracebase doctor` is: a clean
  // READY\n on stdout + exit 0 means "Claude Code will successfully
  // connect to this MCP server on next restart". Any failure above
  // this line surfaces as a doctor FAIL with the captured error.
  if (opts.selftest) {
    // Close the block-store connection proactively — the real boot
    // path hands it off to the transport, but selftest exits
    // immediately, and a dangling SQLite handle would look like a
    // leak in long-running test runners.
    blockStore.close();
    process.stdout.write("READY\n");
    return;
  }

  // Start stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function renderCascadeStats(
  cascade: CascadeConfig | null,
  comparison: CascadeComparison,
): string {
  if (!cascade && comparison.cascade.retrievals === 0) {
    return "Cascade: not configured";
  }
  const state = cascade?.enabled ? "on" : "off";
  const rate = cascade ? `${(cascade.rollout.rate * 100).toFixed(1)}%` : "unknown";
  const kind = cascade?.reranker.kind ?? "unknown";
  const lift =
    comparison.lift === null
      ? "lift collecting"
      : `lift ${comparison.lift >= 0 ? "+" : ""}${(comparison.lift * 100).toFixed(2)}pp`;
  return `Cascade: ${state} rate=${rate} kind=${kind} | 7d ${lift} ` +
    `(cascade ${comparison.cascade.helpfulRuns}/${comparison.cascade.totalRuns}, ` +
    `sync ${comparison.sync.helpfulRuns}/${comparison.sync.totalRuns})`;
}
