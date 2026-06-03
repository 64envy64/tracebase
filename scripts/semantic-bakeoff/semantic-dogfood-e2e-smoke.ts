/**
 * $0 semantic dogfood E2E smoke.
 *
 * Disposable project -> init -> fake deployable sidecar -> operator preflight
 * -> runtime semantic shadow telemetry -> operator soak-check. This exercises the
 * real start gate and end gate without downloading a model or promoting semantic
 * verdicts into serving.
 */
import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlockServer } from "../../src/core/block-serving.js";
import { BlockStore } from "../../src/core/block-store.js";
import { loadConfig } from "../../src/core/config.js";
import { DeterministicLocalProvider } from "../../src/core/deterministic-local-provider.js";
import { importPatternsFromJsonl } from "../../src/ingest/import-patterns.js";
import { PATTERN_DTO_SCHEMA_VERSION as SCHEMA_VERSION } from "../../src/ingest/pattern-dto.js";
import { createSemanticShadowProvider } from "../../src/experiments/semantic-bakeoff/semantic-shadow.js";
import { attestationHash, type ModelAttestation } from "../../src/experiments/semantic-bakeoff/service/protocol.js";
import { startSemanticSidecar, type SemanticSidecarHandle } from "../../src/experiments/semantic-bakeoff/service/sidecar.js";
import { runReasoningPatternsRecall } from "../../src/server/reasoning-patterns-entry.js";

const TOKEN = "semantic-e2e-token-123456";
const ATTESTATION: ModelAttestation = {
  model: "fake",
  revision: "sidecar-fake-v1",
  backend: "fake",
  featureVersion: 1,
};

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function stableUnit(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0xffffffff;
}

function fakeVerdict(blockId: string): "applicable" | "uncertain" | "inapplicable" {
  const u = stableUnit(blockId);
  return u > 0.66 ? "applicable" : u > 0.33 ? "uncertain" : "inapplicable";
}

function cli(args: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["tsx", "bin/cli.ts", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      shell: process.platform === "win32",
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => { stdout += d.toString(); });
    child.stderr?.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => resolve({ code: code ?? 999, stdout, stderr }));
  });
}

function parseJson(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  const start = trimmed.indexOf("{");
  if (start < 0) throw new Error(`no JSON in stdout: ${trimmed.slice(0, 200)}`);
  return JSON.parse(trimmed.slice(start)) as Record<string, unknown>;
}

function patternDto(n: number): string {
  const key = `zzsemantice2e${n}`;
  return JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    pattern: {
      situation: `Failure marker ${key} appears when a numeric accumulator drifts`,
      mechanism: `Marker ${key} maps to repeated addition rounding drift in a running total`,
      unlock: `For ${key}, use compensated summation or integer scaled values`,
      verification: `Run regression ${key}`,
    },
    scope: { language: "typescript" },
    signals: { tags: [`candidate-${n}`] },
    provenance: {
      sourceType: "import",
      sourceRef: `e2e:candidate-${n}`,
      capturedAt: n + 1,
      captureVersion: "e2e",
    },
  });
}

function assertNoSecretLeak(value: unknown): void {
  const raw = JSON.stringify(value);
  if (raw.includes(TOKEN)) throw new Error("semantic dogfood smoke leaked its bearer token");
}

