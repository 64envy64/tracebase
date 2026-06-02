/**
 * Runtime two-view query-compiler rollout resolver (Router V2, Phase D.1).
 *
 *   TRACEBASE_REASONING_QUERY_COMPILER = off | shadow
 *
 *   off    (DEFAULT) → candidate generation is UNCHANGED (byte-identical); the
 *                      compiler is never invoked.
 *   shadow           → serve the existing path UNCHANGED, but ALSO compile the
 *                      two views and compute the sparse / literal-hybrid /
 *                      literal+causal candidate slates side-by-side (V4 over
 *                      each), persisting a local-only comparison event.
 *
 * There is intentionally NO production `on`: the causal candidate lane must be
 * proven on frozen + organic shadow evidence (does it lift recall without
 * raising FP?) before it ever changes served candidate generation. Read once at
 * BlockServer construction (mirrors the other rollout axes).
 */

export type QueryCompilerRolloutMode = "off" | "shadow";

export const REASONING_QUERY_COMPILER_ENV = "TRACEBASE_REASONING_QUERY_COMPILER";

export interface QueryCompilerModeResolution {
  mode: QueryCompilerRolloutMode;
  diagnostics: string[];
}

/** Resolve the query-compiler rollout mode. Default off; `on` is rejected (not yet allowed). */
export function resolveReasoningQueryCompilerMode(env: NodeJS.ProcessEnv = process.env): QueryCompilerModeResolution {
  const raw = env[REASONING_QUERY_COMPILER_ENV];
  if (raw === undefined || raw === "") return { mode: "off", diagnostics: [] };
  const v = raw.trim().toLowerCase();
  if (v === "off") return { mode: "off", diagnostics: [] };
  if (v === "shadow") return { mode: "shadow", diagnostics: [`${REASONING_QUERY_COMPILER_ENV}=shadow`] };
  if (v === "on") {
    return { mode: "off", diagnostics: [`${REASONING_QUERY_COMPILER_ENV}="on" not permitted (causal lane is shadow-only); using off`] };
  }
  return { mode: "off", diagnostics: [`${REASONING_QUERY_COMPILER_ENV}="${raw}" ignored (expected off|shadow); using off`] };
}

export interface QueryCompilerRolloutOptions {
  queryCompilerMode: QueryCompilerRolloutMode;
}

/** BlockServer option fragment for the query-compiler rollout. */
export function reasoningQueryCompilerOptions(env: NodeJS.ProcessEnv = process.env): QueryCompilerRolloutOptions {
  return { queryCompilerMode: resolveReasoningQueryCompilerMode(env).mode };
}
