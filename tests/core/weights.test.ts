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
});
