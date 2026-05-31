/**
 * Defect #2 fix: inferred (silent-path) outcomes participate in calibration.
 *
 *  - maybeRefitCalibrator works WITHOUT a live server (persist-only): the fitted
 *    model is saved so the next boot serves it.
 *  - applyInferenceAndEmit triggers a refit when an inferred outcome lands and
 *    policy allows it (the Stop-hook path no longer starves the calibrator).
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import { BlockServer } from "../../src/core/block-serving.js";
import { maybeRefitCalibrator } from "../../src/lifecycle/calibrator-refit.js";
import { loadBlockCalibrator, BLOCK_CALIBRATOR_NAME } from "../../src/lifecycle/calibrator.js";
import { applyInferenceAndEmit } from "../../src/runtime/attribution-inference.js";
import { ingestPattern, type ReasoningPatternDTO } from "../../src/ingest/pattern-dto.js";
import type { IsotonicModel } from "../../src/lifecycle/isotonic.js";

function makeStore(): BlockStore {
  return new BlockStore(new Database(":memory:"));
}

/** Seed N helpful (injection ∧ agent_used ∧ outcome) triples on evidenceConfidence. */
function seedHelpful(store: BlockStore, blockId: string, n: number, conf = 0.8): void {
  for (let i = 0; i < n; i++) {
    const q = `q-${i}`;
    store.appendEvent({ ts: 100 + i, queryId: q, event: "injection", blockId, score: conf, evidenceConfidence: conf, featureVersion: 1 });
    store.appendEvent({ ts: 101 + i, queryId: q, event: "agent_used", blockId, matchSignal: "explicit", matchScore: 1, evidenceStrength: "explicit" });
    store.appendEvent({ ts: 102 + i, queryId: q, event: "outcome", resolved: true, control: false });
  }
}

describe("inferred-outcome calibration refit", () => {
  it("maybeRefitCalibrator persists a model with NO live server (server optional)", () => {
    const store = makeStore();
    seedHelpful(store, "blk-1", 20);
    const out = maybeRefitCalibrator({ store, refitThreshold: 1, now: () => 10_000 });
    expect(out.status).toBe("refit");
    // Persisted + servable on next boot (featureVersion-guarded).
    const model = store.loadCalibrator<IsotonicModel>(BLOCK_CALIBRATOR_NAME);
    expect(model?.featureVersion).toBe(1);
    expect(loadBlockCalibrator(store)).not.toBe(undefined);
  });

  it("applyInferenceAndEmit triggers a refit when an inferred outcome lands", () => {
    const store = makeStore();
    // Pre-seed enough evidence so the triggered fit can actually produce a model.
    seedHelpful(store, "seed-blk", 20);

    // A real injected block + its injection event (recall emits one).
    const dto: ReasoningPatternDTO = {
      schemaVersion: 1,
      pattern: {
        situation: "deadlock when two coroutines await each other holding the same lock",
        mechanism: "both coroutines hold the lock and await the other, so neither can proceed",
        deadEnds: [],
        unlock: "acquire the locks in a consistent global order before awaiting",
        verification: "the deadlock no longer reproduces under the stress test",
      },
      provenance: { sourceType: "runtime", capturedAt: 1, captureVersion: "v1" },
    };
    const ing = ingestPattern(store, dto);
    const server = new BlockServer(store);
    const r = server.recall({ text: "deadlock two coroutines await each other holding the same lock" });
    expect(r.shouldInject).toBe(true);
    expect(r.blocks.find((h) => h.passesGate)!.block.id).toBe(ing.blockId);

    // Transcript echoes the block's reasoning → jaccard infers the use.
    const transcript =
      "I hit a deadlock when two coroutines await each other holding the same lock. " +
      "Both coroutines hold the lock and await the other so neither can proceed. " +
      "I acquired the locks in a consistent global order before awaiting and it resolved.";
    const report = applyInferenceAndEmit(store, transcript, { allowOutcomeEmission: true, refitThreshold: 1 });

    expect(report.outcomeEmitted).toBeGreaterThanOrEqual(1);
    // The inferred outcome triggered a refit (no live server → persist-only).
    expect(report.refit).toBeDefined();
    expect(report.refit!.status).toBe("refit");
  });

  it("refitOnOutcome:false suppresses the refit", () => {
    const store = makeStore();
    seedHelpful(store, "seed-blk", 20);
    const dto: ReasoningPatternDTO = {
      schemaVersion: 1,
      pattern: {
        situation: "flaky test passes locally but fails in ci due to timezone assumptions",
        mechanism: "the test asserts a local-time format that ci renders in utc",
        deadEnds: [],
        unlock: "pin the timezone in the test setup before formatting",
        verification: "the test passes in both local and ci timezones",
      },
      provenance: { sourceType: "runtime", capturedAt: 1, captureVersion: "v1" },
    };
    ingestPattern(store, dto);
    new BlockServer(store).recall({ text: "flaky test passes locally but fails in ci timezone assumptions" });
    const transcript =
      "The flaky test passes locally but fails in ci due to timezone assumptions. " +
      "The test asserts a local-time format that ci renders in utc. " +
      "I pinned the timezone in the test setup before formatting.";
    const report = applyInferenceAndEmit(store, transcript, { allowOutcomeEmission: true, refitOnOutcome: false });
    expect(report.refit).toBeUndefined();
  });
});