async function main(): Promise<void> {
  const projectDir = mkdtempSync(join(tmpdir(), "tb-semantic-dogfood-e2e-"));
  let sidecar: SemanticSidecarHandle | undefined;
  try {
    const preInit = await cli(["semantic", "dogfood-preflight", "--path", projectDir, "--json"]);
    const preInitJson = parseJson(preInit.stdout);
    if (
      preInit.code !== 1 ||
      preInitJson.verdict !== "blocked" ||
      !Array.isArray(preInitJson.blockers) ||
      !preInitJson.blockers.includes("project is not initialized")
    ) {
      throw new Error(`pre-init preflight should block on init: ${preInit.stdout}${preInit.stderr}`);
    }

    const init = await cli(["init", "--path", projectDir, "--yes", "--skip-mcp-config", "--skip-agent-instructions", "--no-holdout"]);
    if (init.code !== 0) throw new Error(`tracebase init failed: ${init.stdout}${init.stderr}`);

    sidecar = await startSemanticSidecar({
      backend: "fake",
      host: "127.0.0.1",
      port: 0,
      token: TOKEN,
      tenant: "semantic-dogfood-e2e",
      quota: { ratePerSec: 500, burst: 1000 },
    });
    const env = {
      TRACEBASE_SEMANTIC_SHADOW_URL: sidecar.url,
      TRACEBASE_SEMANTIC_SHADOW_TOKEN: TOKEN,
      TRACEBASE_SEMANTIC_SHADOW_ATTESTATION: JSON.stringify(ATTESTATION),
    };

    const ready = await cli(["semantic", "dogfood-preflight", "--path", projectDir, "--json"], env);
    const readyJson = parseJson(ready.stdout);
    if (ready.code !== 0 || readyJson.verdict !== "ready-to-collect") {
      throw new Error(`dogfood preflight did not become ready: ${ready.stdout}${ready.stderr}`);
    }

    const cfg = loadConfig(projectDir);
    const seedStore = new BlockStore(new Database(cfg.storagePath));
    const imported = importPatternsFromJsonl(
      seedStore,
      Array.from({ length: 80 }, (_, i) => patternDto(i)).join("\n"),
      { now: 1 },
    );
    const chosen = seedStore.listBlocks({ status: "active" }).find((b) => fakeVerdict(b.id) === "applicable");
    if (!chosen) throw new Error("could not seed a fake-applicable semantic block");
    const marker = /zzsemantice2e\d+/.exec(`${chosen.trigger.situation} ${chosen.body.mechanism} ${chosen.body.unlock}`)?.[0];
    if (!marker) throw new Error("chosen semantic block is missing its unique marker");
    seedStore.close();

    const shadow = createSemanticShadowProvider(projectDir, env, { drainDeadlineMs: 2_000 });
    if (!shadow) throw new Error("semantic shadow provider did not configure");
    const store = new BlockStore(new Database(cfg.storagePath));
    const server = new BlockServer(store, {
      gateThreshold: 2,
      servingMode: "v2-family",
      retrievalMode: "shadow",
      retrievalProvider: new DeterministicLocalProvider(),
      applicabilityMode: "shadow",
    });
    for (let i = 0; i < 105; i++) {
      await runReasoningPatternsRecall(server, { problem: marker, runId: `semantic-dogfood-e2e-${i}` }, {
        readHoldoutConfig: () => null,
        semanticShadowProvider: shadow.provider,
      });
      if (i === 0) await shadow.provider.drainWarm?.();
    }
    await shadow.provider.drainWarm?.();
    await shadow.close();
    store.close();

    const shadowReport = parseJson((await cli(["semantic", "shadow-report", "--path", projectDir, "--json"], env)).stdout);
    const outPath = join(projectDir, "semantic-soak.json");
    const soak = await cli(["semantic", "soak-check", "--path", projectDir, "--out", outPath, "--json"], env);
    const soakJson = parseJson(soak.stdout);
    const saved = JSON.parse(readFileSync(outPath, "utf8")) as unknown;
    if (soak.code !== 0 || soakJson.verdict !== "ready") {
      throw new Error(`semantic soak did not reach ready: ${soak.stdout}${soak.stderr}`);
    }
    if (JSON.stringify(saved) !== JSON.stringify(soakJson)) {
      throw new Error("semantic soak --out artifact did not match stdout JSON");
    }
    assertNoSecretLeak({ readyJson, shadowReport, soakJson });

    const shadowSummary = shadowReport as {
      traffic: number;
      residual: { semanticApplicable: number; recoveryRate: number };
      latencyMs: { p95: number };
      attestationIds: string[];
    };
    console.log(JSON.stringify({
      smoke: "semantic-dogfood-e2e.v1",
      preInitVerdict: preInitJson.verdict,
      preflightVerdict: readyJson.verdict,
      soakVerdict: soakJson.verdict,
      traffic: shadowSummary.traffic,
      residualApplicable: shadowSummary.residual.semanticApplicable,
      recoveryRate: shadowSummary.residual.recoveryRate,
      latencyP95Ms: shadowSummary.latencyMs.p95,
      attestationId: attestationHash(ATTESTATION),
      observedAttestations: shadowSummary.attestationIds,
      imported: imported.accepted,
      tokenLeaked: false,
      shadowOnly: true,
      servingPromoted: false,
    }, null, 2));
  } finally {
    await sidecar?.close().catch(() => undefined);
    rmSync(projectDir, { recursive: true, force: true });
  }
}

void main();
