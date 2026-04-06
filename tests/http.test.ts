import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { startHttpServer } from "../src/server/http.js";

function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { unlinkSync(path + suffix); } catch { /* ok */ }
  }
}

function request(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: data
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
          : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString();
          resolve({
            status: res.statusCode!,
            body: raw ? JSON.parse(raw) as Record<string, unknown> : {},
          });
        });
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

describe("HTTP Server", () => {
  let dbPath: string;
  let port: number;
  let closeFn: () => void;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `tracebase-http-${randomUUID()}.db`);
    port = 30000 + Math.floor(Math.random() * 10000);
    const result = await startHttpServer({ storagePath: dbPath }, "127.0.0.1", port);
    closeFn = result.close;
  });

  afterEach(() => {
    closeFn();
    cleanupDb(dbPath);
  });

  it("GET /health returns ok", async () => {
    const res = await request(port, "GET", "/health");
    expect(res.status).toBe(200);
    expect(res.body["status"]).toBe("ok");
  });

  it("POST /store validates required fields", async () => {
    // Empty body
    const res1 = await request(port, "POST", "/store", {});
    expect(res1.status).toBe(400);
    expect(res1.body["error"]).toContain("problem");

    // Missing solution
    const res2 = await request(port, "POST", "/store", {
      problem: { description: "test" },
    });
    expect(res2.status).toBe(400);
    expect(res2.body["error"]).toContain("solution");
  });

  it("POST /store + GET /stats round trip", async () => {
    const storeRes = await request(port, "POST", "/store", {
      problem: { description: "HTTP test bug", tags: [] },
      solution: { summary: "HTTP test fix", steps: [], outcome: "success" },
    });
    expect(storeRes.status).toBe(201);
    expect(storeRes.body["trace"]).toBeDefined();

    const statsRes = await request(port, "GET", "/stats");
    expect(statsRes.status).toBe(200);
    expect(statsRes.body["totalTraces"]).toBe(1);
  });

  it("POST /feedback validates fields", async () => {
    const res = await request(port, "POST", "/feedback", { traceId: 123 });
    expect(res.status).toBe(400);
    expect(res.body["error"]).toContain("traceId");
  });

  it("POST /recall validates problem field", async () => {
    const res = await request(port, "POST", "/recall", {});
    expect(res.status).toBe(400);
    expect(res.body["error"]).toContain("problem");
  });

  it("returns 404 for unknown routes", async () => {
    const res = await request(port, "GET", "/unknown");
    expect(res.status).toBe(404);
  });

  it("POST /store validates outcome enum", async () => {
    const res = await request(port, "POST", "/store", {
      problem: { description: "test" },
      solution: { summary: "fix", outcome: "banana" },
    });
    expect(res.status).toBe(400);
    expect(res.body["error"]).toContain("outcome");
  });
});
