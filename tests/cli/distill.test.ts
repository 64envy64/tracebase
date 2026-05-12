/**
 * `tracebase distill` — unit tests for the pure helpers.
 *
 * The CLI itself wires Anthropic SDK + DistillationPipeline + BlockStore,
 * which is mostly integration glue. We don't drive the full Anthropic
 * path here — that would require either a real API key or a non-trivial
 * SDK shim. Instead we cover the two exported helpers that turn a
 * stored block into a distillation input + render the pipeline's
 * rejection codes, plus one end-to-end pipeline run with the in-tree
 * `MockDistiller` so the same trace shape that powers the CLI gets
 * exercised against the real pipeline.
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import { createBlock } from "../../src/core/block.js";
import { DistillationPipeline } from "../../src/distillation/pipeline.js";
import { MockDistiller } from "../../src/distillation/llm-distiller.js";
import {
  traceFromBlock,
  describeRejection,
} from "../../src/cli/commands/distill.js";

function storedBlock() {
  // Same insertion path the rest of the suite uses: candidate insert →
  // attach origin ref → promote to active. The store rejects direct
  // "active" inserts without an origin ref, so the shortcut path
  // would fail with BlockIntegrityError.
  const db = new Database(":memory:");
  const store = new BlockStore(db);
  const block = createBlock({
    trigger: {
      situation: "CORS preflight failing on Express because OPTIONS handler missing",
      invariants: { language: "typescript", framework: "express" },
    },
    body: {
      mechanism: "browser sends OPTIONS for cross-origin POST with custom headers",
      deadEnds: ["adding Access-Control-Allow-Origin header only"],
      unlock: "Add explicit app.options('*', cors()) before route definitions",
      verification: "Re-issue cross-origin POST from devtools — preflight returns 204",
    },
    provenance: { sourceTaskId: "t-1", extractedFrom: "trajectory", distilledBy: "rule" },
  });
  block.status = "candidate";
  store.storeBlock(block);
  store.attachCaseRef({
    blockId: block.id,
    traceId: "trace-distill-fixture",
    role: "origin",
    evidenceQuality: "strong",
  });
  const promoted = store.updateBlockStatus(block.id, "active")!;
  return { db, store, block: promoted };
}

describe("traceFromBlock", () => {
  it("maps block.trigger.situation into problem.description and computes a fingerprint", () => {
    const { db, store, block } = storedBlock();
    try {
      const trace = traceFromBlock(block);
      expect(trace.problem.description).toBe(block.trigger.situation);
      expect(trace.problem.fingerprint).toMatch(/^[a-f0-9]{16,}/);
      // Invariants pass-through.
      expect(trace.problem.language).toBe("typescript");
      expect(trace.problem.framework).toBe("express");
    } finally {
      store.close();
      db.close();
    }
  });

  it("preserves solution structure: unlock → summary, three SolutionStep types", () => {
    const { db, store, block } = storedBlock();
    try {
      const trace = traceFromBlock(block);
      expect(trace.solution.summary).toBe(block.body.unlock);
      expect(trace.solution.outcome).toBe("success");
      expect(trace.solution.steps.map((s) => s.type)).toEqual([
        "analysis",
        "action",
        "verification",
      ]);
      expect(trace.solution.steps[0].description).toBe(block.body.mechanism);
      expect(trace.solution.steps[1].description).toBe(block.body.unlock);
      expect(trace.solution.steps[2].description).toBe(block.body.verification);
    } finally {
      store.close();
      db.close();
    }
  });

  it("synthetic trace id is namespaced so events can distinguish replays from first-pass captures", () => {
    const { db, store, block } = storedBlock();
    try {
      const trace = traceFromBlock(block);
      expect(trace.id).toMatch(/^distill-from-/);
      expect(trace.metadata.agent).toBe("tracebase-distill-cli");
      expect(trace.metadata.source).toBe("block-upgrade");
    } finally {
      store.close();
      db.close();
    }
  });
});

describe("traceFromBlock → DistillationPipeline (mock distiller)", () => {
  it("feeds a synthesized trace through the pipeline and lands a result", async () => {
    const { db, store, block } = storedBlock();
    try {
      const trace = traceFromBlock(block);
      const distiller = new MockDistiller({
        trigger: {
          situation: "Re-extracted: missing OPTIONS handler causes CORS preflight to 404",
          invariants: { language: "typescript", framework: "express" },
        },
        body: {
          mechanism: "preflight is a separate request; without OPTIONS route the server 404s",
          deadEnds: ["only allowing the origin header"],
          unlock: "Register app.options('*', cors()) before route mounting",
          verification: "Curl --request OPTIONS against the endpoint returns 204",
        },
        distillationConfidence: 0.8,
      });
      const pipeline = new DistillationPipeline({ store, distiller });
      const result = await pipeline.distillTrace(trace);
      // Either stored (different fingerprint) or merged (same one). Both
      // are legitimate outcomes for the upgrade path.
      expect(["stored", "merged"]).toContain(result.status);
    } finally {
      store.close();
      db.close();
    }
  });
});

describe("describeRejection", () => {
  it("renders each rejection kind without throwing", () => {
    expect(describeRejection({ kind: "unsupported-outcome", outcome: "failure" })).toMatch(
      /outcome/,
    );
    expect(describeRejection({ kind: "no-unlock-step" })).toMatch(/unlock/);
    expect(describeRejection({ kind: "no-failure-step" })).toMatch(/failure/);
    expect(
      describeRejection({
        kind: "llm-error",
        message: "boom",
        distillerKind: "parse-error",
      }),
    ).toMatch(/parse-error/);
    expect(
      describeRejection({ kind: "low-confidence", confidence: 0.3, threshold: 0.5 }),
    ).toMatch(/0\.30/);
    expect(
      describeRejection({ kind: "validation-failed", failures: ["leakage", "schema"] }),
    ).toMatch(/leakage, schema/);
  });
});
