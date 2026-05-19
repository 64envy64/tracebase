/**
 * Contextual bandit tests — May-2026 B2.
 *
 * Pins three contracts:
 *   1. Cold-start safety: new buckets sample with the global posterior's
 *      mean (so unknown contexts behave like pre-B2).
 *   2. Per-context divergence: a heavily-observed bucket diverges from
 *      global toward its own data.
 *   3. Persistence + bucket key normalization round-trips.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import {
  bucketKeyFor,
  DEFAULT_BUCKET_STRENGTH,
  loadContextualBandit,
  loadContextualState,
  meanContextualWeights,
  sampleContextualWeights,
  updateContextualWeights,
} from "../../src/core/contextual-bandit.js";
import {
  computeWeightsMean,
  loadWeightState,
  seededRng,
} from "../../src/core/weights.js";
import type { SimilaritySignals } from "../../src/types.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec("CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
});

afterEach(() => {
  db.close();
});

describe("bucketKeyFor — normalization", () => {
  it("lowercases each dimension and joins with `|`", () => {
    expect(bucketKeyFor({ language: "Python", framework: "FastAPI", errorType: "TypeError" }))
      .toBe("python|fastapi|typeerror");
  });

  it("collapses missing fields to a single `_` sentinel", () => {
    expect(bucketKeyFor({})).toBe("_|_|_");
    expect(bucketKeyFor({ language: "rust" })).toBe("rust|_|_");
    expect(bucketKeyFor({ framework: "react" })).toBe("_|react|_");
  });

  it("treats whitespace-only as missing (defensive against junk input)", () => {
    expect(bucketKeyFor({ language: "  ", framework: "" })).toBe("_|_|_");
  });

  it("treats undefined and empty context as the same bucket", () => {
    expect(bucketKeyFor(undefined)).toBe(bucketKeyFor({}));
  });
});

describe("sampleContextualWeights — cold-start safety", () => {
  it("an unobserved bucket samples around the global posterior mean", () => {
    const global = loadWeightState(db);
    const contextual = loadContextualState(db);
    const globalMean = computeWeightsMean(global, /*hasEmbeddings*/ false);
    // 500 draws on a fresh bucket — Monte Carlo mean should approach
    // the global posterior mean (within Beta sampling noise).
    const ctx = { language: "kotlin" };
    const rng = seededRng(42);
    const N = 500;
    const acc = { bm25: 0, jaccard: 0, structural: 0, freshness: 0 };
    for (let i = 0; i < N; i++) {
      const w = sampleContextualWeights(global, contextual, ctx, { rng });
      acc.bm25 += w.bm25;
      acc.jaccard += w.jaccard;
      acc.structural += w.structural;
      acc.freshness += w.freshness;
    }
    expect(acc.bm25 / N).toBeCloseTo(globalMean.bm25, 1);
    expect(acc.jaccard / N).toBeCloseTo(globalMean.jaccard, 1);
    expect(acc.structural / N).toBeCloseTo(globalMean.structural, 1);
    expect(acc.freshness / N).toBeCloseTo(globalMean.freshness, 1);
  });

  it("two unseen buckets sample similarly (no spurious divergence at zero obs)", () => {
    const global = loadWeightState(db);
    const contextual = loadContextualState(db);
    // Different buckets, but neither has observations. Sample means
    // should agree within Monte Carlo noise.
    const rng1 = seededRng(7);
    const rng2 = seededRng(7);
    const out1 = sampleContextualWeights(global, contextual, { language: "java" }, { rng: rng1 });
    const out2 = sampleContextualWeights(global, contextual, { language: "rust" }, { rng: rng2 });
    // With the same seed and identical effective posteriors, the
    // draws must be IDENTICAL (the bucket key changes but the Beta
    // posterior parameters do not).
    expect(out1).toEqual(out2);
  });
});

