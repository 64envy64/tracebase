import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import { createBlock } from "../../src/core/block.js";
import {
  buildExtractivePrimer,
  distillDomain,
  selectTopPatternsForDomain,
} from "../../src/distillation/domain-distiller.js";
import type { ReasoningBlock, StoreBlockInput } from "../../src/types.js";

function makeStore(): BlockStore {
  return new BlockStore(new Database(":memory:"));
}

interface SeedOptions {
  language?: string;
  framework?: string;
  errorType?: string;
  unlock: string;
  mechanism: string;
  verification?: string;
  deadEnds?: string[];
  wilsonLb?: number;
  helpful?: number;
  used?: number;
  extractedFrom?: "trajectory" | "manual" | "imported" | "distilled";
  status?: ReasoningBlock["status"];
}

function seed(store: BlockStore, opts: SeedOptions): ReasoningBlock {
  const input: StoreBlockInput = {
    trigger: {
      situation: opts.unlock.slice(0, 40),
      invariants: {
        ...(opts.language ? { language: opts.language } : {}),
        ...(opts.framework ? { framework: opts.framework } : {}),
        ...(opts.errorType ? { errorType: opts.errorType } : {}),
      },
    },
    body: {
      mechanism: opts.mechanism,
      deadEnds: opts.deadEnds ?? [],
      unlock: opts.unlock,
      verification: opts.verification ?? "Re-run the failing assertion.",
    },
    provenance: {
      sourceTaskId: "seed",
      extractedFrom: opts.extractedFrom ?? "trajectory",
      distilledBy: "rule",
    },
  };
  const b = createBlock(input);
  b.quality.wilsonLowerBound = opts.wilsonLb ?? 0;
  b.stats.timesHelpful = opts.helpful ?? 0;
  b.stats.timesAgentUsed = opts.used ?? (opts.helpful ?? 0);
  // Store as candidate, attach origin ref, then promote — the
  // store integrity check refuses to insert active without one.
  b.status = "candidate";
  store.storeBlock(b);
  store.attachCaseRef({
    blockId: b.id,
    traceId: `trace-${b.id}`,
    role: "origin",
    evidenceQuality: "strong",
  });
  const target = opts.status ?? "active";
  if (target !== "candidate") {
    store.updateBlockStatus(b.id, target);
  }
  return store.getBlock(b.id)!;
}

describe("selectTopPatternsForDomain", () => {
  let store: BlockStore;
  beforeEach(() => { store = makeStore(); });

  it("orders by wilson_lb DESC, helpful DESC as tiebreaker", () => {
    seed(store, { language: "typescript", framework: "react", unlock: "low", mechanism: "m", wilsonLb: 0.1, helpful: 1 });
    seed(store, { language: "typescript", framework: "react", unlock: "high", mechanism: "m", wilsonLb: 0.9, helpful: 1 });
    seed(store, { language: "typescript", framework: "react", unlock: "midA", mechanism: "m", wilsonLb: 0.5, helpful: 2 });
    seed(store, { language: "typescript", framework: "react", unlock: "midB", mechanism: "m", wilsonLb: 0.5, helpful: 5 });
    const top = selectTopPatternsForDomain(store, { language: "typescript", framework: "react" }, { k: 4 });
    const unlocks = top.map((b) => b.body.unlock);
    expect(unlocks).toEqual(["high", "midB", "midA", "low"]);
  });

  it("filters out other domains", () => {
    seed(store, { language: "typescript", framework: "react", unlock: "ts-react", mechanism: "m", wilsonLb: 0.9, helpful: 1 });
    seed(store, { language: "python", framework: "django", unlock: "py-django", mechanism: "m", wilsonLb: 0.9, helpful: 1 });
    const top = selectTopPatternsForDomain(store, { language: "typescript", framework: "react" }, { k: 5 });
    expect(top.map((b) => b.body.unlock)).toEqual(["ts-react"]);
  });

  it("excludes existing distilled primers (no feedback-loop slop)", () => {
    seed(store, { language: "typescript", unlock: "a", mechanism: "m", wilsonLb: 0.9, helpful: 1 });
    seed(store, { language: "typescript", unlock: "primer", mechanism: "m", wilsonLb: 0.95, helpful: 5, extractedFrom: "distilled" });
    const top = selectTopPatternsForDomain(store, { language: "typescript" }, { k: 5 });
    expect(top.map((b) => b.body.unlock)).toEqual(["a"]);
  });

  it("requires a quality floor by default (excludes blocks with no usage and zero wilson_lb)", () => {
    seed(store, { language: "typescript", unlock: "proven", mechanism: "m", wilsonLb: 0.5, helpful: 2 });
    seed(store, { language: "typescript", unlock: "unproven", mechanism: "m", wilsonLb: 0, helpful: 0, used: 0, extractedFrom: "trajectory" });
    const top = selectTopPatternsForDomain(store, { language: "typescript" }, { k: 5 });
    expect(top.map((b) => b.body.unlock)).toEqual(["proven"]);
  });

  it("skipQualityFloor includes unproven blocks (eval/cold-start mode)", () => {
    seed(store, { language: "typescript", unlock: "unproven", mechanism: "m", wilsonLb: 0, helpful: 0, used: 0, extractedFrom: "trajectory" });
    const top = selectTopPatternsForDomain(
      store,
      { language: "typescript" },
      { k: 5, skipQualityFloor: true },
    );
    expect(top.map((b) => b.body.unlock)).toEqual(["unproven"]);
  });
});

