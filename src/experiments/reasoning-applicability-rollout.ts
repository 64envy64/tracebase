/**
 * Memory-applicability reranker rollout resolver (Router V2, Phase D.2).
 *
 *   TRACEBASE_REASONING_APPLICABILITY = off | shadow
 *
 *   off    (DEFAULT) → serving is UNCHANGED (byte-identical); the reranker is
 *                      never invoked.
 *   shadow           → serve the existing decision UNCHANGED, but ALSO run the
 *                      applicability reranker over the top-N family prototypes
 *                      after candidate generation and persist a local-only
 *                      V4-vs-reranker comparison event.
 *
 * There is intentionally NO production `on`: the §4.5 reranker must be proven on
 * frozen + organic shadow evidence (does it recover recall without precision
 * loss?) before it ever changes what is served. Read once at BlockServer
 * construction (mirrors the other rollout axes).
 */

export type ApplicabilityRolloutMode = "off" | "shadow";

export const REASONING_APPLICABILITY_ENV = "TRACEBASE_REASONING_APPLICABILITY";

export interface ApplicabilityModeResolution {
  mode: ApplicabilityRolloutMode;
  diagnostics: string[];
}

/** Resolve the applicability rollout mode. Default off; `on` is rejected (not yet allowed). */
export function resolveReasoningApplicabilityMode(env: NodeJS.ProcessEnv = process.env): ApplicabilityModeResolution {
  const raw = env[REASONING_APPLICABILITY_ENV];
  if (raw === undefined || raw === "") return { mode: "off", diagnostics: [] };
  const v = raw.trim().toLowerCase();
  if (v === "off") return { mode: "off", diagnostics: [] };
  if (v === "shadow") return { mode: "shadow", diagnostics: [`${REASONING_APPLICABILITY_ENV}=shadow`] };
  if (v === "on") {
    return { mode: "off", diagnostics: [`${REASONING_APPLICABILITY_ENV}="on" not permitted (reranker is shadow-only); using off`] };
  }
  return { mode: "off", diagnostics: [`${REASONING_APPLICABILITY_ENV}="${raw}" ignored (expected off|shadow); using off`] };
}

export interface ApplicabilityRolloutOptions {
  applicabilityMode: ApplicabilityRolloutMode;
}

/** BlockServer option fragment for the applicability rollout. */
export function reasoningApplicabilityOptions(env: NodeJS.ProcessEnv = process.env): ApplicabilityRolloutOptions {
  return { applicabilityMode: resolveReasoningApplicabilityMode(env).mode };
}
