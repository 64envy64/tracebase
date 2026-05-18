import { describe, it, expect } from "vitest";
import {
  buildRerankerFromCascadeConfig,
  shouldUseCascade,
  extractCascadeKnobs,
} from "../../src/experiments/cascade-rollout.js";
import { CloudReranker, NoopReranker } from "../../src/core/reranker.js";
import type { CascadeConfig } from "../../src/types.js";

function cfg(overrides: Partial<CascadeConfig> = {}): CascadeConfig {
  return {
    enabled: true,
    rollout: { rate: 0.5, salt: "test-salt" },
    reranker: { kind: "noop" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildRerankerFromCascadeConfig — fail-safe to identity", () => {
  it("returns NoopReranker when config is null", () => {
    const r = buildRerankerFromCascadeConfig(null);
    expect(r).toBeInstanceOf(NoopReranker);
  });

  it("returns NoopReranker when config is undefined", () => {
    const r = buildRerankerFromCascadeConfig(undefined);
    expect(r).toBeInstanceOf(NoopReranker);
  });

  it("returns NoopReranker for kind: noop", () => {
    const r = buildRerankerFromCascadeConfig(cfg({ reranker: { kind: "noop" } }));
    expect(r).toBeInstanceOf(NoopReranker);
  });

  it("returns CloudReranker when kind: cloud + endpoint set", () => {
    const r = buildRerankerFromCascadeConfig(cfg({
      reranker: {
        kind: "cloud",
        endpoint: "https://example.test/rerank",
        apiKey: "secret",
        model: "test-model",
      },
    }));
    expect(r).toBeInstanceOf(CloudReranker);
  });

  it("falls back to NoopReranker when kind: cloud but endpoint missing", () => {
    // A misconfigured cloud config must NOT wedge the server with a
    // broken reranker. NoopReranker exercises the cascade architecture
    // without external dependencies.
    const r = buildRerankerFromCascadeConfig(cfg({
      reranker: { kind: "cloud" },
    }));
    expect(r).toBeInstanceOf(NoopReranker);
  });

  it("downgrades reserved local-ONNX kinds to NoopReranker (forward-compat)", () => {
    // Config can name a future kind that hasn't shipped yet (minilm /
    // bge-v2-m3). Until the ONNX worker PR lands, we silently downgrade
    // so a forward-declared config doesn't break the cascade.
    const minilm = buildRerankerFromCascadeConfig(cfg({ reranker: { kind: "minilm" } }));
    const bge = buildRerankerFromCascadeConfig(cfg({ reranker: { kind: "bge-v2-m3" } }));
    expect(minilm).toBeInstanceOf(NoopReranker);
    expect(bge).toBeInstanceOf(NoopReranker);
  });
});

describe("shouldUseCascade — deterministic per-query rollout", () => {
  it("returns false when config is null", () => {
    expect(shouldUseCascade("any-fp", null)).toBe(false);
  });

  it("returns false when config is undefined", () => {
    expect(shouldUseCascade("any-fp", undefined)).toBe(false);
  });

  it("returns false when enabled: false (master switch)", () => {
    expect(shouldUseCascade("fp", cfg({ enabled: false, rollout: { rate: 1.0, salt: "s" } }))).toBe(false);
  });

  it("returns false when rate <= 0", () => {
    expect(shouldUseCascade("fp", cfg({ rollout: { rate: 0, salt: "s" } }))).toBe(false);
    expect(shouldUseCascade("fp", cfg({ rollout: { rate: -0.5, salt: "s" } }))).toBe(false);
  });

  it("returns false when rate is non-finite", () => {
    expect(shouldUseCascade("fp", cfg({ rollout: { rate: NaN, salt: "s" } }))).toBe(false);
    expect(shouldUseCascade("fp", cfg({ rollout: { rate: Infinity, salt: "s" } }))).toBe(false);
  });

  it("returns false when fingerprint is empty or undefined", () => {
    expect(shouldUseCascade(undefined, cfg({ rollout: { rate: 1, salt: "s" } }))).toBe(false);
    expect(shouldUseCascade("", cfg({ rollout: { rate: 1, salt: "s" } }))).toBe(false);
  });

  it("rate=1.0 → every fingerprint is in the cohort", () => {
    const c = cfg({ rollout: { rate: 1.0, salt: "s" } });
    for (const fp of ["fp-1", "fp-2", "fp-3", "abcdef", "xyz"]) {
      expect(shouldUseCascade(fp, c)).toBe(true);
    }
  });

  it("is deterministic — same (fp, rate, salt) yields the same decision", () => {
    const c = cfg({ rollout: { rate: 0.5, salt: "stable-salt" } });
    const decisions = new Set<boolean>();
    for (let i = 0; i < 5; i++) {
      decisions.add(shouldUseCascade("fp-determinism", c));
    }
    expect(decisions.size).toBe(1);
  });

  it("different salts can flip the cohort for the same fingerprint", () => {
    // Statistical property: across many salts a fixed fp should hash
    // both ways. Single salt = single deterministic answer (above test).
    // This pins the property that salt influences assignment.
    let saw = { in: false, out: false };
    for (let i = 0; i < 32 && !(saw.in && saw.out); i++) {
      const c = cfg({ rollout: { rate: 0.5, salt: `salt-${i}` } });
      if (shouldUseCascade("fp-fixed", c)) saw.in = true;
      else saw.out = true;
    }
    expect(saw.in).toBe(true);
    expect(saw.out).toBe(true);
  });
});

describe("extractCascadeKnobs", () => {
  it("returns empty object when config is null", () => {
    expect(extractCascadeKnobs(null)).toEqual({});
  });

  it("returns empty object when config has no tuning knobs", () => {
    expect(extractCascadeKnobs(cfg())).toEqual({});
  });

  it("extracts timeoutMs / mmrLambda / fetchMultiplier when present", () => {
    expect(extractCascadeKnobs(cfg({
      timeoutMs: 500,
      mmrLambda: 0.5,
      fetchMultiplier: 6,
    }))).toEqual({
      rerankerTimeoutMs: 500,
      mmrLambda: 0.5,
      cascadeFetchMultiplier: 6,
    });
  });

  it("only extracts the fields that are actually set (partial)", () => {
    expect(extractCascadeKnobs(cfg({ mmrLambda: 0.8 }))).toEqual({ mmrLambda: 0.8 });
  });
});
