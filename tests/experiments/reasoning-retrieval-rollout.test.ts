/**
 * Phase C hybrid retrieval rollout resolver — default-off + mode mapping.
 */
import { describe, it, expect } from "vitest";
import {
  resolveReasoningRetrievalMode,
  reasoningRetrievalOptions,
  retrievalRolloutOptionsForMode,
  REASONING_RETRIEVAL_ENV,
} from "../../src/experiments/reasoning-retrieval-rollout.js";
import { NoopRetrievalProvider } from "../../src/core/retrieval-provider.js";

describe("reasoning-retrieval rollout resolver", () => {
  it("defaults to off when unset/empty, no diagnostic", () => {
    expect(resolveReasoningRetrievalMode({}).mode).toBe("off");
    expect(resolveReasoningRetrievalMode({ [REASONING_RETRIEVAL_ENV]: "" }).mode).toBe("off");
    expect(resolveReasoningRetrievalMode({}).diagnostics).toEqual([]);
  });

  it("parses off | shadow | on (case-insensitive, trimmed)", () => {
    expect(resolveReasoningRetrievalMode({ [REASONING_RETRIEVAL_ENV]: "shadow" }).mode).toBe("shadow");
    expect(resolveReasoningRetrievalMode({ [REASONING_RETRIEVAL_ENV]: " ON " }).mode).toBe("on");
    expect(resolveReasoningRetrievalMode({ [REASONING_RETRIEVAL_ENV]: "off" }).mode).toBe("off");
  });

  it("ignores an unrecognized value — off + diagnostic", () => {
    const r = resolveReasoningRetrievalMode({ [REASONING_RETRIEVAL_ENV]: "hybrid" });
    expect(r.mode).toBe("off");
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });

  it("off wires no provider; shadow/on wire a provider", () => {
    expect(retrievalRolloutOptionsForMode("off")).toEqual({ retrievalMode: "off" });
    const shadow = retrievalRolloutOptionsForMode("shadow", () => new NoopRetrievalProvider());
    expect(shadow.retrievalMode).toBe("shadow");
    expect(shadow.retrievalProvider).toBeInstanceOf(NoopRetrievalProvider);
    const on = retrievalRolloutOptionsForMode("on");
    expect(on.retrievalMode).toBe("on");
    expect(on.retrievalProvider).toBeDefined(); // default DeterministicLocalProvider
    expect(on.retrievalProvider!.name).toBe("deterministic-local");
  });

  it("reasoningRetrievalOptions reads env (default off → no provider)", () => {
    expect(reasoningRetrievalOptions({})).toEqual({ retrievalMode: "off" });
    expect(reasoningRetrievalOptions({ [REASONING_RETRIEVAL_ENV]: "on" }).retrievalMode).toBe("on");
  });
});
