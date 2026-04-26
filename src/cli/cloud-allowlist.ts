/**
 * Cloud metrics allowlist + sanitizer.
 *
 * Single-source gate for what tracebase-ai is allowed to send to the
 * hosted control plane in *metrics mode* — the default (and today,
 * only) cloud surface. Every outbound sample passes through
 * `sanitizeForCloud()` before the fetch call. A forbidden key that
 * slips into the local aggregation path lands here and gets stripped,
 * even if a future refactor accidentally bubbled prompt / path /
 * statement content into the sample object.
 *
 * Shape of an allowlist entry:
 *   - `true`  → primitive leaf. Only string / number / boolean / null
 *               / arrays-of-primitives survive at this position.
 *               Object-shaped values are rejected (return `undefined`)
 *               so a future field that starts carrying user content
 *               never silently ships.
 *   - `AllowlistSpec` → nested object spec, recurse. Every field the
 *               control plane expects is listed explicitly down to
 *               primitive leaves.
 *
 * Everything not listed is dropped silently. The sanitizer is pure,
 * deterministic, and never throws — telemetry must never break a
 * user's CLI run.
 *
 * PLAN-0.5 §7 is the authoritative catalogue of what may ship; this
 * file's exported spec is the implementation of that list.
 *
 * NOTE: an earlier revision of this file used `topBlockHits: true` /
 * `topFactHits: true` as permissive leaves that copied every nested
 * key of the value verbatim. Those keys never existed in the real
 * `UsageMetrics` type — they were planning-phase placeholders — and
 * the leaf-copy mode masked the problem by allowing arbitrary
 * nesting. Both are removed; if those aggregates ever ship they get
 * an explicit nested spec here first.
 */

export type AllowlistSpec = {
  [key: string]: true | AllowlistSpec;
};

/**
 * Leaf spec for `UsageEstimate` — a small value/sampleSize/formula
 * triple. `formula` is a short programmatic string (e.g.
 * `"mean(holdout.tokens) − mean(assisted.tokens)"`) the dashboard
 * renders verbatim in a tooltip; it's constructed from known inputs,
 * not user prompts, so it ships. If that ever changes the spec here
 * changes first.
 */
const USAGE_ESTIMATE_SPEC: AllowlistSpec = {
  value: true,
  sampleSize: true,
  formula: true,
};

/** Leaf spec for `UsageCohort`. Counts + rate only. */
const USAGE_COHORT_SPEC: AllowlistSpec = {
  n: true,
  resolved: true,
  resolvedRate: true,
};

/**
 * Eight-family normalised tool vocabulary the cloud allowlist
 * permits. Literal Claude tool names (`Read`, `Grep`, `Bash`, …)
 * are mapped LOCALLY (`src/runtime/tool-family.ts`) before any
 * count is added to this aggregate; an unknown family slot in the
 * input is dropped at sanitiser time.
 */
const TOOL_FAMILY_SPEC: AllowlistSpec = {
  read: true,
  search: true,
  shell: true,
  edit: true,
  write: true,
  web: true,
  task: true,
  other: true,
};

/**
 * Finite enumerable error-class set — names mirror
 * `LEAKAGE_PATTERNS_EXTENDED` in `src/core/guard.ts`. Counts only;
 * the matched substring is never read by the aggregator and never
 * reaches the wire.
 */
const ERROR_CLASS_SPEC: AllowlistSpec = {
  "abs-path-posix": true,
  "abs-path-windows": true,
  "bearer-token": true,
  "api-key-anthropic": true,
  "api-key-github": true,
  "api-key-sk": true,
  "env-line": true,
};

/**
 * 0.5.4 §6 — TB TOOL / TB LOOP aggregate spec. Counts only; never
 * `arg_key` / `arg_summary` / `tool_use_id` / `session_id` / raw
 * tool names.
 */
const USAGE_TOOL_BATCH_SPEC: AllowlistSpec = {
  duplicateCount: true,
  loopCount: true,
  toolFamilyCounts: TOOL_FAMILY_SPEC,
  errorClassCounts: ERROR_CLASS_SPEC,
};

// ---------------------------------------------------------------------------
// 0.7.0-rc.1 — per-event-kind aggregate specs (PLAN-0.7 §rc.1 Ground).
//
// Each new analytics event (file_index.*, file_memory.*,
// tool_supervision.*, loop.*, context.*, store.injection_rejected,
// cache.prompt_hit) ships to the cloud as counts + closed-enum
// histograms only. Anything keyed by a free-form path / id / pattern
// name is either summed into a single count or dropped entirely.
//
// All these aggregates live under `metrics.mechanisms` so they can
// land in one envelope without proliferating top-level keys; that
// shape is locked by the cloud-allowlist test below.
// ---------------------------------------------------------------------------

