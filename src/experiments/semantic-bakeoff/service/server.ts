/**
 * Provider-agnostic semantic inference data plane (R&D). HTTP `/v1/health` +
 * `/v1/rerank`. Backend-agnostic (fake or Qwen-local behind RerankBackend).
 *
 * Guarantees: scanned bounded DTO (re-scanned server-side — never trust the
 * client), strict per-request deadline, concurrency cap (overflow → 503),
 * cancellation on client disconnect, model/revision attestation on every response,
 * structured PRIVACY-SAFE telemetry (counts only), and NO persistence of
 * query/snippet payloads — the body is parsed in memory, used, and dropped; only
 * counters survive. Separate from the Next.js control plane.
 */
import { createServer, type Server } from "node:http";
import { detectLeakageExtended } from "../../../core/guard.js";
import type { RerankBackend } from "./backend.js";
import { RERANK_PROTOCOL_VERSION, type RerankRequestDTO, type RerankResponseDTO, type HealthDTO } from "./protocol.js";

export interface ServiceOptions {
  /** Max in-flight rerank requests; overflow → 503. */
  concurrency?: number;
  /** Server-side deadline cap (ms); the request may ask for less. */
  maxDeadlineMs?: number;
  /** Max request body bytes. */
  maxBodyBytes?: number;
}

export interface RerankService {
  server: Server;
  listen(port?: number): Promise<number>;
  close(): Promise<void>;
  telemetry: HealthDTO["telemetry"];
}

const BOUNDS = { maxCandidates: 32, maxTokensPerField: 128, maxQueryChars: 8000 };

export function createRerankService(backend: RerankBackend, opts: ServiceOptions = {}): RerankService {
  const concurrency = opts.concurrency ?? 8;
  const maxDeadlineMs = opts.maxDeadlineMs ?? 2000;
  const maxBodyBytes = opts.maxBodyBytes ?? 256 * 1024;
  const telemetry: HealthDTO["telemetry"] = { served: 0, rejectedLeak: 0, rejectedMalformed: 0, timeouts: 0, overloads: 0, backendErrors: 0 };
  let inFlight = 0;

  const send = (res: import("node:http").ServerResponse, code: number, body: unknown): void => {
    const s = JSON.stringify(body);
    res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
    res.end(s);
  };

  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/health") {
      const h: HealthDTO = { ok: true, attestation: backend.attestation, inFlight, telemetry };
      return send(res, 200, h);
    }
    if (req.method !== "POST" || req.url !== "/v1/rerank") return send(res, 404, { error: "not_found" });

    // Read body with a hard size cap. Never logged, never persisted.
    let size = 0;
    const chunks: Buffer[] = [];
    let aborted = false;
    req.on("aborted", () => { aborted = true; });
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBodyBytes) { req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      void handle();
    });

    async function handle(): Promise<void> {
      if (aborted) return; // client cancelled before we could process
      let dto: RerankRequestDTO;
      try {
        dto = JSON.parse(Buffer.concat(chunks).toString("utf8")) as RerankRequestDTO;
      } catch {
        telemetry.rejectedMalformed++;
        return send(res, 400, { error: "malformed_json" });
      }
      if (dto?.v !== RERANK_PROTOCOL_VERSION || typeof dto.tenant !== "string" || !dto.query || !Array.isArray(dto.candidates)) {
        telemetry.rejectedMalformed++;
        return send(res, 400, { error: "bad_request" });
      }
      // Bound + SCAN server-side (defence in depth — never trust the client).
      const q = { literalText: String(dto.query.literalText ?? "").slice(0, BOUNDS.maxQueryChars), ...(dto.query.causalText ? { causalText: String(dto.query.causalText).slice(0, BOUNDS.maxQueryChars) } : {}) };
      const candidates = dto.candidates.slice(0, BOUNDS.maxCandidates).map((c) => ({
        blockId: String(c.blockId),
        mechanism: (c.mechanism ?? []).slice(0, BOUNDS.maxTokensPerField),
        situation: (c.situation ?? []).slice(0, BOUNDS.maxTokensPerField),
        unlock: (c.unlock ?? []).slice(0, BOUNDS.maxTokensPerField),
      }));
      if (detectLeakageExtended(JSON.stringify({ q, candidates })) !== null) {
        telemetry.rejectedLeak++;
        return send(res, 422, { error: "leak_rejected" }); // a leak is never forwarded to the backend
      }
      if (inFlight >= concurrency) {
        telemetry.overloads++;
        return send(res, 503, { error: "overloaded" });
      }
      const deadlineMs = Math.min(maxDeadlineMs, Math.max(1, Number(dto.featureVersion ? maxDeadlineMs : maxDeadlineMs)));
      inFlight++;
      const TIMEOUT = Symbol("t");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const raced = await Promise.race([
          backend.rerank(q, candidates, deadlineMs),
          new Promise<typeof TIMEOUT>((r) => { timer = setTimeout(() => r(TIMEOUT), deadlineMs); }),
        ]);
        if (raced === TIMEOUT) { telemetry.timeouts++; return send(res, 504, { error: "deadline_exceeded" }); }
        if (raced === null) { telemetry.backendErrors++; return send(res, 502, { error: "backend_unavailable" }); }
        if (aborted) return; // client gone — drop the (already-computed) result, persist nothing
        const out: RerankResponseDTO = { v: RERANK_PROTOCOL_VERSION, requestId: String(dto.requestId ?? ""), attestation: backend.attestation, results: raced };
        telemetry.served++;
        return send(res, 200, out);
      } catch {
        telemetry.backendErrors++;
        return send(res, 502, { error: "backend_error" });
      } finally {
        if (timer) clearTimeout(timer);
        inFlight--;
      }
    }
  });

  return {
    server,
    telemetry,
    listen: (port = 0) =>
      new Promise<number>((resolve) => {
        server.listen(port, "127.0.0.1", () => {
          const addr = server.address();
          resolve(typeof addr === "object" && addr ? addr.port : port);
        });
      }),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
