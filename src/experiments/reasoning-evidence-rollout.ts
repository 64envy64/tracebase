/**
 * ServingEvidenceV3 rollout resolver (Router V2, Phase C.2).
 *
 *   TRACEBASE_REASONING_EVIDENCE = off | shadow
 *
 *   off    (DEFAULT) → serve the existing V1/V2 decision; V3 never computed.
 *   shadow           → serve the existing decision UNCHANGED, but ALSO compute
 *                      the experimental V3 semantic-license decision side-by-side
 *                      and persist a local-only comparison event.
 *
 * There is intentionally NO production `on`: V3's semantic-license lane must be
 * proven on frozen + organic shadow evidence before it is ever served. Read once
 * at BlockServer construction (mirrors the other rollout axes).
 */

export type EvidenceRolloutMode = "off" | "shadow";

export const REASONING_EVIDENCE_ENV = "TRACEBASE_REASONING_EVIDENCE";

export interface EvidenceModeResolution {
  mode: EvidenceRolloutMode;
  diagnostics: string[];
}

/** Resolve the evidence rollout mode. Default off; `on` is rejected (not yet allowed). */
export function resolveReasoningEvidenceMode(env: NodeJS.ProcessEnv = process.env): EvidenceModeResolution {
  const raw = env[REASONING_EVIDENCE_ENV];
  if (raw === undefined || raw === "") return { mode: "off", diagnostics: [] };
  const v = raw.trim().toLowerCase();
  if (v === "off") return { mode: "off", diagnostics: [] };
  if (v === "shadow") return { mode: "shadow", diagnostics: [`${REASONING_EVIDENCE_ENV}=shadow`] };
  if (v === "on") {
    return { mode: "off", diagnostics: [`${REASONING_EVIDENCE_ENV}="on" not permitted (V3 is shadow-only); using off`] };
  }
  return { mode: "off", diagnostics: [`${REASONING_EVIDENCE_ENV}="${raw}" ignored (expected off|shadow); using off`] };
}

export interface EvidenceRolloutOptions {
  evidenceMode: EvidenceRolloutMode;
}

/** BlockServer option fragment for the evidence rollout. */
export function reasoningEvidenceOptions(env: NodeJS.ProcessEnv = process.env): EvidenceRolloutOptions {
  return { evidenceMode: resolveReasoningEvidenceMode(env).mode };
}