/**
 * Closed enum: the prompt-injection guard's named patterns from
 * `src/core/guard.ts`. Counts only; the matched substring is never
 * read by the aggregator and never reaches the wire.
 */
const INJECTION_PATTERN_SPEC: AllowlistSpec = {
  "role-override": true,
  "persona-flip": true,
  "system-spoof": true,
  "delimiter-spoof": true,
  "exfil-prompt": true,
  "tool-coercion": true,
};

/** Closed enum: reasons a context-fold step skipped a chunk. */
const FOLD_SKIP_REASON_SPEC: AllowlistSpec = {
  "no-new-turns": true,
  "hash-collision": true,
  "leakage": true,
  "injection": true,
  "below-threshold": true,
};

/** Closed enum: anchor kinds the loop redirector emits. */
const LOOP_KIND_SPEC: AllowlistSpec = {
  block: true,
  file: true,
};

/** Closed enum: prompt-cache surfaces (Anthropic / OpenAI today). */
const CACHE_SURFACE_SPEC: AllowlistSpec = {
  anthropic: true,
  openai: true,
};

const USAGE_FILE_INDEX_SPEC: AllowlistSpec = {
  // Window-summed counts. `summarizer` is a closed enum so the
  // primitive leaf accepts only the three documented values
  // (heuristic / embedding / llm); any other string at this leaf
  // still passes the leaf-copy check, but later aggregator code
  // emits only the enum values, so a malformed leaf surfaces in
  // the planted-PII test below.
  completedCount: true,
  bytesSummarized: true,
  durationMs: true,
  summarizer: true,
  pending: true,
  skippedCount: true,
  // NOTE: `byReason` is intentionally omitted. The skip reason set
  // is open-ended (binary / too-large / gitignore / unparseable /
  // future reasons) and we don't want a permissive object-leaf
  // here. The total `skippedCount` is enough signal for the
  // dashboard; an enumerated reason histogram can land later
  // behind its own explicit closed-enum spec.
};

const USAGE_FILE_MEMORY_SPEC: AllowlistSpec = {
  recallCount: true,
  tokensInjected: true,
  bytesAvoided: true,
};

const USAGE_TOOL_SUPERVISION_SPEC: AllowlistSpec = {
  warnCount: true,
  suppressedCount: true,
  byFamily: TOOL_FAMILY_SPEC,
};

const USAGE_LOOP_REDIRECT_SPEC: AllowlistSpec = {
  redirectCount: true,
  fallbackCount: true,
  byKind: LOOP_KIND_SPEC,
};

const USAGE_CONTEXT_FOLD_SPEC: AllowlistSpec = {
  chunkCount: true,
  tokensBeforeSum: true,
  tokensAfterSum: true,
  skipCount: true,
  byReason: FOLD_SKIP_REASON_SPEC,
};

const USAGE_INJECTION_REJECTED_SPEC: AllowlistSpec = {
  rejectCount: true,
  byPattern: INJECTION_PATTERN_SPEC,
};

const USAGE_PROMPT_CACHE_SPEC: AllowlistSpec = {
  hitCount: true,
  tokensSavedSum: true,
  bySurface: CACHE_SURFACE_SPEC,
};

/**
 * Composite spec for `metrics.mechanisms.*`. One nested object per
 * event-kind family. Adding a new family means an explicit nested
 * spec here AND a regression case in `tests/cli/cloud-allowlist.test.ts`
 * — same contract as the rest of the allowlist.
 */
const USAGE_MECHANISMS_SPEC: AllowlistSpec = {
  fileIndex: USAGE_FILE_INDEX_SPEC,
  fileMemory: USAGE_FILE_MEMORY_SPEC,
  toolSupervision: USAGE_TOOL_SUPERVISION_SPEC,
  loopRedirect: USAGE_LOOP_REDIRECT_SPEC,
  contextFold: USAGE_CONTEXT_FOLD_SPEC,
  injectionRejected: USAGE_INJECTION_REJECTED_SPEC,
  promptCache: USAGE_PROMPT_CACHE_SPEC,
};

/**
 * The single allowlist tracebase-ai cloud sync writes against. Every
 * other path that hits the hosted API should pipe its payload through
 * `sanitizeForCloud(payload, USAGE_SAMPLE_ALLOWLIST)` before sending.
 *
 * Adding a new field means:
 *   (a) explicit addition here, all the way down to primitive leaves,
 *   (b) a regression entry in tests/cli/cloud-allowlist.test.ts.
 * Both are required; a field without both doesn't ship.
 */
