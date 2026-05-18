import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import {
  loadWeightState,
  saveWeightState,
  computeWeights,
  computeWeightsMean,
  sampleWeights,
  seededRng,
  updateWeights,
} from "../../src/core/weights.js";
import type { AdaptiveWeightState, SimilaritySignals } from "../../src/types.js";

function testDbPath(): string {
  return join(tmpdir(), `tracebase-weights-test-${randomUUID()}.db`);
}

describe("Adaptive Weights (Thompson Sampling)", () => {
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    dbPath = testDbPath();
    db = new Database(dbPath);
    db.exec("CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  });

  afterEach(() => {
    db.close();
    try { unlinkSync(dbPath); } catch { /* ok */ }
  });

  it("loads default state when no data exists", () => {
    const state = loadWeightState(db);
    expect(state.bm25.alpha).toBe(5);
    expect(state.bm25.beta).toBe(5);
    expect(state.jaccard.alpha).toBe(3);
    expect(state.jaccard.beta).toBe(7);
    expect(state.feedbackCount).toBe(0);
  });

  it("persists and loads state", () => {
    const state = loadWeightState(db);
    state.bm25.alpha = 10;
    state.feedbackCount = 5;
    saveWeightState(db, state);

    const reloaded = loadWeightState(db);
    expect(reloaded.bm25.alpha).toBe(10);
    expect(reloaded.feedbackCount).toBe(5);
  });

  it("computes normalized weights from Beta posteriors", () => {
    const state = loadWeightState(db);
    const weights = computeWeights(state);

    // Weights must sum to 1.0 (bm25 + jaccard + structural + freshness, no cosine)
    expect(weights.bm25 + weights.jaccard + weights.structural + weights.freshness).toBeCloseTo(1.0);

    // BM25 should have the highest weight (alpha/total = 5/10 = 0.5)
    expect(weights.bm25).toBeGreaterThan(weights.jaccard);
    expect(weights.jaccard).toBeGreaterThan(weights.structural);
  });

  it("shifts weights toward helpful signals", () => {
    let state = loadWeightState(db);
    const before = computeWeights(state);

    // Simulate repeated positive feedback where jaccard contributed heavily
    const signals: SimilaritySignals = {
      fingerprint: 0,
      bm25: 0.1,
      jaccard: 0.9,
      structural: 0.1,
      cosine: 0,
      freshness: 0.5,
    };

    for (let i = 0; i < 20; i++) {
      state = updateWeights(db, state, signals, true);
    }

    const after = computeWeights(state);

    // Jaccard weight should have increased
    expect(after.jaccard).toBeGreaterThan(before.jaccard);
    // BM25 weight should have decreased (relatively)
    expect(after.bm25).toBeLessThan(before.bm25);
  });

  it("shifts weights away from unhelpful signals", () => {
    let state = loadWeightState(db);
    const before = computeWeights(state);

    // Simulate negative feedback where structural was the primary signal
    const signals: SimilaritySignals = {
      fingerprint: 0,
      bm25: 0.1,
      jaccard: 0.1,
      structural: 0.9,
      cosine: 0,
      freshness: 0.5,
    };

    for (let i = 0; i < 20; i++) {
      state = updateWeights(db, state, signals, false);
    }

    const after = computeWeights(state);

    // Structural weight should have decreased
    expect(after.structural).toBeLessThan(before.structural);
  });

  it("tracks feedback count", () => {
    let state = loadWeightState(db);
    const signals: SimilaritySignals = {
      fingerprint: 0, bm25: 0.5, jaccard: 0.3, structural: 0.2, cosine: 0, freshness: 0.5,
    };

    state = updateWeights(db, state, signals, true);
    state = updateWeights(db, state, signals, false);
    state = updateWeights(db, state, signals, true);

    expect(state.feedbackCount).toBe(3);
  });

  it("weights remain stable with balanced feedback", () => {
    let state = loadWeightState(db);
    const before = computeWeights(state);

    // Equal positive and negative feedback with uniform signals
    const signals: SimilaritySignals = {
      fingerprint: 0, bm25: 0.5, jaccard: 0.5, structural: 0.5, cosine: 0, freshness: 0.5,
    };

    for (let i = 0; i < 50; i++) {
      state = updateWeights(db, state, signals, i % 2 === 0);
    }

    const after = computeWeights(state);

    // Weights should stay close to initial (prior dominates with balanced feedback)
    expect(Math.abs(after.bm25 - before.bm25)).toBeLessThan(0.1);
    expect(Math.abs(after.jaccard - before.jaccard)).toBeLessThan(0.1);
  });

  // --------------------------------------------------------------------
  // May-2026 PR 2 — real Thompson Sampling.
  //
  // `computeWeightsMean` returns posterior means (deterministic).
  // `sampleWeights` draws fresh from each Beta posterior — used by the
  // recall path so under-explored signals still get pulled.
  // --------------------------------------------------------------------

  describe("sampleWeights — Thompson Sampling", () => {
    it("is deterministic under a seeded RNG", () => {
      const state = loadWeightState(db);
      const a = sampleWeights(state, false, seededRng(42));
      const b = sampleWeights(state, false, seededRng(42));
      expect(a.bm25).toBeCloseTo(b.bm25, 10);
      expect(a.jaccard).toBeCloseTo(b.jaccard, 10);
      expect(a.structural).toBeCloseTo(b.structural, 10);
      expect(a.freshness).toBeCloseTo(b.freshness, 10);
    });

    it("produces different draws under different seeds", () => {
      const state = loadWeightState(db);
      const a = sampleWeights(state, false, seededRng(1));
      const b = sampleWeights(state, false, seededRng(2));
      // At least one signal must differ; otherwise sampling is trivially broken.
      const anyDiff =
        a.bm25 !== b.bm25 ||
        a.jaccard !== b.jaccard ||
        a.structural !== b.structural ||
        a.freshness !== b.freshness;
      expect(anyDiff).toBe(true);
    });

    it("draws sum to 1 across active signals", () => {
      const state = loadWeightState(db);
      // 100 random seeds; every draw must sum to exactly 1 over active signals.
      for (let seed = 0; seed < 100; seed++) {
        const w = sampleWeights(state, false, seededRng(seed));
        const sum = w.bm25 + w.jaccard + w.structural + w.cosine + w.freshness;
        expect(sum).toBeCloseTo(1.0, 6);
        // hasEmbeddings=false → cosine must be exactly 0.
        expect(w.cosine).toBe(0);
      }
    });

    it("includes cosine when hasEmbeddings=true", () => {
      const state = loadWeightState(db);
      const w = sampleWeights(state, true, seededRng(1));
      expect(w.cosine).toBeGreaterThan(0);
      const sum = w.bm25 + w.jaccard + w.structural + w.cosine + w.freshness;
      expect(sum).toBeCloseTo(1.0, 6);
    });

    it("sampled mean ≈ posterior mean under large α+β (Monte Carlo convergence)", () => {
      // Mutate the in-memory state directly instead of going through
      // `updateWeights` per-step — this is a pure-math test about
      // `sampleWeights`, no need to involve SQLite I/O.
      const state = loadWeightState(db);
      // Tighten every posterior heavily so draws concentrate near mean.
      for (const k of ["bm25", "jaccard", "structural", "cosine", "freshness"] as const) {
        state[k].alpha += 150;
        state[k].beta += 50;
      }

      const mean = computeWeightsMean(state);

      const n = 2000;
      const acc = { bm25: 0, jaccard: 0, structural: 0, cosine: 0, freshness: 0 };
      const rng = seededRng(12345);
      for (let i = 0; i < n; i++) {
        const w = sampleWeights(state, false, rng);
        acc.bm25 += w.bm25;
        acc.jaccard += w.jaccard;
        acc.structural += w.structural;
        acc.freshness += w.freshness;
      }
      const avg = {
        bm25: acc.bm25 / n,
        jaccard: acc.jaccard / n,
        structural: acc.structural / n,
        freshness: acc.freshness / n,
      };
      // 0.05 tolerance: the normalized-Beta-ratio Monte Carlo converges
      // slower than raw Beta mean, but with n=2000 + tightened posterior
      // we're comfortably inside this band.
      expect(Math.abs(avg.bm25 - mean.bm25)).toBeLessThan(0.05);
      expect(Math.abs(avg.jaccard - mean.jaccard)).toBeLessThan(0.05);
      expect(Math.abs(avg.structural - mean.structural)).toBeLessThan(0.05);
      expect(Math.abs(avg.freshness - mean.freshness)).toBeLessThan(0.05);
    });

    it("exploration shrinks as feedback accrues (sample variance decreases)", () => {
      function bm25Variance(state: AdaptiveWeightState, n: number): number {
        const samples: number[] = [];
        for (let i = 0; i < n; i++) {
          samples.push(sampleWeights(state, false, seededRng(i + 7919)).bm25);
        }
        const mean = samples.reduce((a, b) => a + b, 0) / n;
        return samples.reduce((acc, x) => acc + (x - mean) ** 2, 0) / n;
      }

      const fresh = loadWeightState(db);
      const varFresh = bm25Variance(fresh, 500);

      // Skip the `updateWeights` round-trip; mutate the posterior
      // directly to simulate "lots of aligned helpful feedback".
      const trained = loadWeightState(db);
      trained.bm25.alpha += 400; // 400 helpful pulls on bm25
      const varTrained = bm25Variance(trained, 500);

      expect(varTrained).toBeLessThan(varFresh);
    });
  });

  describe("computeWeights deprecation alias", () => {
    it("returns the same values as computeWeightsMean (back-compat)", () => {
      const state = loadWeightState(db);
      const legacy = computeWeights(state);
      const renamed = computeWeightsMean(state);
      expect(legacy.bm25).toBeCloseTo(renamed.bm25, 10);
      expect(legacy.jaccard).toBeCloseTo(renamed.jaccard, 10);
      expect(legacy.structural).toBeCloseTo(renamed.structural, 10);
      expect(legacy.cosine).toBeCloseTo(renamed.cosine, 10);
      expect(legacy.freshness).toBeCloseTo(renamed.freshness, 10);
    });
  });
});
