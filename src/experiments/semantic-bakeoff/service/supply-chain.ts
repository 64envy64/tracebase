import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  QWEN_MODEL_REVISION,
  QWEN_MODEL_SHA256,
} from "./sidecar.js";

export interface SemanticSidecarSupplyChainCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SemanticSidecarSupplyChainReport {
  ok: boolean;
  checks: SemanticSidecarSupplyChainCheck[];
}

interface SupplyChainLock {
  schemaVersion: number;
  baseImages: { nodeBuilder: string; pytorchRuntime: string };
  node: { entrypoint: string; binary: string };
  qwen: {
    repo: string;
    revision: string;
    trustRemoteCode: boolean;
    requiredFiles: Array<{ path: string; sha256: string }>;
  };
  python: {
    installMode: string;
    wheelhouse: string;
    requirementsInput: string;
    requirementsLock: string;
    requiresHashes: boolean;
    topLevelPins: string[];
  };
  runtimePolicy: {
    semanticServingPromotion: boolean;
    shadowOnly: boolean;
    publicHealthContainsTelemetry: boolean;
    requiresPinnedAttestation: boolean;
  };
}

const digestRef = /^docker\.io\/[A-Za-z0-9._/-]+:[A-Za-z0-9._-]+@sha256:[a-f0-9]{64}$/;

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function lockOrThrow(root: string): SupplyChainLock {
  const raw = readJson(join(root, "deploy/semantic-sidecar/supply-chain.lock.json"));
  if (!raw || typeof raw !== "object") throw new Error("semantic sidecar supply-chain lock is not an object");
  const lock = raw as SupplyChainLock;
  if (lock.schemaVersion !== 1) throw new Error("unsupported semantic sidecar supply-chain schema");
  return lock;
}

function add(checks: SemanticSidecarSupplyChainCheck[], name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
}

export function verifySemanticSidecarSupplyChain(root: string = process.cwd()): SemanticSidecarSupplyChainReport {
  const checks: SemanticSidecarSupplyChainCheck[] = [];
  const lock = lockOrThrow(root);
  const dockerfilePath = join(root, "deploy/semantic-sidecar/Dockerfile");
  const dockerignorePath = join(root, "deploy/semantic-sidecar/Dockerfile.dockerignore");
  const dockerfile = existsSync(dockerfilePath) ? readFileSync(dockerfilePath, "utf8") : "";
  const dockerignore = existsSync(dockerignorePath) ? readFileSync(dockerignorePath, "utf8") : "";
  const packageJson = readJson(join(root, "package.json")) as {
    bin?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  const tsup = readFileSync(join(root, "tsup.config.ts"), "utf8");
  const sidecarSource = readFileSync(join(root, "bin/semantic-sidecar.ts"), "utf8");
  const sidecarTsupBlock = tsup.match(/entry:\s*\{\s*"semantic-sidecar":\s*"bin\/semantic-sidecar\.ts"\s*\}[\s\S]*?external:\s*EXTERNALS,\s*\}/)?.[0] ?? "";

  add(checks, "node-builder-image-digest", digestRef.test(lock.baseImages.nodeBuilder), lock.baseImages.nodeBuilder);
  add(checks, "pytorch-runtime-image-digest", digestRef.test(lock.baseImages.pytorchRuntime), lock.baseImages.pytorchRuntime);
  add(checks, "dockerfile-node-digest", dockerfile.includes(lock.baseImages.nodeBuilder), "Dockerfile uses locked Node builder image");
  add(checks, "dockerfile-pytorch-digest", dockerfile.includes(lock.baseImages.pytorchRuntime), "Dockerfile uses locked PyTorch runtime image");
  add(checks, "dockerfile-specific-ignore", existsSync(dockerignorePath), "Dockerfile-specific ignore file is used with root build context");
  add(checks, "wheelhouse-in-build-context", dockerignore.includes("!deploy/semantic-sidecar/**") && !dockerignore.includes("deploy/semantic-sidecar/wheelhouse/*"), "generated wheelhouse must be present in the image build context");
  add(checks, "no-network-pip-install", !/pip\s+install(?![^\n]*--no-index[^\n]*--require-hashes)/.test(dockerfile), "pip install must be offline + hash-locked");
  add(checks, "non-root-runtime-user", /USER\s+tracebase/.test(dockerfile), "runtime switches away from root");
  add(checks, "minimal-public-healthcheck", dockerfile.includes('{"ok": True, "protocolVersion": 2}'), "healthcheck expects public liveness only");
  add(checks, "package-bin-entry", packageJson.bin?.["tracebase-semantic-sidecar"] === lock.node.entrypoint, lock.node.entrypoint);
  add(checks, "tsup-sidecar-entry", tsup.includes('"semantic-sidecar": "bin/semantic-sidecar.ts"'), "sidecar has a built entrypoint");
  add(checks, "sidecar-source-shebang", sidecarSource.startsWith("#!/usr/bin/env node"), "sidecar source is executable");
  add(checks, "sidecar-single-shebang-contract", !sidecarTsupBlock.includes("banner:"), "sidecar source owns the shebang; tsup must not add a second one");
  add(checks, "sidecar-script-entry", packageJson.scripts?.["semantic:sidecar"] === "tsx bin/semantic-sidecar.ts", "repo script uses packaged entrypoint");
  add(checks, "qwen-revision-matches-code", lock.qwen.revision === QWEN_MODEL_REVISION, lock.qwen.revision);
  add(checks, "qwen-model-sha-matches-code", lock.qwen.requiredFiles.some((file) => file.path === "model.safetensors" && file.sha256 === QWEN_MODEL_SHA256), QWEN_MODEL_SHA256);
  add(checks, "trust-remote-code-disabled", lock.qwen.trustRemoteCode === false, "trust_remote_code must stay false");
  add(checks, "offline-wheelhouse-policy", lock.python.installMode === "offline-wheelhouse" && lock.python.requiresHashes === true, lock.python.installMode);
  add(checks, "requirements-input-present", existsSync(join(root, lock.python.requirementsInput)), lock.python.requirementsInput);
  add(checks, "runtime-shadow-only", lock.runtimePolicy.shadowOnly === true && lock.runtimePolicy.semanticServingPromotion === false, "semantic promotion disabled");
  add(checks, "attestation-required", lock.runtimePolicy.requiresPinnedAttestation === true, "doctor/client must pin attestation");

  return { ok: checks.every((check) => check.ok), checks };
}
