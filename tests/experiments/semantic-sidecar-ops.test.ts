import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StaticBearerAuthenticator } from "../../src/experiments/semantic-bakeoff/service/auth.js";
import { probeSemanticShadow } from "../../src/experiments/semantic-bakeoff/service/doctor.js";
import {
  decodeHealthResponse,
  decodeLivenessResponse,
} from "../../src/experiments/semantic-bakeoff/service/protocol.js";
import {
  QWEN_MODEL_REVISION,
  diagnoseSemanticSidecarConfig,
  startSemanticSidecar,
  verifyQwenArtifact,
  type SemanticSidecarHandle,
} from "../../src/experiments/semantic-bakeoff/service/sidecar.js";

const token = "semantic-sidecar-token-123456";
const dirs: string[] = [];
const sidecars: SemanticSidecarHandle[] = [];
const fakeConfig = () => {
  const diagnosed = diagnoseSemanticSidecarConfig({
    TRACEBASE_SEMANTIC_SIDECAR_BACKEND: "fake",
    TRACEBASE_SEMANTIC_SIDECAR_ALLOW_FAKE: "1",
    TRACEBASE_SEMANTIC_SIDECAR_TOKEN: token,
    TRACEBASE_SEMANTIC_SIDECAR_TENANT: "team-a",
    TRACEBASE_SEMANTIC_SIDECAR_PORT: "0",
  });
  if (diagnosed.status !== "configured") throw new Error(diagnosed.reasons.join("; "));
  return diagnosed.config;
};
const shadowEnv = (url: string, authToken = token, revision = "sidecar-fake-v1") => ({
  TRACEBASE_SEMANTIC_SHADOW_URL: url,
  TRACEBASE_SEMANTIC_SHADOW_TOKEN: authToken,
  TRACEBASE_SEMANTIC_SHADOW_ATTESTATION: JSON.stringify({
    model: "fake",
    revision,
    backend: "fake",
    featureVersion: 1,
  }),
});

afterEach(async () => {
  await Promise.all(sidecars.map((sidecar) => sidecar.close().catch(() => undefined)));
  sidecars.length = 0;
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

describe("semantic sidecar operations", () => {
  it("fails closed on public-health expansion and malformed admin counters", () => {
    expect(decodeLivenessResponse({ ok: true, protocolVersion: 2 })).toEqual({
      ok: true,
      protocolVersion: 2,
    });
    expect(decodeLivenessResponse({ ok: true, protocolVersion: 2, telemetry: { served: 1 } })).toBeNull();
    expect(decodeHealthResponse({
      ok: true,
      attestation: { model: "fake", revision: "rev", backend: "fake", featureVersion: 1 },
      inFlight: 0,
      telemetry: {
        served: "1",
        rejectedAuth: 0,
        rejectedLeak: 0,
        rejectedMalformed: 0,
        rejectedTooLarge: 0,
        rejectedExpired: 0,
        quotaExceeded: 0,
        timeouts: 0,
        overloads: 0,
        backendErrors: 0,
      },
    })).toBeNull();
  });

  it("uses constant-size bearer digests and rejects weak credentials", () => {
    expect(() => new StaticBearerAuthenticator("short", "team")).toThrow("at least 16 characters");
    const auth = new StaticBearerAuthenticator(token, "team-a");
    expect(auth.authenticate({ authorization: `Bearer ${token}` })).toEqual({ tenant: "team-a" });
    expect(auth.authenticate({ authorization: "Bearer wrong-but-long-token-999" })).toBeNull();
  });

  it("requires an explicit fake opt-in and the pinned qwen supply-chain revision", () => {
    expect(diagnoseSemanticSidecarConfig({
      TRACEBASE_SEMANTIC_SIDECAR_BACKEND: "fake",
      TRACEBASE_SEMANTIC_SIDECAR_TOKEN: token,
      TRACEBASE_SEMANTIC_SIDECAR_TENANT: "team-a",
    })).toMatchObject({ status: "invalid" });
    const qwen = diagnoseSemanticSidecarConfig({
      TRACEBASE_SEMANTIC_SIDECAR_BACKEND: "qwen-local",
      TRACEBASE_SEMANTIC_SIDECAR_TOKEN: token,
      TRACEBASE_SEMANTIC_SIDECAR_TENANT: "team-a",
      TRACEBASE_SEMANTIC_SIDECAR_QWEN_MODEL_DIR: ".models/qwen",
      TRACEBASE_SEMANTIC_SIDECAR_QWEN_REVISION: "floating-main",
    });
    expect(qwen).toEqual({
      status: "invalid",
      reasons: ["TRACEBASE_SEMANTIC_SIDECAR_QWEN_REVISION must equal the pinned supply-chain revision"],
    });
    expect(QWEN_MODEL_REVISION).toHaveLength(40);
  });

  it("refuses a missing or substituted qwen artifact before worker startup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tb-qwen-artifact-"));
    dirs.push(dir);
    await expect(verifyQwenArtifact(dir)).rejects.toThrow("artifact missing");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "model.safetensors"), "substituted", "utf8");
    await expect(verifyQwenArtifact(dir)).rejects.toThrow("sha256 does not match");
  });

  it("refuses a qwen worker that cannot handshake before listening", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tb-qwen-worker-"));
    dirs.push(dir);
    await expect(startSemanticSidecar({
      backend: "qwen-local",
      host: "127.0.0.1",
      port: 0,
      token,
      tenant: "team-a",
      qwen: { command: join(dir, "missing-python"), modelDir: dir, revision: QWEN_MODEL_REVISION },
      quota: { ratePerSec: 20, burst: 40 },
    }, { skipArtifactVerification: true })).rejects.toThrow("startup handshake");
  });

  it("starts the fake sidecar and probes liveness, auth, and pinned attestation without returning the token", async () => {
    const sidecar = await startSemanticSidecar(fakeConfig());
    sidecars.push(sidecar);
    const ready = await probeSemanticShadow(shadowEnv(sidecar.url));
    expect(ready).toMatchObject({ status: "ready", endpoint: sidecar.url, unpinnedDevMode: false });
    expect(JSON.stringify(ready)).not.toContain(token);
    expect(await probeSemanticShadow(shadowEnv(sidecar.url, "wrong-but-long-token-999"))).toMatchObject({
      status: "unauthorized",
      endpoint: sidecar.url,
    });
    expect(await probeSemanticShadow(shadowEnv(sidecar.url, token, "wrong-revision"))).toMatchObject({
      status: "attestation-mismatch",
      endpoint: sidecar.url,
    });
  });

  it("rejects an occupied bind address instead of hanging during startup", async () => {
    const first = await startSemanticSidecar(fakeConfig());
    sidecars.push(first);
    const occupiedPort = Number(new URL(first.url).port);
    await expect(startSemanticSidecar({ ...fakeConfig(), port: occupiedPort })).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
  });
});
