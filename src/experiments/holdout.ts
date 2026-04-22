/**
 * Deterministic holdout assignment for Phase 3 causal comparison.
 *
 * TraceBase needs a treatment-vs-control split that:
 *
 *   1. Is the same decision for the same *problem shape*, not the
 *      same call. We key on the query fingerprint (sha-stable over
 *      language / framework / errorType / canonical tokens), never
 *      on the ephemeral `queryId`. Repeated attempts at an identical
 *      problem always land in the same cohort.
 *
 *   2. Is unbiased at any given rate. A 10% holdout should hold out
 *      ~10% of distinct fingerprints, uniformly across the hash
 *      space. Correctness here is what lets the dashboard compute a
 *      honest resolved-rate lift.
 *
 *   3. Is workspace-isolated. Two independent workspaces that share
 *      identical fingerprints must not share cohort assignments —
 *      otherwise one workspace's control arm contaminates another's
 *      inference. A per-workspace salt is mixed into the hash.
 *
 * The single entry point `shouldHoldOut(fingerprint, rate, salt)`
 * is pure and synchronous; callers compute the fingerprint once
 * (it already lives on the retrieval path) and pass it in.
 */
import { createHash } from "node:crypto";

/**
 * Return `true` iff the (fingerprint, salt) combination falls into
 * the holdout cohort at the given rate. Deterministic across process
 * restarts, machines, and Node versions.
 *
 * Contract:
 *   - `rate` is clamped. `rate <= 0` → always `false`.
 *     `rate >= 1` → always `true`. In particular, disabling the
 *     experiment (rate = 0) can never put a query in the holdout.
 *   - `fingerprint` and `salt` are treated as opaque strings. Empty
 *     `salt` is valid but strongly discouraged — use a per-workspace
 *     value so cross-workspace cohorts do not collide.
 *   - The hash is sha256 of `salt || "\0" || fingerprint`; the first
 *     4 bytes are interpreted as a uint32 and compared to
 *     `rate * 2^32`. Using a null byte as separator makes the
 *     two inputs unambiguous — `salt="a", fp="bc"` hashes differently
 *     from `salt="ab", fp="c"`.
 */
export function shouldHoldOut(
  fingerprint: string,
  rate: number,
  salt: string,
): boolean {
  if (!Number.isFinite(rate) || rate <= 0) return false;
  if (rate >= 1) return true;

  const hash = createHash("sha256");
  hash.update(salt, "utf8");
  hash.update(HOLDOUT_SEPARATOR);
  hash.update(fingerprint, "utf8");
  const digest = hash.digest();

  // First 4 bytes as a big-endian uint32 — treat as uniform on [0, 2^32).
  const n =
    (digest[0]! << 24) |
    (digest[1]! << 16) |
    (digest[2]! << 8) |
    digest[3]!;
  const unsigned = n >>> 0; // collapse into [0, 2^32)
  const threshold = rate * 0x1_0000_0000;
  return unsigned < threshold;
}

const HOLDOUT_SEPARATOR = Buffer.from([0x00]);

/**
 * Control-reason tag written onto a retrieval event when its query
 * landed in the experimental holdout cohort. See `RetrievalEvent`
 * in `src/types.ts` for the full contract; this constant is exposed
 * so serving / analytics sites cannot spell it differently.
 */
export const CONTROL_REASON_HOLDOUT = "holdout" as const;

/**
 * Control-reason tag for manual or legacy diagnostic shadow. Kept
 * as a named constant so analytics code can compare without magic
 * strings.
 */
export const CONTROL_REASON_SHADOW = "shadow" as const;
