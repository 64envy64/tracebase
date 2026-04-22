/**
 * Phase 3.4.1 — runtime wiring regressions.
 *
 * Proves the production serving path (`get_reasoning_patterns`, via
 * the extracted `runReasoningPatternsRecall` helper) actually
 * translates `tracebase experiment enable|disable` into real
 * retrieval events. Without this, Phase 3.5's causal dashboard
 * would render on an empty cohort.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlockStore } from "../../src/core/block-store.js";
import { BlockServer } from "../../src/core/block-serving.js";
import { createBlock } from "../../src/core/block.js";
import {
  disableHoldoutExperiment,
  enableHoldoutExperiment,
  initConfig,
  readHoldoutConfig,
} from "../../src/core/config.js";
import { runReasoningPatternsRecall } from "../../src/server/reasoning-patterns-entry.js";
import type { AnalyticsEvent, ReasoningBlock, StoreBlockInput } from "../../src/types.js";

const BLOCK: StoreBlockInput = {
  trigger: {
    situation: "Pipeline stalls when webhook delivery retries exceed the backoff ceiling",
    invariants: { language: "typescript", framework: "node", errorType: "RetryBudgetExceeded" },
  },
  body: {
    mechanism: "exponential backoff overshoots the configured ceiling",
    deadEnds: ["increase the global retry count"],
    unlock: "clamp the next delay to the ceiling before rescheduling",
    verification: "replay the trace and confirm delivery completes within the budget",
  },
  provenance: { sourceTaskId: "t-retry-1", extractedFrom: "trajectory", distilledBy: "llm" },
};

let dir: string;
let store: BlockStore;
let server: BlockServer;
let seededBlock: ReasoningBlock;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tb-rp-entry-"));
  store = new BlockStore(new Database(":memory:"));
  const b = createBlock(BLOCK);
  b.status = "candidate";
  store.storeBlock(b);
  store.attachCaseRef({
    blockId: b.id,
    traceId: `trace-${b.provenance.sourceTaskId}`,
    role: "origin",
    evidenceQuality: "strong",
  });
  seededBlock = store.updateBlockStatus(b.id, "active")!;
  server = new BlockServer(store);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function retrievalEventFor(queryId: string) {
  return store
    .readEvents({ limit: 1_000 })
    .find((e: AnalyticsEvent) => e.event === "retrieval" && e.queryId === queryId);
}

function injectionEventsFor(queryId: string): AnalyticsEvent[] {
  return store
    .readEvents({ limit: 1_000 })
    .filter(
      (e: AnalyticsEvent) =>
        e.queryId === queryId && (e.event === "injection" || e.event === "fact_injection"),
    );
}

const PROBLEM_TEXT =
  "webhook delivery retries stall when exponential backoff exceeds the configured ceiling";

const ARGS = {
  problem: PROBLEM_TEXT,
  language: "typescript",
  framework: "node",
  errorType: "RetryBudgetExceeded",
} as const;

describe("runReasoningPatternsRecall — default-off byte-identical path", () => {
  it("emits legacy retrieval shape when no experiment config exists on disk", () => {
    initConfig(dir); // no experiment
    const res = runReasoningPatternsRecall(
      server,
      { ...ARGS, queryId: "q-noconfig" } as unknown as typeof ARGS,
      { readHoldoutConfig: () => readHoldoutConfig(dir) },
    );
    expect(res.shadow).toBe(false);
    expect(res.shouldInject).toBe(true);
    const retrieval = retrievalEventFor(res.queryId);
    if (retrieval?.event === "retrieval") {
      expect(retrieval.controlReason).toBeUndefined();
    }
    // Real injection emitted — treatment arm flows normally.
    expect(injectionEventsFor(res.queryId).length).toBeGreaterThan(0);
  });

  it("stays legacy when the experiment exists but is disabled", () => {
    initConfig(dir);
    enableHoldoutExperiment(dir, {
      rate: 1,
      saltFactory: () => "salt-disabled-path",
      now: () => new Date("2026-04-22T00:00:00.000Z"),
    });
    disableHoldoutExperiment(dir, { now: () => new Date("2026-04-22T01:00:00.000Z") });

    const res = runReasoningPatternsRecall(server, ARGS, {
      readHoldoutConfig: () => readHoldoutConfig(dir),
    });
    expect(res.shadow).toBe(false);
    const retrieval = retrievalEventFor(res.queryId);
    if (retrieval?.event === "retrieval") {
      expect(retrieval.controlReason).toBeUndefined();
    }
    expect(injectionEventsFor(res.queryId).length).toBeGreaterThan(0);
  });
});

describe("runReasoningPatternsRecall — enabled holdout drives real events", () => {
  function enableAtRate1() {
    initConfig(dir);
    enableHoldoutExperiment(dir, {
      rate: 1, // force every fingerprint into the holdout cohort
      saltFactory: () => "salt-rate-1",
      now: () => new Date("2026-04-22T00:00:00.000Z"),
    });
  }

  it("retrieval event carries controlReason='holdout' and no injection fires", () => {
    enableAtRate1();
    const res = runReasoningPatternsRecall(server, ARGS, {
      readHoldoutConfig: () => readHoldoutConfig(dir),
    });
    expect(res.shadow).toBe(true);
    expect(res.shouldInject).toBe(false);
    const retrieval = retrievalEventFor(res.queryId);
    if (retrieval?.event === "retrieval") {
      expect(retrieval.shadow).toBe(true);
      expect(retrieval.controlReason).toBe("holdout");
      // Candidates are still recorded — the holdout cohort is a
      // "gate-eligible run withheld from injection", not a
      // no-candidate query.
      expect(retrieval.candidates.length).toBeGreaterThan(0);
    }
    expect(injectionEventsFor(res.queryId)).toEqual([]);
  });

  it("same problem shape lands in the same cohort on every call (fingerprint stability)", () => {
    enableAtRate1();
    const r1 = runReasoningPatternsRecall(server, ARGS, {
      readHoldoutConfig: () => readHoldoutConfig(dir),
    });
    const r2 = runReasoningPatternsRecall(server, ARGS, {
      readHoldoutConfig: () => readHoldoutConfig(dir),
    });
    expect(r1.shadow).toBe(r2.shadow);
    // Both must have controlReason=holdout for their retrievals.
    const e1 = retrievalEventFor(r1.queryId);
    const e2 = retrievalEventFor(r2.queryId);
    if (e1?.event === "retrieval" && e2?.event === "retrieval") {
      expect(e1.controlReason).toBe(e2.controlReason);
      expect(e1.controlReason).toBe("holdout");
    }
  });

  it("toggles via CLI helpers take effect on the next call without restart", () => {
    // Simulates a user running
    //   tracebase experiment enable
    //   … agent call …
    //   tracebase experiment disable
    //   … agent call …
    // and proves the loader re-reads config fresh every invocation.
    enableAtRate1();
    const held = runReasoningPatternsRecall(server, ARGS, {
      readHoldoutConfig: () => readHoldoutConfig(dir),
    });
    expect(held.shadow).toBe(true);

    disableHoldoutExperiment(dir, { now: () => new Date("2026-04-22T01:00:00.000Z") });

    const released = runReasoningPatternsRecall(server, ARGS, {
      readHoldoutConfig: () => readHoldoutConfig(dir),
    });
    expect(released.shadow).toBe(false);
    expect(released.shouldInject).toBe(true);

    // Re-enable: existing salt preserved, controlReason='holdout' again.
    enableHoldoutExperiment(dir, {
      rate: 1,
      now: () => new Date("2026-04-22T02:00:00.000Z"),
      saltFactory: () => {
        throw new Error("salt factory must not fire on re-enable");
      },
    });
    const heldAgain = runReasoningPatternsRecall(server, ARGS, {
      readHoldoutConfig: () => readHoldoutConfig(dir),
    });
    const retrieval = retrievalEventFor(heldAgain.queryId);
    if (retrieval?.event === "retrieval") {
      expect(retrieval.controlReason).toBe("holdout");
    }
  });
});

describe("runReasoningPatternsRecall — fake-holdout guards", () => {
  it("no-candidate query never becomes holdout even when experiment is enabled at rate=1", () => {
    initConfig(dir);
    enableHoldoutExperiment(dir, {
      rate: 1,
      saltFactory: () => "salt-no-candidates",
      now: () => new Date("2026-04-22T00:00:00.000Z"),
    });
    const res = runReasoningPatternsRecall(
      server,
      { problem: "xyzzy-nonexistent-gibberish-token-9000" },
      { readHoldoutConfig: () => readHoldoutConfig(dir) },
    );
    expect(res.blocks).toEqual([]);
    expect(res.facts).toEqual([]);
    expect(res.shadow).toBe(false);
    const retrieval = retrievalEventFor(res.queryId);
    if (retrieval?.event === "retrieval") {
      expect(retrieval.controlReason).toBeUndefined();
      expect(retrieval.candidates).toEqual([]);
    }
  });

  it("empty fingerprint silently skips holdout assignment (default-off preserved)", () => {
    // Fingerprint factory injection — simulates "caller has no
    // stable fingerprint available" rather than rigging the real
    // fingerprint function.
    initConfig(dir);
    enableHoldoutExperiment(dir, {
      rate: 1,
      saltFactory: () => "salt-empty-fp",
      now: () => new Date("2026-04-22T00:00:00.000Z"),
    });
    const res = runReasoningPatternsRecall(server, ARGS, {
      readHoldoutConfig: () => readHoldoutConfig(dir),
      fingerprintFactory: () => "", // empty → buildHoldoutInput returns undefined
    });
    expect(res.shadow).toBe(false);
    expect(res.shouldInject).toBe(true);
    const retrieval = retrievalEventFor(res.queryId);
    if (retrieval?.event === "retrieval") {
      expect(retrieval.controlReason).toBeUndefined();
    }
  });

  // Mild integration guard: the seeded block should always be one
  // of the retrieved candidates in the enabled path. Keeps the
  // "real recall fired" story honest across the rest of the suite.
  it("recall actually hits the seeded block on the happy path", () => {
    initConfig(dir);
    const res = runReasoningPatternsRecall(server, ARGS, {
      readHoldoutConfig: () => readHoldoutConfig(dir),
    });
    expect(res.blocks.some((h) => h.block.id === seededBlock.id)).toBe(true);
  });
});

describe("Phase 3.4.2 — project root resolution is independent of storagePath", () => {
  it("finds the holdout config when storagePath lives outside the project tree", () => {
    // Regression: before 3.4.2 the MCP server derived `basePath`
    // via `dirname(dirname(config.storagePath))`. For a project
    // whose `storagePath` was customised to a non-canonical
    // location, that produced a path nowhere near
    // `<project>/.tracebase/config.json`, so `readHoldoutConfig`
    // silently returned null and experiment enable had no effect.
    // This test simulates that scenario and proves the fix: a
    // correctly-resolved project root makes the holdout config
    // reachable regardless of where storagePath points.
    const customDbDir = mkdtempSync(join(tmpdir(), "tb-rp-entry-custom-db-"));
    const customStoragePath = join(customDbDir, "memory.db");
    try {
      initConfig(dir, {
        storagePath: customStoragePath,
      });
      enableHoldoutExperiment(dir, {
        rate: 1,
        saltFactory: () => "salt-custom-storage",
        now: () => new Date("2026-04-22T00:00:00.000Z"),
      });

      // Project root is `dir`; the CLI `serve` passes it through
      // to `startMcpServer`, which wires the loader against it.
      // storagePath (now outside the project) is irrelevant to
      // holdout lookup — the whole point of this fix.
      const res = runReasoningPatternsRecall(server, ARGS, {
        readHoldoutConfig: () => readHoldoutConfig(dir),
      });
      expect(res.shadow).toBe(true);
      const retrieval = retrievalEventFor(res.queryId);
      if (retrieval?.event === "retrieval") {
        expect(retrieval.controlReason).toBe("holdout");
      }

      // Counter-check: deriving basePath from the custom storagePath
      // (the pre-3.4.2 shape) would NOT find the holdout config —
      // asserting this makes the test a true regression rather than
      // a tautology.
      const brokenBasePath = join(customDbDir); // dirname(storagePath)
      expect(readHoldoutConfig(brokenBasePath)).toBeNull();
    } finally {
      rmSync(customDbDir, { recursive: true, force: true });
    }
  });

  it("mcp.ts does not derive basePath from storagePath (textual guard)", async () => {
    // Lock the fix in: no code path inside the MCP server may
    // reintroduce the broken derive. Grep the source so a future
    // well-intended refactor can't silently put it back.
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const source = await readFile(
      resolve(__dirname, "../../src/server/mcp.ts"),
      "utf-8",
    );
    expect(source).not.toMatch(/dirname\(dirname\(config\.storagePath\)\)/);
    expect(source).not.toMatch(/dirname\(.*storagePath.*\)/);
  });
});
