import type { TraceBaseConfig } from "../types.js";
import { ReasoningLayer } from "../core/engine.js";
import Database from "better-sqlite3";
import { BlockStore } from "../core/block-store.js";
import { BlockServer, formatInjection } from "../core/block-serving.js";
import { EventEmitter, emitAgentUsed, emitFactAgentUsed, emitOutcome } from "../core/analytics.js";
import { loadBlockCalibrator } from "../lifecycle/calibrator.js";
import { collectInjectedFromQuery, resolveUsedItems } from "./mcp-v2-helpers.js";

/**
 * Start TraceBase as an MCP (Model Context Protocol) server.
 * Exposes recall, store, search, and feedback as MCP tools.
 *
 * This enables Claude Code and other MCP-compatible agents to
 * directly query and store reasoning traces.
 */
export async function startMcpServer(config: TraceBaseConfig): Promise<void> {
  // Dynamic import — @modelcontextprotocol/sdk is an optional peer dependency
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
      const invariants: Record<string, unknown> = {};
      if (args.language) invariants.language = args.language;
      if (args.framework) invariants.framework = args.framework;
      if (args.errorType) invariants.errorType = args.errorType;
      if (args.apiSurface) invariants.apiSurface = args.apiSurface;

      const result = blockServer.recall({
        text: args.problem,
        invariants: invariants as Parameters<typeof blockServer.recall>[0]["invariants"],
        ...(args.scope ? { scope: args.scope } : {}),
        ...(args.runId ? { runId: args.runId } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        ...(args.factLimit !== undefined ? { factLimit: args.factLimit } : {}),
        shadow: args.shadow ?? false,
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

      const summary =
        `Recorded outcome for ${args.queryId}:\n` +
        `  resolved=${args.resolved}\n` +
        `  used blocks: ${resolved.usedBlockIds.length}/${injected.blockIds.length}\n` +
        `  used facts:  ${resolved.usedFactIds.length}/${injected.factIds.length}`;

      return {
        content: [{ type: "text" as const, text: summary }],
      };
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

  // Start stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