describe("buildExtractivePrimer", () => {
  function block(unlock: string, mechanism: string, deadEnds: string[] = []): ReasoningBlock {
    return createBlock({
      trigger: { situation: "s", invariants: { language: "typescript" } },
      body: {
        mechanism,
        deadEnds,
        unlock,
        verification: "Re-run tests.",
      },
      provenance: { sourceTaskId: "t", extractedFrom: "manual", distilledBy: "rule" },
    });
  }

  it("numbers unlocks in source order", () => {
    const patterns = [
      block("Add a null check.", "Null deref."),
      block("Wrap in try/catch.", "Throws inside async."),
    ];
    const primer = buildExtractivePrimer(patterns, 600);
    expect(primer.unlock).toBe("1. Add a null check.\n2. Wrap in try/catch.");
  });

  it("deduplicates near-identical unlocks via token overlap", () => {
    const patterns = [
      block("Add a null check before accessing user.id.", "m"),
      block("Add null check before user.id access.", "m"),
      block("Migrate the schema.", "m"),
    ];
    const primer = buildExtractivePrimer(patterns, 600);
    // The two null-check phrasings collapse to one; the schema migration
    // survives. Numbering is over the dedup'd list.
    expect(primer.unlock).toContain("Add a null check");
    expect(primer.unlock).toContain("Migrate the schema");
    expect(primer.unlock.split("\n")).toHaveLength(2);
  });

  it("includes a citation header listing source block id prefixes", () => {
    const patterns = [block("u1", "Mechanism A explanation."), block("u2", "Mechanism B explanation.")];
    const primer = buildExtractivePrimer(patterns, 600);
    expect(primer.mechanism).toMatch(/Distilled from blocks:/);
    expect(primer.mechanism).toContain(patterns[0]!.id.slice(0, 8));
    expect(primer.mechanism).toContain(patterns[1]!.id.slice(0, 8));
  });

  it("respects the token budget", () => {
    // 10 patterns × long unlocks would blow a 100-token budget; the
    // primer must clamp.
    const long = "lorem ipsum dolor sit amet ".repeat(20);
    const patterns = Array.from({ length: 10 }).map((_, i) =>
      block(`${long} unlock-${i}`, `mechanism ${i}: ${long}`),
    );
    const primer = buildExtractivePrimer(patterns, 100);
    const totalTokens = Math.ceil(
      (primer.mechanism + primer.unlock + primer.verification + primer.deadEnds.join(" ")).length / 4,
    );
    expect(totalTokens).toBeLessThanOrEqual(110); // small fudge for ellipsis chars
  });

  it("unions deadEnds across patterns and caps at 6", () => {
    const patterns = Array.from({ length: 8 }).map((_, i) =>
      block(`unlock-${i}`, `mechanism-${i}`, [`dead-end ${i}`]),
    );
    const primer = buildExtractivePrimer(patterns, 600);
    expect(primer.deadEnds.length).toBeLessThanOrEqual(6);
    expect(primer.deadEnds[0]).toContain("dead-end");
  });
});

