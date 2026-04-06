import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { TraceBaseConfig, RecallQuery, StoreTraceInput } from "../types.js";
import { ReasoningLayer } from "../core/engine.js";

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
): Promise<void> {
  const layer = new ReasoningLayer(config);

  const server = createServer(async (req, res) => {
    // CORS headers
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
        const body = await readBody<RecallQuery>(req);
        const results = layer.recall(body);
        json(res, 200, { results });
        return;
      }

      if (path === "/store" && req.method === "POST") {
        const body = await readBody<StoreTraceInput>(req);
        const trace = layer.storeTrace(body);
        json(res, 201, { trace });
        return;
      }

      if (path === "/search" && req.method === "GET") {
        const q = url.searchParams.get("q") ?? "";
        const limit = parseInt(url.searchParams.get("limit") ?? "10", 10);
        const results = layer.search(q, limit);
        json(res, 200, { results });
        return;
      }

      if (path === "/feedback" && req.method === "POST") {
        const body = await readBody<{ traceId: string; helpful: boolean }>(req);
        layer.feedback(body.traceId, body.helpful);
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
        const traces = layer.listTraces(limit, offset);
        json(res, 200, { traces, total: layer.count() });
        return;
      }

      json(res, 404, { error: "Not found" });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Internal server error";
      json(res, 500, { error: message });
    }
  });

  // Graceful shutdown
  process.on("SIGINT", () => {
    layer.close();
    server.close();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    layer.close();
    server.close();
    process.exit(0);
  });

  return new Promise<void>((resolve) => {
    server.listen(port, host, () => resolve());
  });
}

// ============================================================================
// Helpers
// ============================================================================

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()) as T);
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}