export const USAGE_SAMPLE_ALLOWLIST: AllowlistSpec = {
  // Envelope-level fields the control-plane uses for routing /
  // idempotency. No user content.
  installationId: true,
  windowStart: true,
  windowEnd: true,
  cliVersion: true,

  // The UsageMetrics body — mirrored against the actual
  // `src/analytics/usage-metrics.ts` type definitions. Each nested
  // object has its own explicit spec down to primitive leaves, so
  // a future refactor that bubbles a text field up (prompt,
  // statement, path, blockId, factId, mechanism) cannot reach the
  // wire without editing this spec first.
  metrics: {
    scope: true,
    window: {
      afterTs: true,
      beforeTs: true,
    },
    observed: {
      eligibleRuns: true,
      recalledRuns: true,
      injectedRuns: true,
      usedRuns: true,
      helpfulRuns: true,
      resolvedRateWithMemory: true,
    },
    estimated: {
      tokensSaved: USAGE_ESTIMATE_SPEC,
      latencySavedMs: USAGE_ESTIMATE_SPEC,
      // 0.6.1 — heuristic estimated savings. Counts × constant;
      // never user content. The formula string is constructed
      // from the constant and the function name only.
      heuristicTokensSaved: USAGE_ESTIMATE_SPEC,
      heuristicLatencySavedMs: USAGE_ESTIMATE_SPEC,
    },
    causal: {
      assisted: USAGE_COHORT_SPEC,
      holdout: USAGE_COHORT_SPEC,
      resolvedLift: true,
      tokensLift: USAGE_ESTIMATE_SPEC,
      latencyLift: USAGE_ESTIMATE_SPEC,
      minCohortSize: true,
    },
    integrity: {
      shadowControlMismatches: true,
      outcomesWithoutRetrieval: true,
    },
    // 0.5.4 — TB TOOL / TB LOOP aggregates. Optional: only
    // present when `tool_observations` rows exist for the window.
    toolBatch: USAGE_TOOL_BATCH_SPEC,
    // 0.5.7 §C — token-economy primitives. Both are integers
    // (counts), never user content. `netTokenImpact` may be `null`
    // when cohort < threshold; the sanitiser treats `null` as a
    // valid primitive leaf.
    netTokenImpact: true,
    totalInjectedTokensEstimate: true,
    // 0.7.0-rc.1 — per-event-kind aggregate buckets. Each nested
    // family object is primitive-only at every leaf; free-form ids
    // / paths / argKeys / pattern matches never make it past the
    // sanitiser. See USAGE_MECHANISMS_SPEC above for the catalogue.
    mechanisms: USAGE_MECHANISMS_SPEC,
  },
};

/**
 * Deep-copy `value` through the allowlist. Forbidden keys are
 * omitted; forbidden nested shapes are dropped. Arrays of primitives
 * are kept as-is; arrays that contain any object element at a
 * `true` leaf are rejected whole (arrays-of-objects need an explicit
 * element spec — described in the `AllowlistSpec` contract).
 *
 * The function never reads properties of null / undefined, never
 * invokes getters beyond plain property access, and caps nesting at
 * `MAX_DEPTH` to break any cycles.
 */
export function sanitizeForCloud<T>(value: T, spec: AllowlistSpec = USAGE_SAMPLE_ALLOWLIST): Partial<T> {
  return deepPick(value, spec, 0) as Partial<T>;
}

const MAX_DEPTH = 16;

function deepPick(value: unknown, spec: AllowlistSpec | true, depth: number): unknown {
  if (depth > MAX_DEPTH) return undefined;
  if (value === null || value === undefined) return value;

  // `true` leaf: primitive-only contract. Objects dropped. Arrays
  // retained only if every element is a primitive. This is the
  // tightening documented in the file header — prior versions used
  // a recursive copyLeaf that silently widened the surface.
  if (spec === true) {
    return copyPrimitiveLeaf(value);
  }

  if (Array.isArray(value)) {
    // Array at a non-leaf position: the spec describes each element.
    return value
      .map((el) => deepPick(el, spec, depth + 1))
      .filter((el) => el !== undefined);
  }

  if (typeof value !== "object") return undefined; // primitives at nested spec → drop

  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, subSpec] of Object.entries(spec)) {
    if (!(k in src)) continue;
    const picked = deepPick(src[k], subSpec, depth + 1);
    if (picked !== undefined) out[k] = picked;
  }
  return out;
}

/**
 * Primitive-only leaf copier. Accepts: string / number / boolean /
 * null / undefined, and arrays whose elements are all primitives.
 * Rejects (returns undefined): any object shape, any array
 * containing even one object element.
 *
 * The strictness is intentional. If a future metric legitimately
 * wants to ship an object at a `true` leaf, it needs an explicit
 * nested `AllowlistSpec` first — that's the whole point of the
 * allowlist, and the tightening this module's header calls out.
 */
function copyPrimitiveLeaf(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return value;
  if (Array.isArray(value)) {
    for (const el of value) {
      if (el === null || el === undefined) continue;
      const et = typeof el;
      if (et !== "string" && et !== "number" && et !== "boolean") return undefined;
    }
    return [...value];
  }
  // Objects, functions, symbols, bigints — not shippable at a leaf.
  return undefined;
}