describe("sampleContextualWeights — per-bucket divergence on real evidence", () => {
  it("two buckets with opposing evidence diverge from each other (cross-bucket divergence)", () => {
    // The right shape for "bucket diverges from global" is to compare
    // TWO buckets — global moves under everything in unison, but each
    // bucket only sees its own evidence. Bucket A says "bm25 always
    // helps me"; bucket B says "bm25 always hurts me". After 200
    // observations each, the per-bucket bm25 means should be far apart.
    const global = loadWeightState(db);
    let contextual = loadContextualState(db);
    const ctxA = { language: "python", errorType: "AssertionError" };
    const ctxB = { language: "rust" };
    const sig: SimilaritySignals = {
      fingerprint: 0, bm25: 1, jaccard: 0, structural: 0, cosine: 0, freshness: 0,
    };
    for (let i = 0; i < 200; i++) {
      let out = updateContextualWeights(db, global, contextual, ctxA, sig, true);
      contextual = out.contextual;
      out = updateContextualWeights(db, global, contextual, ctxB, sig, false);
      contextual = out.contextual;
    }
    const meanA = meanContextualWeights(global, contextual, ctxA);
    const meanB = meanContextualWeights(global, contextual, ctxB);
    // Bucket A should heavily weight bm25; bucket B should down-weight it.
    expect(meanA.bm25).toBeGreaterThan(meanB.bm25 + 0.1);
  });

  it("an over-observed bucket diverges from a never-touched bucket on the same signal", () => {
    // The pseudo-"unseen" bucket samples from the global prior; the
    // observed one diverges according to its own evidence. After 200
    // helpful pulls keyed on bm25 in bucket A, bucket A's bm25 mean
    // should be meaningfully higher than fresh bucket Z's.
    const global = loadWeightState(db);
    let contextual = loadContextualState(db);
    const ctxA = { language: "python", errorType: "AssertionError" };
    const ctxZ = { language: "kotlin" }; // never touched
    const sig: SimilaritySignals = {
      fingerprint: 0, bm25: 1, jaccard: 0, structural: 0, cosine: 0, freshness: 0,
    };
    for (let i = 0; i < 200; i++) {
      const out = updateContextualWeights(db, global, contextual, ctxA, sig, true);
      contextual = out.contextual;
    }
    const meanA = meanContextualWeights(global, contextual, ctxA);
    const meanZ = meanContextualWeights(global, contextual, ctxZ);
    expect(meanA.bm25).toBeGreaterThan(meanZ.bm25 + 0.05);
  });

  it("shrinkage: a bucket with few observations deviates LESS than one with many", () => {
    // The defining property of empirical-Bayes shrinkage: under-
    // observed buckets stay close to the global prior, while
    // heavily-observed buckets dominate their own data. We verify
    // this by comparing the SAME SIGNAL's bucket mean across two
    // observation counts on independent buckets, against the
    // global-mean reference point.
    const fewCtx = { language: "tcl" }; // 3 observations
    const heavyCtx = { language: "ocaml" }; // 200 observations
    const sig: SimilaritySignals = {
      fingerprint: 0, bm25: 1, jaccard: 0, structural: 0, cosine: 0, freshness: 0,
    };

    // Run independent histories in separate DBs so the global state
    // doesn't get cross-contaminated between the two buckets.
    function deviationAfter(obsCount: number, ctx: { language: string }): number {
      const localDb = new Database(":memory:");
      localDb.exec("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      try {
        const g = loadWeightState(localDb);
        let c = loadContextualState(localDb);
        for (let i = 0; i < obsCount; i++) {
          c = updateContextualWeights(localDb, g, c, ctx, sig, true).contextual;
        }
        const gm = computeWeightsMean(g, false);
        const bm = meanContextualWeights(g, c, ctx);
        return Math.abs(bm.bm25 - gm.bm25);
      } finally {
        localDb.close();
      }
    }

    const fewDev = deviationAfter(3, fewCtx);
    const heavyDev = deviationAfter(200, heavyCtx);
    // The 200-obs bucket must show meaningfully larger divergence
    // than the 3-obs bucket — that IS the shrinkage property.
    expect(heavyDev).toBeGreaterThan(fewDev * 2);
  });
});

describe("updateContextualWeights — both layers move", () => {
  it("persists bucket observations + bumps global posterior together", () => {
    const global = loadWeightState(db);
    let contextual = loadContextualState(db);
    const ctx = { language: "rust" };
    const sig: SimilaritySignals = {
      fingerprint: 0, bm25: 1, jaccard: 0, structural: 0, cosine: 0, freshness: 0,
    };

    const beforeGlobalBm25 = global.bm25.alpha;
    const beforeBucket = contextual.buckets[bucketKeyFor(ctx)];
    expect(beforeBucket).toBeUndefined(); // not allocated yet

    const out = updateContextualWeights(db, global, contextual, ctx, sig, true);
    expect(out.global.bm25.alpha).toBe(beforeGlobalBm25 + 1);
    expect(out.contextual.buckets[bucketKeyFor(ctx)]!.bm25.alphaObs).toBe(1);

    // Reload from disk — both layers must round-trip.
    const reloaded = loadContextualBandit(db);
    expect(reloaded.global.bm25.alpha).toBe(beforeGlobalBm25 + 1);
    expect(reloaded.contextual.buckets[bucketKeyFor(ctx)]!.bm25.alphaObs).toBe(1);
  });

  it("DEFAULT_BUCKET_STRENGTH is 10 (documented prior weight)", () => {
    expect(DEFAULT_BUCKET_STRENGTH).toBe(10);
  });
});

