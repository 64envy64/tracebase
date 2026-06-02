/**
 * Semantic inference data plane — HTTP service v2 (R&D, E.2.1).
 *
 * `GET /v1/health` + `POST /v1/rerank`. Backend-agnostic. Hardening:
 *   - TENANT from a verified PRINCIPAL (auth), never the request body (401 on fail);
 *   - per-tenant QUOTA (429); body size cap → clean 413; strict v2 DECODE → 400;
 *   - absolute expiry drop (410); server-side leak re-scan (422); concurrency cap (503);
 *   - deadline = min(client, server cap); AbortSignal to the backend on deadline OR
 *     client DISCONNECT (cancellation); attestation + echoed requestId on success;
 *   - NO persistence of query/snippet payloads (counters only). Separate from the
 *     Next.js control plane.
 */
import { createServer, type Server, type ServerResponse } from "node:http";
import { detectLeakageExtended } from "../../../core/guard.js";
import type { RerankBackend } from "./backend.js";
import type { Authenticator, TenantQuota } from "./auth.js";
import { RERANK_PROTOCOL_VERSION, decodeRerankRequest, type RerankResponseDTO, type HealthDTO } from "./protocol.js";

export interface ServiceOptions {
  authenticator: Authenticator;
  quota?: TenantQuota;
  concurrency?: number;
  maxDeadlineMs?: number;
  maxBodyBytes?: number;
  now?: () => number;
}

export interface RerankService {
  server: Server;
  listen(port?: number): Promise<number>;
  close(): Promise<void>;
  telemetry: HealthDTO["telemetry"];
}

const MAX_CANDIDATES = 32;

export function createRerankService(backend: RerankBackend, opts: ServiceOptions): RerankService {
  const concurrency = opts.concurrency ?? 8;
  const maxDeadlineMs = opts.maxDeadlineMs ?? 2000;
  const maxBodyBytes = opts.maxBodyBytes ?? 256 * 1024;
  const now = opts.now ?? Date.now;
  const telemetry: HealthDTO["telemetry"] = { served: 0, rejectedAuth: 0, rejectedLeak: 0, rejectedMalformed: 0, rejectedTooLarge: 0, rejectedExpired: 0, quotaExceeded: 0, timeouts: 0, overloads: 0, backendErrors: 0 };
  let inFlight = 0;

  const send = (res: ServerResponse, code: number, body: unknown): void => {
    const s = JSON.stringify(body);
    res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
    res.end(s);
  };

  const server = createServer((req, res) => {
    // PUBLIC liveness — no auth, no telemetry, no attestation leak. Just "alive".
    if (req.method === "GET" && req.url === "/v1/health") {
      return send(res, 200, { ok: true, protocolVersion: RERANK_PROTOCOL_VERSION });
    }
    // AUTHENTICATED admin health — full attestation + telemetry, principal required.
    if (req.method === "GET" && req.url === "/v1/admin/health") {
      const admin = opts.authenticator.authenticate(req.headers);
      if (!admin) {
        telemetry.rejectedAuth++;
        return send(res, 401, { error: "unauthorized" });
      }
      return send(res, 200, { ok: true, attestation: backend.attestation, inFlight, telemetry } satisfies HealthDTO);
    }
    if (req.method !== "POST" || req.url !== "/v1/rerank") return send(res, 404, { error: "not_found" });

    // Auth FIRST — tenant from the verified principal, never the body.
    const principal = opts.authenticator.authenticate(req.headers);
    if (!principal) {
      telemetry.rejectedAuth++;
      return send(res, 401, { error: "unauthorized" });
    }
    if (opts.quota && !opts.quota.allow(principal.tenant)) {
      telemetry.quotaExceeded++;
      return send(res, 429, { error: "quota_exceeded" });
    }

    let size = 0;
    const chunks: Buffer[] = [];
    let tooLarge = false;
    let disconnected = false;
    const ac = new AbortController();
    req.on("aborted", () => { disconnected = true; ac.abort(); });
    res.on("close", () => { if (!res.writableEnded) { disconnected = true; ac.abort(); } });
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBodyBytes) { tooLarge = true; return; } // stop buffering (bound memory) but drain → clean 413 on `end`
      chunks.push(c);
    });
    req.on("end", () => void handle());

    async function handle(): Promise<void> {
      if (tooLarge) { telemetry.rejectedTooLarge++; return send(res, 413, { error: "payload_too_large" }); }
      if (disconnected) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        telemetry.rejectedMalformed++;
        return send(res, 400, { error: "malformed_json" });
      }
      const dto = decodeRerankRequest(parsed, { maxCandidates: MAX_CANDIDATES });
      if (!dto) { telemetry.rejectedMalformed++; return send(res, 400, { error: "bad_request" }); }
      if (dto.expiresAtMs < now()) { telemetry.rejectedExpired++; return send(res, 410, { error: "expired" }); }

      const q = { literalText: dto.query.literalText, ...(dto.query.causalText ? { causalText: dto.query.causalText } : {}) };
      const candidates = dto.candidates.map((c) => ({ blockId: c.blockId, mechanism: c.mechanism, situation: c.situation, unlock: c.unlock }));
      if (detectLeakageExtended(JSON.stringify({ q, candidates })) !== null) {
        telemetry.rejectedLeak++;
        return send(res, 422, { error: "leak_rejected" });
      }
      if (inFlight >= concurrency) { telemetry.overloads++; return send(res, 503, { error: "overloaded" }); }

      // Effective deadline = min(client request, server cap, time-until-expiry).
      const deadlineMs = Math.max(1, Math.min(maxDeadlineMs, dto.deadlineMs, dto.expiresAtMs - now()));
      inFlight++;
      const TIMEOUT = Symbol("t");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const raced = await Promise.race([
          backend.rerank(q, candidates, deadlineMs, ac.signal),
          new Promise<typeof TIMEOUT>((r) => { timer = setTimeout(() => { ac.abort(); r(TIMEOUT); }, deadlineMs); }),
        ]);
        if (disconnected) return; // client gone → cancelled; persist nothing, send nothing
        if (raced === TIMEOUT) { telemetry.timeouts++; return send(res, 504, { error: "deadline_exceeded" }); }
        if (raced === null) { telemetry.backendErrors++; return send(res, 502, { error: "backend_unavailable" }); }
        telemetry.served++;
        return send(res, 200, { v: RERANK_PROTOCOL_VERSION, requestId: dto.requestId, attestation: backend.attestation, results: raced } satisfies RerankResponseDTO);
      } catch {
        if (disconnected) return;
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
    listen: (port = 0) => new Promise<number>((resolve) => server.listen(port, "127.0.0.1", () => { const a = server.address(); resolve(typeof a === "object" && a ? a.port : port); })),
    close: async () => {
      try {
        await backend.close?.(); // graceful backend shutdown (release worker/GPU)
      } catch {
        /* ignore */
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
