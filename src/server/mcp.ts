import type { HoldoutConfig, TraceBaseConfig } from "../types.js";
import { ReasoningLayer } from "../core/engine.js";
import Database from "better-sqlite3";
import { BlockStore } from "../core/block-store.js";
import { BlockServer, formatInjection } from "../core/block-serving.js";
import { EventEmitter, emitAgentUsed, emitFactAgentUsed, emitOutcome } from "../core/analytics.js";
import { loadBlockCalibrator } from "../lifecycle/calibrator.js";
import {
  collectInjectedFromQuery,
  resolveUsedItems,
  storeReasoningPattern,
  StorePatternValidationError,
} from "./mcp-v2-helpers.js";
import { findProjectRoot, readHoldoutConfig } from "../core/config.js";
import { runReasoningPatternsRecall } from "./reasoning-patterns-entry.js";

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
  const blockServer = new BlockServer(blockStore, {
    calibrator: loadBlockCalibrator(blockStore),
    gateThreshold: 0, // can be tuned via config later
  });
  const eventEmitter = new EventEmitter(blockStore);

  // Phase 3.4.2 — project base for reading the holdout experiment
  // config fresh on every `get_reasoning_patterns` call. Fresh
  // reads mean `tracebase experiment enable|disable` in a terminal
  // takes effect without restarting the MCP server.
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
      const text = [
        `Total traces: ${s.totalTraces}`,
        `Successful: ${s.successfulTraces} | Failed: ${s.failedTraces} | Partial: ${s.partialTraces}`,
        `Avg quality: ${s.avgQualityScore.toFixed(3)}`,
        `Recalls: ${s.totalRecalls} (${s.totalHelpful} helpful)`,
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
  server.tool(
    "get_reasoning_patterns",
    "CALL THIS FIRST before starting any debugging, bug-fixing, or problem-solving task. " +
    "Returns prior reasoning patterns that may apply — as HYPOTHESES to verify, not commands to follow. " +
    "Records a retrieval event and, for every pattern clearing the gate, an injection event. " +
    "Always respond with the queryId from the reply when you later call record_reasoning_outcome.",
    {
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
    async (args) => {
      // Delegate to the shared entry helper; see
      // `src/server/reasoning-patterns-entry.ts` for the wiring
      // contract (fingerprint → buildHoldoutInput → recall) and
      // for the unit-test suite that proves it.
      const result = runReasoningPatternsRecall(blockServer, args, {
        readHoldoutConfig: holdoutConfigLoader,
      });

      const formatted = formatInjection(result, {
        format: "markdown",
        includeAudit: true,
        includeFacts: true,
      });

      const header =
        `queryId: ${result.queryId}\n` +
        (result.shadow
          ? "shadow: true (this run is a control — no injection fired)"
          : result.shouldInject
            ? `patterns: ${result.blocks.filter((h) => h.passesGate).length} block(s), ${result.facts.filter((h) => h.passesGate).length} fact(s)`
            : "no high-confidence patterns cleared the gate");

      const guidance =
        result.shouldInject
          ? "These are HYPOTHESES drawn from prior cases — verify the mechanism against the current task before acting. When you finish, call record_reasoning_outcome with this queryId."
          : "No applicable patterns. Proceed normally. Still call record_reasoning_outcome with usedPattern=false so future retrievals can calibrate.";

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
      };
    },
  );

  // --- Tool: record_reasoning_outcome (v2) ---
  server.tool(
    "record_reasoning_outcome",
    "CALL THIS WHEN YOU FINISH a task (solved, gave up, or regressed). " +
    "Takes the queryId from a prior get_reasoning_patterns call. Emits agent_used events for " +
    "the specific patterns you actually used and an outcome event for the task. " +
    "This closes the self-correction loop — future calibrations get real outcomes.",
    {
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
      regressed: z
        .boolean()
        .optional()
        .describe("True if the injected pattern appears to have caused a regression"),
      runId: z.string().optional().describe("Same runId as on the retrieval, if any"),
    },
    async (args) => {
      const injected = collectInjectedFromQuery(blockStore, args.queryId);
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
        ...(args.runId ? { runId: args.runId } : {}),
      });

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

      const summary =
        `Recorded outcome for ${args.queryId}:\n` +
        `  resolved=${args.resolved}\n` +
        `  used blocks: ${resolved.usedBlockIds.length}/${injected.blockIds.length}\n` +
        `  used facts:  ${resolved.usedFactIds.length}/${injected.factIds.length}` +
        captureHint;

      return {
        content: [{ type: "text" as const, text: summary }],
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
  server.tool(
    "store_reasoning_pattern",
    "CALL THIS when you resolved a task from scratch — no prior pattern applied. " +
    "Writes a reusable reasoning pattern into the retrieval store so future " +
    "get_reasoning_patterns calls can surface it as a hypothesis. " +
    "Without this call, institutional memory does not grow: the next agent " +
    "facing the same problem will re-derive the solution from scratch. " +
    "Duplicate patterns (same trigger fingerprint) collapse into one block " +
    "with an additional supporting case ref.",
    {
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
        return {
          content: [
            {
              type: "text" as const,
              text: `${tag}\n${audit}\n\nFuture get_reasoning_patterns calls with a similar trigger will now return this as a hypothesis.`,
            },
          ],
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
