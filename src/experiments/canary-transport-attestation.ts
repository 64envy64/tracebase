/**
 * Canary transport-parity ATTESTATION (Phase D.4.2).
 *
 * The preflight receipt cannot honestly *probe* at runtime that the canary rail
 * is wired identically through every transport — that is a build-time property,
 * proven by the parity test-suite, not something a single process can observe.
 * So we attest it explicitly and versioned: this constant is the claim, and the
 * parity tests (`tests/server/canary-transport-parity.test.ts` +
 * `tests/server/canary-smoke-matrix.test.ts`) are the evidence that backs it.
 *
 * The receipt records `transportParityVersion` and reports the check as
 * BUILD-TIME EVIDENCE, never as a live probe. Bump `version` only together with
 * a parity-test change that re-proves the claim; `canary-transport-attestation.test.ts`
 * guards that the version + transport list here match what the suite proves.
 */

/** The transports the canary rail is attested to engage identically through. */
export const CANARY_TRANSPORT_PARITY = {
  /** Bump in lockstep with a parity-test change that re-proves the claim. */
  version: 1,
  /** Every transport that funnels through the one shared D.4.1 boundary. */
  transports: ["mcp", "inject-context-hook", "sdk-contextual-runtime"] as const,
  /** How the claim is substantiated — honest provenance, not a runtime probe. */
  evidence: "build-time-parity-tests" as const,
} as const;

export type CanaryTransport = (typeof CANARY_TRANSPORT_PARITY)["transports"][number];

/**
 * True iff `version` is the current attested parity version. The receipt's
 * `transportParity` check is exactly this — a build-time attestation match, not
 * a runtime probe. A future build that bumps the attestation without the matching
 * parity-test change is caught by the attestation guard test, not here.
 */
export function isTransportParityAttested(version: number): boolean {
  return version === CANARY_TRANSPORT_PARITY.version;
}
