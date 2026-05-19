import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import { BlockServer } from "../../src/core/block-serving.js";
import { createBlock } from "../../src/core/block.js";
import {
  BLOCK_CALIBRATOR_NAME,
  identityBlockCalibrator,
} from "../../src/lifecycle/calibrator.js";
import { maybeRefitCalibrator } from "../../src/lifecycle/calibrator-refit.js";
import type { IsotonicModel } from "../../src/lifecycle/isotonic.js";
import type { ReasoningBlock, StoreBlockInput } from "../../src/types.js";

function makeStore(): BlockStore {
  return new BlockStore(new Database(":memory:"));
}

const SAMPLE: StoreBlockInput = {
  trigger: {
    situation: "drift refit smoke",
    invariants: { language: "typescript" },
  },
  body: {
    mechanism: "fit on outcome arrival", deadEnds: [],
    unlock: "auto-refit hook", verification: "vitest",
  },
  provenance: {
    sourceTaskId: "t-1", extractedFrom: "trajectory", distilledBy: "llm",
  },
};

function activeBlock(store: BlockStore): ReasoningBlock {
  const b = createBlock(SAMPLE);
  b.status = "candidate";
  store.storeBlock(b);
  store.attachCaseRef({
    blockId: b.id, traceId: `trace-${b.id}`, role: "origin", evidenceQuality: "strong",
  });
  return store.updateBlockStatus(b.id, "active")!;
}

/** Helper: write a (retrieval, injection, agent_used?, outcome) quadruple. */
function seedRun(
  store: BlockStore,
  blockId: string,
  qid: string,
  score: number,
  helpful: boolean,
  ts: number,
): void {
  store.appendEvent({
    ts, queryId: qid, event: "retrieval",
    candidates: [{ blockId, score }], shadow: false,
  });
  store.appendEvent({
    ts: ts + 1, queryId: qid, event: "injection",
    blockId, score,
  });
  if (helpful) {
    store.appendEvent({
      ts: ts + 2, queryId: qid, event: "agent_used",
      blockId, matchSignal: "explicit", matchScore: 1,
    });
  }
  store.appendEvent({
    ts: ts + 3, queryId: qid, event: "outcome",
    resolved: helpful, control: false,
  });
}

describe("maybeRefitCalibrator", () => {
  let store: BlockStore;
  let server: BlockServer;
  let block: ReasoningBlock;

  beforeEach(() => {
    store = makeStore();
    server = new BlockServer(store, { emitEvents: false });
    block = activeBlock(store);
  });

  it("skips when no fresh outcomes have landed", () => {
    const r = maybeRefitCalibrator({ store, server });
    expect(r.status).toBe("skipped");
    if (r.status === "skipped") expect(r.reason).toBe("below-threshold");
  });

  it("skips when below the threshold", () => {
    for (let i = 0; i < 5; i++) {
      seedRun(store, block.id, `q${i}`, 0.5, i % 2 === 0, 1000 + i * 10);
    }
    const r = maybeRefitCalibrator({ store, server, refitThreshold: 20 });
    expect(r.status).toBe("skipped");
    if (r.status === "skipped") {
      expect(r.reason).toBe("below-threshold");
      expect(r.freshOutcomes).toBe(5);
    }
  });

  it("fits and hot-swaps the calibrator once the threshold is crossed", () => {
    // 25 outcomes with a clean monotone relationship: helpful iff score ≥ 0.6.
    for (let i = 0; i < 25; i++) {
      const score = i / 24;
      seedRun(store, block.id, `q${i}`, score, score >= 0.6, 1000 + i * 10);
    }
    // Before refit: identity calibration. A score of 0.2 maps to ~0.2.
    expect(identityBlockCalibrator(0.2, block)).toBeCloseTo(0.2, 5);

    const r = maybeRefitCalibrator({
      store, server, refitThreshold: 20, now: () => 50_000,
    });
    expect(r.status).toBe("refit");
    if (r.status === "refit") {
      expect(r.freshOutcomes).toBe(25);
      expect(r.fittedAt).toBe(50_000);
    }

    // Persisted model has the expected sample size.
    const persisted = store.loadCalibrator<IsotonicModel>(BLOCK_CALIBRATOR_NAME);
    expect(persisted).not.toBeNull();
    expect(persisted!.n).toBe(25);

    // The calibrator_refit event was emitted.
    const events = store.readEvents({ limit: 1000 });
    const refitEvents = events.filter((e) => e.event === "calibrator_refit");
    expect(refitEvents).toHaveLength(1);
    expect((refitEvents[0]! as { freshOutcomes: number }).freshOutcomes).toBe(25);
  });

  it("resets the fresh-outcome counter after a successful refit", () => {
    // First batch lands and triggers a refit.
    for (let i = 0; i < 25; i++) {
      const score = i / 24;
      seedRun(store, block.id, `q1-${i}`, score, score >= 0.6, 1000 + i * 10);
    }
    const first = maybeRefitCalibrator({
      store, server, refitThreshold: 20, now: () => 50_000,
    });
    expect(first.status).toBe("refit");

    // Add 5 more outcomes — below threshold relative to the new fit time.
    for (let i = 0; i < 5; i++) {
      seedRun(store, block.id, `q2-${i}`, 0.5, true, 60_000 + i * 10);
    }
    const second = maybeRefitCalibrator({
      store, server, refitThreshold: 20, now: () => 70_000,
    });
    expect(second.status).toBe("skipped");
    if (second.status === "skipped") {
      expect(second.reason).toBe("below-threshold");
      // The counter sees only the 5 outcomes that landed AFTER the first
      // refit's fittedAt, not the 25 the first batch contributed.
      expect(second.freshOutcomes).toBe(5);
    }
  });

  it("reports insufficient-sample when outcomes exist but no matching injections do", () => {
    // 25 raw outcome events with no injection pair — no training data.
    for (let i = 0; i < 25; i++) {
      store.appendEvent({
        ts: 1000 + i * 10, queryId: `lone-${i}`, event: "outcome",
        resolved: true, control: false,
      });
    }
    const r = maybeRefitCalibrator({ store, server, refitThreshold: 20 });
    expect(r.status).toBe("skipped");
    if (r.status === "skipped") expect(r.reason).toBe("insufficient-sample");
  });
});
