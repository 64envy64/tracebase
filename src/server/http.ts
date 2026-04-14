import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { TraceBaseConfig, RecallQuery, StoreTraceInput } from "../types.js";
import { ReasoningLayer } from "../core/engine.js";

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB

const VALID_OUTCOMES = new Set(["success", "failure", "partial"]);

/**
 * Minimal HTTP REST API server for TraceBase.
 * No external dependencies — uses Node.js built-in http module.
 *
 * Endpoints:
 *   POST /recall       — find relevant past solutions
 *   POST /store        — store a new trace
 *   GET  /search?q=... — full-text search
 *   POST /feedback     — provide feedback on a trace
 *   GET  /stats        — storage statistics
 *   GET  /traces       — list recent traces
 *   GET  /health       — health check
 */
export async function startHttpServer(
  config: TraceBaseConfig,
  host: string,
  port: number,
): Promise<{ server: Server; close: () => void }> {
  const layer = new ReasoningLayer(config);

  const server = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      const url = new URL(req.url!, `http://${host}:${port}`);
      const path = url.pathname;

      if (path === "/health" && req.method === "GET") {
        json(res, 200, { status: "ok", traces: layer.count() });
        return;
      }

      if (path === "/recall" && req.method === "POST") {
        const body = await readBody(req);
        const problem = requireString(body, "problem");
        const query: RecallQuery = {
          problem,
          limit: optionalInt(body, "limit", 5),
          minScore: optionalFloat(body, "minScore", 0.1),
          context: typeof body["context"] === "object" && body["context"] !== null
            ? body["context"] as RecallQuery["context"]
            : undefined,
        };
        json(res, 200, { results: layer.recall(query) });
        return;
      }

      if (path === "/store" && req.method === "POST") {
        const body = await readBody(req);
        const problemObj = requireObject(body, "problem");
        const solutionObj = requireObject(body, "solution");

        const description = requireString(problemObj, "description");
        const summary = requireString(solutionObj, "summary");
        const outcome = optionalString(solutionObj, "outcome", "success") ?? "success";

        if (!VALID_OUTCOMES.has(outcome)) {
          throw new ValidationError(
            `Invalid outcome "${outcome}". Must be "success", "failure", or "partial".`,
          );
        }

        const input: StoreTraceInput = {
          problem: {
            description,
            errorType: optionalString(problemObj, "errorType"),
            errorMessage: optionalString(problemObj, "errorMessage"),
            stackTrace: optionalString(problemObj, "stackTrace"),
            filePath: optionalString(problemObj, "filePath"),
            language: optionalString(problemObj, "language"),
            framework: optionalString(problemObj, "framework"),
            tags: Array.isArray(problemObj["tags"]) ? problemObj["tags"] as string[] : [],
          },
          solution: {
            summary,
            steps: Array.isArray(solutionObj["steps"]) ? solutionObj["steps"] as StoreTraceInput["solution"]["steps"] : [],
            outcome: outcome as "success" | "failure" | "partial",
            diff: optionalString(solutionObj, "diff"),
            explanation: optionalString(solutionObj, "explanation"),
          },
          metadata: typeof body["metadata"] === "object" && body["metadata"] !== null
            ? body["metadata"] as StoreTraceInput["metadata"]
            : undefined,
        };
        json(res, 201, { trace: layer.storeTrace(input) });
        return;
      }

      if (path === "/search" && req.method === "GET") {
        const q = url.searchParams.get("q") ?? "";
        const limit = parseInt(url.searchParams.get("limit") ?? "10", 10);
        json(res, 200, { results: layer.search(q, limit) });
        return;
      }

      if (path === "/feedback" && req.method === "POST") {
        const body = await readBody(req);
        const traceId = requireString(body, "traceId");
        const helpful = requireBoolean(body, "helpful");
        layer.feedback(traceId, helpful);
        json(res, 200, { ok: true });
        return;
      }

      if (path === "/stats" && req.method === "GET") {
        json(res, 200, layer.stats());
        return;
      }

      if (path === "/traces" && req.method === "GET") {
        const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
        const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
        json(res, 200, { traces: layer.listTraces(limit, offset), total: layer.count() });
        return;
      }

      // Signal explainability endpoint
      if (path === "/explain" && req.method === "POST") {
        const body = await readBody(req);
        const problem = requireString(body, "problem");
        const results = layer.recall({
          problem,
          limit: optionalInt(body, "limit", 3),
          minScore: 0.01,
          context: typeof body["context"] === "object" && body["context"] !== null
            ? body["context"] as RecallQuery["context"]
            : undefined,
        });

        const weights = layer.getWeights();

        json(res, 200, {
          query: problem,
          weights,
          results: results.map((r) => ({
            traceId: r.trace.id,
            score: r.score,
            matchType: r.matchType,
            signals: r.signals,
            contributions: {
              bm25: r.signals.bm25 * weights.bm25,
              jaccard: r.signals.jaccard * weights.jaccard,
              structural: r.signals.structural * weights.structural,
              cosine: r.signals.cosine * weights.cosine,
              freshness: r.signals.freshness * weights.freshness,
            },
            problem: r.trace.problem.description,
            solution: r.trace.solution.summary,
            quality: r.trace.quality,
            provenance: r.trace.provenance,
          })),
        });
        return;
      }

      json(res, 404, { error: "Not found" });
    } catch (e) {
      if (e instanceof ValidationError) {
        json(res, 400, { error: e.message });
      } else {
        const message = e instanceof Error ? e.message : "Internal server error";
        json(res, 500, { error: message });
      }
    }
  });

  // Graceful shutdown — use once() to avoid listener accumulation
  const cleanup = () => {
    layer.close();
    server.close();
  };
  process.once("SIGINT", () => { cleanup(); process.exit(0); });
  process.once("SIGTERM", () => { cleanup(); process.exit(0); });

  return new Promise((resolve) => {
    server.listen(port, host, () => resolve({ server, close: cleanup }));
  });
}