describe("distillDomain", () => {
  let store: BlockStore;
  beforeEach(() => { store = makeStore(); });

  it("skips when no domain key is supplied", () => {
    const r = distillDomain(store, {});
    expect(r.status).toBe("skipped");
    if (r.status === "skipped") expect(r.reason).toBe("no-domain-key");
  });

  it("skips when fewer than minPatterns sources match", () => {
    seed(store, { language: "go", unlock: "u", mechanism: "m", wilsonLb: 0.5, helpful: 1 });
    seed(store, { language: "go", unlock: "u2", mechanism: "m", wilsonLb: 0.5, helpful: 1 });
    const r = distillDomain(store, { language: "go" }, { minPatterns: 3 });
    expect(r.status).toBe("skipped");
    if (r.status === "skipped") {
      expect(r.reason).toBe("too-few-patterns");
      expect(r.foundPatterns).toBe(2);
    }
  });

  it("stores a primer block with extractedFrom=distilled when enough patterns match", () => {
    const topics = ["nullcheck", "asyncrace", "datemath", "regexbacktrack", "memorystall"];
    topics.forEach((topic, i) => {
      seed(store, {
        language: "typescript",
        framework: "react",
        unlock: `Fix ${topic} by introducing a defensive guard around the ${topic} site.`,
        mechanism: `${topic} arises when ${topic}-specific invariants are violated.`,
        wilsonLb: 0.5 + i * 0.05,
        helpful: i + 1,
        deadEnds: [`dead end about ${topic}`],
      });
    });
    const r = distillDomain(store, { language: "typescript", framework: "react" }, { k: 5 });
    expect(r.status).toBe("stored");
    if (r.status === "stored") {
      expect(r.block.provenance.extractedFrom).toBe("distilled");
      expect(r.block.provenance.distilledWithModel).toBe("extractive.v1");
      expect(r.block.trigger.invariants.language).toBe("typescript");
      expect(r.block.trigger.invariants.framework).toBe("react");
      expect(r.sourceIds).toHaveLength(5);

      // The primer is queryable through the store like any other block.
      const fetched = store.getBlock(r.block.id);
      expect(fetched?.provenance.extractedFrom).toBe("distilled");
    }
  });

  it("re-running distillation replaces the existing primer in place", () => {
    const topics = ["alpha", "beta", "gamma", "delta", "epsilon"];
    topics.forEach((topic, i) => {
      seed(store, {
        language: "typescript",
        unlock: `Resolve ${topic} cases by tightening the boundary check for ${topic}.`,
        mechanism: `${topic} fails because of an unhandled boundary in ${topic} flow.`,
        wilsonLb: 0.6 + i * 0.01,
        helpful: 1,
      });
    });
    const first = distillDomain(store, { language: "typescript" }, { k: 5 });
    expect(first.status).toBe("stored");
    if (first.status !== "stored") return;

    const second = distillDomain(store, { language: "typescript" }, { k: 5 });
    expect(second.status).toBe("stored");
    if (second.status !== "stored") return;

    // Same identity: replacement preserves id + createdAt.
    expect(second.block.id).toBe(first.block.id);
    expect(second.block.createdAt).toBe(first.block.createdAt);
    // Sources are still the 5 seeded — the prior primer itself is
    // never selected (selector filters extractedFrom="distilled").
    expect(second.sourceIds).not.toContain(first.block.id);
    expect(second.sourceIds).toHaveLength(5);
  });
});
