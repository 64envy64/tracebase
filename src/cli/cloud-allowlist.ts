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
 *   - `true`  → leaf, value kept as-is (must be JSON-serialisable).
 *   - `AllowlistSpec` → nested object, recurse.
 *
 * Everything not in the spec is dropped silently. The sanitizer is
 * pure, deterministic, and never throws — telemetry must never break
 * a user's CLI run.
 *
 * PLAN-0.5 §7 is the authoritative catalogue of what may ship; this
 * file's exported spec is the implementation of that list.
 */

export type AllowlistSpec = {
  [key: string]: true | AllowlistSpec;
};

/**
 * The single allowlist tracebase-ai cloud sync writes against. Every
 * other path that hits the hosted API should pipe its payload through
 * `sanitizeForCloud(payload, USAGE_SAMPLE_ALLOWLIST)` before sending.
 *
 * Adding a new field means:
 *   (a) explicit addition here,
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

  // The UsageMetrics body. Each sub-object is allowlisted to the
  // named, numeric / enumerable fields only. Any free-form string
  // column (e.g. a future `description`) is blocked by default —
  // addition requires editing this spec first.
  metrics: {
    scope: true,
    window: {
      start: true,
      end: true,
    },
    observed: {
      queries: true,
      injectedQueries: true,
      factsInjected: true,
      usedQueries: true,
      outcomeQueries: true,
      resolvedQueries: true,
      usedRate: true,
      resolvedRate: true,
      shadowQueries: true,
      coverage: true,
      reuseByBlockKind: true,
      topBlockHits: true,
      topFactHits: true,
    },
    estimated: {
      tokensSaved: true,
      stepsSaved: true,
      durationSavedMs: true,
    },
    causal: {
      assisted: {
        n: true,
        resolved: true,
        resolvedRate: true,
      },
      holdout: {
        n: true,
        resolved: true,
        resolvedRate: true,
      },
      resolvedLift: true,
      tokensLift: true,
      latencyLift: true,
      minCohortSize: true,
    },
    integrity: {
      shadowGate: true,
      holdoutActive: true,
      holdoutRate: true,
      experimentSalt: true,
      windowStart: true,
      windowEnd: true,
    },
  },
};

/**
 * Deep-copy `value` through the allowlist. Forbidden keys are
 * omitted; forbidden nested shapes are replaced by an empty object
 * or dropped. Arrays are kept as arrays with each element recursed
 * against the same sub-spec (arrays in the metrics surface are all
 * "lists of objects with the same shape" — e.g. `topBlockHits[]`).
 *
 * The function never reads properties of null / undefined and never
 * invokes getters beyond plain property access. Circular references
 * are broken after 16 levels of nesting by returning `undefined`
 * (a cycle we'd never put in a JSON body anyway).
 */
export function sanitizeForCloud<T>(value: T, spec: AllowlistSpec = USAGE_SAMPLE_ALLOWLIST): Partial<T> {
  return deepPick(value, spec, 0) as Partial<T>;
}

const MAX_DEPTH = 16;

function deepPick(value: unknown, spec: AllowlistSpec | true, depth: number): unknown {
  if (depth > MAX_DEPTH) return undefined;
  if (value === null || value === undefined) return value;

  // Leaf: keep primitives as-is, recurse into arrays / objects.
  if (spec === true) {
    return copyLeaf(value, depth);
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

function copyLeaf(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return undefined;
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return value;
  if (Array.isArray(value)) {
    return value.map((el) => copyLeaf(el, depth + 1));
  }
  if (t === "object") {
    // At a `true` leaf, we keep the whole object but walk once to strip
    // any function / symbol values JSON wouldn't emit anyway.
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src)) {
      const copied = copyLeaf(v, depth + 1);
      if (copied !== undefined) out[k] = copied;
    }
    return out;
  }
  return undefined;
}
