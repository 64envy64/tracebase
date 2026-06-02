import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import {
  BLOCK_CALIBRATOR_NAME,
  fitCalibratorFromEvents,
  fitAndSaveBlockCalibrator,
  loadBlockCalibrator,
  isotonicCalibrator,
  identityBlockCalibrator,
} from "../../src/lifecycle/calibrator.js";
import { predictIsotonic } from "../../src/lifecycle/isotonic.js";
import { BlockServer } from "../../src/core/block-serving.js";
import { SERVING_FEATURE_VERSION } from "../../src/core/serving-confidence.js";
import { createBlock } from "../../src/core/block.js";
import type { ReasoningBlock, StoreBlockInput } from "../../src/types.js";

function makeStore(): BlockStore {
  return new BlockStore(new Database(":memory:"));
}

function activeBlock(store: BlockStore, sample: StoreBlockInput): ReasoningBlock {
  const b = createBlock(sample);
  b.status = "candidate";
  store.storeBlock(b);
  store.attachCaseRef({
    blockId: b.id, traceId: `trace-${b.id}`, role: "origin", evidenceQuality: "strong",
  });
  return store.updateBlockStatus(b.id, "active")!;
}

const SAMPLE: StoreBlockInput = {
  trigger: {
    situation: "metaclass inspect isfunction misses properties",
    invariants: { language: "python", framework: "astropy" },
  },
  body: {
    mechanism: "descriptors not functions", deadEnds: [],
    unlock: "use isdatadescriptor", verification: "docstrings inherit",
  },
  provenance: {
    sourceTaskId: "t-1", extractedFrom: "trajectory", distilledBy: "llm",
  },
};

/** Seed n training events: score uniformly spaced, helpful iff score ≥ threshold. */
function seedTrainingEvents(
  store: BlockStore,
  blockId: string,
  n: number,
  helpfulThreshold = 0.7,
): void {
  for (let i = 0; i < n; i++) {
    const score = i / (n - 1); // 0, ..., 1
    const qid = `q${i}`;
    // Retrieval (so the event-log is well-formed and perBlock rollups work).
    store.appendEvent({
      ts: 100 + i * 10,
      queryId: qid,
      event: "retrieval",
      candidates: [{ blockId, score }],
      shadow: false,
    });
    store.appendEvent({
      ts: 101 + i * 10,
      queryId: qid,
      event: "injection",
      blockId,
      score,
      // Post-migration the calibrator trains on the evidence signal; mirror
      // the seeded `score` as evidenceConfidence so the x-domain is preserved.
      evidenceConfidence: score,
      featureVersion: SERVING_FEATURE_VERSION,
    });
    const resolved = score >= helpfulThreshold;
    if (resolved) {
      store.appendEvent({
        ts: 102 + i * 10,
        queryId: qid,
        event: "agent_used",
        blockId,
        matchSignal: "jaccard",
        matchScore: 0.5,
      });
    }
    store.appendEvent({
      ts: 103 + i * 10,
      queryId: qid,
      event: "outcome",
      resolved,
      control: false,
    });
  }
}

/**
 * Seed exactly `total` events at one fixed score, of which `helpfulCount`
 * are helpful (injection + agent_used + resolved). Useful when a test
 * needs the trained curve to pool a known average at a known x.
 */
function seedEventsAtScore(
  store: BlockStore,
  blockId: string,
  score: number,
  total: number,
  helpfulCount: number,
  qidPrefix: string,
  baseTs: number = 100_000,
): void {
  for (let i = 0; i < total; i++) {
    const qid = `${qidPrefix}-${i}`;
    const ts = baseTs + i * 10;
    store.appendEvent({
      ts, queryId: qid, event: "retrieval",
      candidates: [{ blockId, score }], shadow: false,
    });
    store.appendEvent({
      ts: ts + 1, queryId: qid, event: "injection",
      blockId, score, evidenceConfidence: score, featureVersion: SERVING_FEATURE_VERSION,
    });
    const helpful = i < helpfulCount;
    if (helpful) {
      store.appendEvent({
        ts: ts + 2, queryId: qid, event: "agent_used",
        blockId, matchSignal: "jaccard", matchScore: 0.5,
      });
    }
    store.appendEvent({
      ts: ts + 3, queryId: qid, event: "outcome",
      resolved: helpful, control: false,
    });
  }
}

// ---------------------------------------------------------------------------
// fitCalibratorFromEvents
// ---------------------------------------------------------------------------

