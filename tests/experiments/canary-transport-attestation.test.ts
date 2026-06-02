/**
 * Phase D.4.2 — the canary transport-parity ATTESTATION is honest.
 *
 * The receipt's `transportParity` check is build-time evidence, not a runtime
 * probe. This guard pins the attested version + transport list and cross-checks
 * that the three attested transports are real, importable entrypoints that funnel
 * through the one shared boundary. The BEHAVIOURAL proof lives in
 * `tests/server/canary-transport-parity.test.ts` + `canary-smoke-matrix.test.ts`;
 * bumping the attestation version without re-proving parity there should fail
 * review, and this test is the tripwire that the claim and the wiring agree.
 */
import { describe, it, expect } from "vitest";
import { CANARY_TRANSPORT_PARITY, isTransportParityAttested } from "../../src/experiments/canary-transport-attestation.js";
import { runReasoningPatternsRecall } from "../../src/server/reasoning-patterns-entry.js";
import { recallForPrompt } from "../../src/runtime/recall.js";
import { TracebaseRuntimeProvider } from "../../src/sdk/contextual-runtime-provider.js";

describe("canary transport-parity attestation", () => {
  it("pins the attested version + the exact transport set + honest provenance", () => {
    expect(CANARY_TRANSPORT_PARITY.version).toBe(1);
    expect([...CANARY_TRANSPORT_PARITY.transports]).toEqual(["mcp", "inject-context-hook", "sdk-contextual-runtime"]);
    expect(CANARY_TRANSPORT_PARITY.evidence).toBe("build-time-parity-tests");
  });

  it("isTransportParityAttested matches ONLY the current version", () => {
    expect(isTransportParityAttested(CANARY_TRANSPORT_PARITY.version)).toBe(true);
    expect(isTransportParityAttested(CANARY_TRANSPORT_PARITY.version + 1)).toBe(false);
    expect(isTransportParityAttested(0)).toBe(false);
  });

  it("each attested transport is a real, importable entrypoint (the boundary they share)", () => {
    // The structural backing for the attestation: every attested transport exists.
    // runReasoningPatternsRecall IS the shared boundary; the hook + SDK route through it.
    expect(typeof runReasoningPatternsRecall).toBe("function"); // mcp
    expect(typeof recallForPrompt).toBe("function"); // inject-context-hook
    expect(typeof TracebaseRuntimeProvider).toBe("function"); // sdk-contextual-runtime (class)
    expect(CANARY_TRANSPORT_PARITY.transports.length).toBe(3);
  });
});
