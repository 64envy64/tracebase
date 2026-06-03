import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifySemanticSidecarSupplyChain } from "../../src/experiments/semantic-bakeoff/service/supply-chain.js";

const root = process.cwd();

describe("semantic sidecar supply-chain contract", () => {
  it("keeps the container contract pinned, offline, and shadow-only", () => {
    const report = verifySemanticSidecarSupplyChain(root);
    expect(report.ok, JSON.stringify(report.checks.filter((check) => !check.ok), null, 2)).toBe(true);
  });

  it("does not use a tag-only base image or network pip install", () => {
    const dockerfile = readFileSync(join(root, "deploy/semantic-sidecar/Dockerfile"), "utf8");
    expect(dockerfile).toMatch(/^ARG TRACEBASE_NODE_BASE=.*@sha256:[a-f0-9]{64}$/m);
    expect(dockerfile).toMatch(/^ARG TRACEBASE_PYTORCH_BASE=.*@sha256:[a-f0-9]{64}$/m);
    expect(dockerfile).not.toMatch(/^FROM\s+(?:node|pytorch\/pytorch|docker\.io\/).+:[^\s@]+$/m);
    expect(dockerfile).toContain("--no-index --find-links=/opt/tracebase/wheelhouse --require-hashes");
  });

  it("uses a Dockerfile-specific build context that keeps the generated wheelhouse available", () => {
    const dockerignore = readFileSync(join(root, "deploy/semantic-sidecar/Dockerfile.dockerignore"), "utf8");
    expect(dockerignore).toContain("!deploy/semantic-sidecar/**");
    expect(dockerignore).not.toContain("deploy/semantic-sidecar/wheelhouse/*");
  });

  it("documents the wheelhouse as generated state, not source", () => {
    const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
    expect(gitignore).toContain("deploy/semantic-sidecar/wheelhouse/*");
    expect(gitignore).toContain("!deploy/semantic-sidecar/wheelhouse/.gitkeep");
  });
});