// ============================================================================
// Validation helpers
// ============================================================================

class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new ValidationError(`Request body exceeds ${MAX_BODY_BYTES} byte limit`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      if (!raw) {
        reject(new ValidationError("Request body is empty"));
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          reject(new ValidationError("Request body must be a JSON object"));
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new ValidationError("Invalid JSON in request body"));
      }
    });
    req.on("error", reject);
  });
}

function requireString(obj: Record<string, unknown>, field: string): string {
  const val = obj[field];
  if (typeof val !== "string" || val.length === 0) {
    throw new ValidationError(`Missing or empty required string field: "${field}"`);
  }
  return val;
}

function requireBoolean(obj: Record<string, unknown>, field: string): boolean {
  const val = obj[field];
  if (typeof val !== "boolean") {
    throw new ValidationError(`Missing or invalid boolean field: "${field}"`);
  }
  return val;
}

function requireObject(obj: Record<string, unknown>, field: string): Record<string, unknown> {
  const val = obj[field];
  if (typeof val !== "object" || val === null || Array.isArray(val)) {
    throw new ValidationError(`Missing or invalid object field: "${field}"`);
  }
  return val as Record<string, unknown>;
}

function optionalString(obj: Record<string, unknown>, field: string, defaultVal?: string): string | undefined {
  const val = obj[field];
  if (val === undefined || val === null) return defaultVal;
  if (typeof val !== "string") return defaultVal;
  return val;
}

function optionalInt(obj: Record<string, unknown>, field: string, defaultVal: number): number {
  const val = obj[field];
  if (typeof val === "number" && Number.isInteger(val)) return val;
  return defaultVal;
}

function optionalFloat(obj: Record<string, unknown>, field: string, defaultVal: number): number {
  const val = obj[field];
  if (typeof val === "number" && Number.isFinite(val)) return val;
  return defaultVal;
}
