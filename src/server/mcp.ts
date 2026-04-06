import type { TraceBaseConfig } from "../types.js";
import { ReasoningLayer } from "../core/engine.js";

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

  // Graceful shutdown — use once() to avoid listener accumulation
  const cleanup = () => { layer.close(); process.exit(0); };
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);

  // Start stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