describe("fitCalibratorFromEvents", () => {
  let store: BlockStore;
  beforeEach(() => { store = makeStore(); });

  it("returns null when sample is below minSample", () => {
    const b = activeBlock(store, SAMPLE);
    seedTrainingEvents(store, b.id, 3);
    expect(fitCalibratorFromEvents(store, { minSample: 10 })).toBeNull();
  });

  it("fits a model when sample is sufficient", () => {
    const b = activeBlock(store, SAMPLE);
    seedTrainingEvents(store, b.id, 30);
    const model = fitCalibratorFromEvents(store, { minSample: 10 });
    expect(model).not.toBeNull();
    expect(model!.n).toBe(30);
    expect(model!.breakpoints.length).toBeGreaterThan(0);
  });

  it("produces a monotone curve that reflects the underlying signal", () => {
    const b = activeBlock(store, SAMPLE);
    // Score ≥ 0.7 resolves; below doesn't. Calibrated P(helpful) should
    // be much higher at score = 1 than at score = 0.
    seedTrainingEvents(store, b.id, 40, 0.7);
    const model = fitCalibratorFromEvents(store, { minSample: 10 })!;
    expect(predictIsotonic(model, 1.0)).toBeGreaterThan(predictIsotonic(model, 0.0));
    expect(predictIsotonic(model, 0.95)).toBeGreaterThan(0.4);
    expect(predictIsotonic(model, 0.05)).toBeLessThan(0.4);
  });

  it("counts only (injection ∧ agent_used ∧ resolved) as helpful — neutral cases are 0-labeled", () => {
    const b = activeBlock(store, SAMPLE);
    // Build a degenerate case: every injection resolves, but agent_used
    // only fires on half. The half that agent_used + resolved = helpful;
    // the other half = neutral (counted as y=0 in training).
    for (let i = 0; i < 20; i++) {
      const qid = `q${i}`;
      store.appendEvent({
        ts: 100 + i * 10, queryId: qid, event: "retrieval",
        candidates: [{ blockId: b.id, score: 0.8 }], shadow: false,
      });
      store.appendEvent({
        ts: 101 + i * 10, queryId: qid, event: "injection",
        blockId: b.id, score: 0.8,
      });
      if (i % 2 === 0) {
        store.appendEvent({
          ts: 102 + i * 10, queryId: qid, event: "agent_used",
          blockId: b.id, matchSignal: "jaccard", matchScore: 0.5,
        });
      }
      store.appendEvent({
        ts: 103 + i * 10, queryId: qid, event: "outcome",
        resolved: true, control: false,
      });
    }
    const model = fitCalibratorFromEvents(store, { minSample: 10 })!;
    // Exactly half helpful; single-x data → single pool block at 0.5.
    expect(predictIsotonic(model, 0.8)).toBeCloseTo(0.5, 1);
  });

  it("skips injections whose queryId has no outcome", () => {
    const b = activeBlock(store, SAMPLE);
    // 20 injections; only 5 have outcomes.
    for (let i = 0; i < 20; i++) {
      const qid = `q${i}`;
      store.appendEvent({
        ts: 100 + i * 10, queryId: qid, event: "retrieval",
        candidates: [{ blockId: b.id, score: 0.5 }], shadow: false,
      });
      store.appendEvent({
        ts: 101 + i * 10, queryId: qid, event: "injection",
        blockId: b.id, score: 0.5,
      });
      if (i < 5) {
        store.appendEvent({
          ts: 103 + i * 10, queryId: qid, event: "outcome",
          resolved: false, control: false,
        });
      }
    }
    const model = fitCalibratorFromEvents(store, { minSample: 3 });
    // Only 5 pairs survived.
    expect(model?.n).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe("calibrator persistence", () => {
  it("save / load round-trips via BlockStore", () => {
    const store = makeStore();
    const b = activeBlock(store, SAMPLE);
    seedTrainingEvents(store, b.id, 30);
    const saved = fitAndSaveBlockCalibrator(store, { minSample: 10 })!;
    expect(saved).not.toBeNull();

    const loaded = store.loadCalibrator(BLOCK_CALIBRATOR_NAME) as typeof saved;
    expect(loaded).toEqual(saved);
    expect(loaded.breakpoints).toEqual(saved.breakpoints);
  });

  it("loadBlockCalibrator returns identity when no model has been fitted", () => {
    const store = makeStore();
    const calibrator = loadBlockCalibrator(store);
    // Identity clamps to [0,1]; for a score in range it should pass through.
    expect(calibrator(0.42, {} as ReasoningBlock)).toBeCloseTo(0.42);
    // Out-of-range clamps.
    expect(calibrator(1.5, {} as ReasoningBlock)).toBe(1);
    expect(calibrator(-0.5, {} as ReasoningBlock)).toBe(0);
  });

  it("loadBlockCalibrator returns an isotonic wrap once a model exists", () => {
    const store = makeStore();
    const b = activeBlock(store, SAMPLE);
    seedTrainingEvents(store, b.id, 30);
    fitAndSaveBlockCalibrator(store, { minSample: 10 });

    const calibrator = loadBlockCalibrator(store);
    // Identity would return 0.5 for score=0.5; isotonic should return
    // a value that reflects the trained signal (not necessarily 0.5).
    const identityValue = 0.5;
    const calibratedValue = calibrator(0.5, {} as ReasoningBlock);
    // Bounded in [0,1].
    expect(calibratedValue).toBeGreaterThanOrEqual(0);
    expect(calibratedValue).toBeLessThanOrEqual(1);
    // With our training (score ≥ 0.7 → helpful), at score=0.5 the calibrated
    // output should be closer to 0 than to 1.
    expect(calibratedValue).toBeLessThan(identityValue);
  });

  it("overwrite semantics: re-fitting saves under the same name", () => {
    const store = makeStore();
    const b = activeBlock(store, SAMPLE);
    seedTrainingEvents(store, b.id, 30);
    const first = fitAndSaveBlockCalibrator(store, { minSample: 10 })!;
    // Add more events; the second fit should have higher n.
    seedTrainingEvents(store, b.id, 30);
    const second = fitAndSaveBlockCalibrator(store, { minSample: 10 })!;
    expect(second.n).toBeGreaterThan(first.n);

    const listed = store.listCalibratorNames();
    expect(listed.length).toBe(1);
    expect(listed[0].name).toBe(BLOCK_CALIBRATOR_NAME);
  });

  it("deleteCalibrator removes the row", () => {
    const store = makeStore();
    const b = activeBlock(store, SAMPLE);
    seedTrainingEvents(store, b.id, 30);
    fitAndSaveBlockCalibrator(store, { minSample: 10 });
    expect(store.deleteCalibrator(BLOCK_CALIBRATOR_NAME)).toBe(true);
    expect(store.loadCalibrator(BLOCK_CALIBRATOR_NAME)).toBeNull();
  });

  it("loadCalibrator returns null for a missing model", () => {
    const store = makeStore();
    expect(store.loadCalibrator("nope")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isotonicCalibrator wrapper + serving integration
// ---------------------------------------------------------------------------

describe("isotonicCalibrator + BlockServer", () => {
  it("wrapping an IsotonicModel produces a Calibrator that matches predictIsotonic (clamped)", () => {
    const store = makeStore();
    const b = activeBlock(store, SAMPLE);
    seedTrainingEvents(store, b.id, 30);
    const model = fitCalibratorFromEvents(store, { minSample: 10 })!;
    const calibrator = isotonicCalibrator(model);
    for (const x of [0, 0.25, 0.5, 0.75, 1.0]) {
      const direct = Math.max(0, Math.min(1, predictIsotonic(model, x)));
      const wrapped = calibrator(x, {} as ReasoningBlock);
      expect(wrapped).toBeCloseTo(direct);
    }
  });

  it("BlockServer uses the loaded calibrator to shape calibratedProb", () => {
    const store = makeStore();
    const b = activeBlock(store, SAMPLE);
    // Training: at score=0.5, 0% helpful. At score=1.0, 50% helpful.
    // Isotonic pools: (0.5, 0.0) and (1.0, 0.5). Identity at x=1.0 → 1.0.
    seedEventsAtScore(store, b.id, 0.5, 20, 0, "low");
    seedEventsAtScore(store, b.id, 1.0, 20, 10, "high");
    fitAndSaveBlockCalibrator(store, { minSample: 10 });

    const calibrator = loadBlockCalibrator(store);

    const identityServer = new BlockServer(store, {
      calibrator: identityBlockCalibrator, emitEvents: false,
    });
    const calibratedServer = new BlockServer(store, { calibrator, emitEvents: false });

    const identityResult = identityServer.recall({ text: "metaclass inspect" });
    const calibratedResult = calibratedServer.recall({ text: "metaclass inspect" });
    // Post-migration: calibratedProb = calibrate(evidenceConfidence), NOT the
    // legacy always-1.0 normalized rank score. A strong two-token match yields
    // high (but sub-1.0) evidence; identity passes it through, while the trained
    // curve — which pooled only half-helpful at the high end — drags it down.
    const identityProb = identityResult.blocks[0]!.calibratedProb;
    const trainedProb = calibratedResult.blocks[0]!.calibratedProb;
    expect(identityProb).toBeGreaterThan(0.5);
    expect(identityProb).toBeLessThan(1);
    expect(trainedProb).toBeLessThan(identityProb);
    expect(trainedProb).toBeGreaterThan(0);
  });

  it("a strict gate + trained calibrator rejects a block that identity would pass", () => {
    const store = makeStore();
    const b = activeBlock(store, SAMPLE);
    // Training: at score=1.0, only 2 of 20 are helpful → isotonic(1.0) ≈ 0.1.
    seedEventsAtScore(store, b.id, 1.0, 20, 2, "top");
    // Add a lower-score anchor so the curve isn't degenerate (single block).
    seedEventsAtScore(store, b.id, 0.5, 20, 0, "low");
    fitAndSaveBlockCalibrator(store, { minSample: 10 });
    const calibrator = loadBlockCalibrator(store);

    const server = new BlockServer(store, {
      calibrator,
      gateThreshold: 0.5, // identity would always pass (score=1.0 ≥ 0.5);
                          // calibrator should drag to 0.1 < 0.5.
      emitEvents: false,
    });
    const result = server.recall({ text: "metaclass inspect" });
    expect(result.blocks.length).toBeGreaterThan(0);
    const hit = result.blocks[0];
    expect(hit.calibratedProb).toBeLessThan(0.5);
    expect(hit.passesGate).toBe(false);
    expect(result.shouldInject).toBe(false);
  });
});
