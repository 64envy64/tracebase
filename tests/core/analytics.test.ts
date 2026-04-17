import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlockStore } from "../../src/core/block-store.js";
import { BlockServer } from "../../src/core/block-serving.js";
import {
  JsonlEventSink,
  exportEventsToJsonl,
  importEventsFromJsonl,
  emitAgentUsed,
  emitOutcome,
  computeAggregates,
} from "../../src/core/analytics.js";
import { createBlock } from "../../src/core/block.js";
import type {
  AnalyticsEvent,
  ReasoningBlock,
  StoreBlockInput,
} from "../../src/types.js";

const SAMPLE: StoreBlockInput = {
  trigger: {
    situation: "Metaclass iterates members using inspect.isfunction which skips properties",
    invariants: {
      language: "python",
      framework: "astropy",
      errorType: "MissingDocstring",
    },
  },
  body: {
    mechanism: "property objects are descriptors not functions",
    deadEnds: ["add property-specific branch"],
    unlock: "use inspect.isdatadescriptor",
    verification: "class with method + property inherits docstrings",
  },
  provenance: {
    sourceTaskId: "t-1", extractedFrom: "trajectory", distilledBy: "llm",
  },
};

function makeStore(): BlockStore {
  return new BlockStore(new Database(":memory:"));
}

function storeActive(store: BlockStore, input: StoreBlockInput): ReasoningBlock {
  const b = createBlock(input); b.status = "candidate";
  store.storeBlock(b);
  store.attachCaseRef({
    blockId: b.id, traceId: `trace-${b.id}`, role: "origin", evidenceQuality: "strong",
  });
  return store.updateBlockStatus(b.id, "active")!;
}

// ---------------------------------------------------------------------------
// JsonlEventSink
// ---------------------------------------------------------------------------

describe("JsonlEventSink", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tb-jsonl-"));
    path = join(dir, "events.jsonl");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("appends and re-reads events losslessly", () => {
    const sink = new JsonlEventSink(path);
    const a: AnalyticsEvent = {
      ts: 1, queryId: "q1", event: "retrieval",
      candidates: [{ blockId: "b1", score: 0.9 }], shadow: false,
    };
    const b: AnalyticsEvent = {
      ts: 2, queryId: "q1", event: "injection", blockId: "b1", score: 0.9,
    };
    sink.append(a);
    sink.append(b);
    const back = sink.readAll();
    expect(back.length).toBe(2);
    expect(back[0]).toEqual(a);
    expect(back[1]).toEqual(b);
  });

  it("creates nested directories if missing", () => {
    const deep = join(dir, "a/b/c/events.jsonl");
    const sink = new JsonlEventSink(deep);
    sink.append({ ts: 1, queryId: "q", event: "retrieval", candidates: [], shadow: true });
    expect(sink.readAll().length).toBe(1);
  });

  it("skips malformed lines on read", () => {
    // Write bad content directly.
    writeFileSync(path,
      `{"ts":1,"queryId":"q","event":"retrieval","candidates":[],"shadow":false}\n` +
      `this is not json\n` +
      `{"ts":2,"queryId":"q","event":"injection","blockId":"b","score":0.5}\n`,
    );
    const sink = new JsonlEventSink(path);
    const back = sink.readAll();
    expect(back.length).toBe(2);
  });

  it("merges extra fields into the written line", () => {
    const sink = new JsonlEventSink(path);
    sink.append(
      { ts: 1, queryId: "q", event: "retrieval", candidates: [], shadow: false },
      { runId: "bench-2026-04" },
    );
    const raw = readFileSync(path, "utf8").trim();
    expect(raw).toContain('"runId":"bench-2026-04"');
  });

  it("returns empty array when the file does not exist", () => {
    const sink = new JsonlEventSink(join(dir, "does-not-exist.jsonl"));
    expect(sink.readAll()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Export / import round-trip
// ---------------------------------------------------------------------------

describe("exportEventsToJsonl / importEventsFromJsonl", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tb-roundtrip-"));
    path = join(dir, "e.jsonl");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("exports SQLite events to JSONL in append order", () => {
    const store = makeStore();
    const b = storeActive(store, SAMPLE);
    const server = new BlockServer(store);
    server.recall({ text: "metaclass inspect", runId: "r-1" });
    emitAgentUsed(store, { queryId: "made-up", blockId: b.id, matchSignal: "jaccard", matchScore: 0.5 });
    emitOutcome(store, { queryId: "made-up", resolved: true, control: false });

    const n = exportEventsToJsonl(store, path);
    expect(n).toBeGreaterThan(0);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines.length).toBe(n);
  });

  it("import round-trips into a clean store", () => {
    const src = makeStore();
    storeActive(src, SAMPLE);
    const server = new BlockServer(src);
    server.recall({ text: "metaclass inspect" });
    emitOutcome(src, { queryId: "x", resolved: true, control: false });
    exportEventsToJsonl(src, path);

    const dst = makeStore();
    const n = importEventsFromJsonl(dst, path);
    expect(n).toBe(src.countEvents());
    expect(dst.countEvents()).toBe(src.countEvents());
  });

  it("import skips malformed JSON lines", () => {
    writeFileSync(path,
      `{"ts":1,"queryId":"q","event":"retrieval","candidates":[],"shadow":false}\n` +
      `not-json\n` +
      `{"not":"an event"}\n` +
      `{"ts":2,"queryId":"q","event":"outcome","resolved":true,"control":false}\n`,
    );
    const dst = makeStore();
    const n = importEventsFromJsonl(dst, path);
    expect(n).toBe(2);
  });

  it("import is a no-op for a missing file", () => {
    const dst = makeStore();
    const n = importEventsFromJsonl(dst, join(dir, "missing.jsonl"));
    expect(n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// BlockServer side-sink hook
// ---------------------------------------------------------------------------

describe("BlockServer — side-sink hook", () => {
  it("side-sink receives every emitted event alongside SQLite", () => {
    const store = makeStore();
    storeActive(store, SAMPLE);
    const captured: AnalyticsEvent[] = [];
    const server = new BlockServer(store, {
      sideSink: (ev) => captured.push(ev),
    });
    server.recall({ text: "metaclass inspect" });
    // retrieval + (≥ 1) injection.
    expect(captured.length).toBeGreaterThanOrEqual(2);
    expect(captured.some((e) => e.event === "retrieval")).toBe(true);
    expect(captured.some((e) => e.event === "injection")).toBe(true);
  });

  it("side-sink exceptions do not break retrieval", () => {
    const store = makeStore();
    storeActive(store, SAMPLE);
    const server = new BlockServer(store, {
      sideSink: () => { throw new Error("boom"); },
    });
    expect(() => server.recall({ text: "metaclass inspect" })).not.toThrow();
  });

  it("side-sink is not invoked when emitEvents=false", () => {
    const store = makeStore();
    storeActive(store, SAMPLE);
    const captured: AnalyticsEvent[] = [];
    const server = new BlockServer(store, {
      emitEvents: false,
      sideSink: (ev) => captured.push(ev),
    });
    server.recall({ text: "metaclass inspect" });
    expect(captured.length).toBe(0);
  });

  it("wiring a JsonlEventSink via sideSink writes to disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "tb-wire-"));
    const path = join(dir, "e.jsonl");
    try {
      const store = makeStore();
      storeActive(store, SAMPLE);
      const jsonl = new JsonlEventSink(path);
      const server = new BlockServer(store, {
        sideSink: (ev, extra) => jsonl.append(ev, extra),
      });
      server.recall({ text: "metaclass inspect", runId: "wire-1" });
      const back = jsonl.readAll();
      expect(back.length).toBeGreaterThanOrEqual(2);
      const raw = readFileSync(path, "utf8");
      expect(raw).toContain('"runId":"wire-1"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// emitAgentUsed / emitOutcome
// ---------------------------------------------------------------------------

describe("emitAgentUsed / emitOutcome", () => {
  it("emitAgentUsed writes an agent_used event", () => {
    const store = makeStore();
    emitAgentUsed(store, {
      queryId: "q1", blockId: "b1", matchSignal: "jaccard", matchScore: 0.42, ts: 100,
    });
    const evs = store.readEvents({ eventType: "agent_used" });
    expect(evs.length).toBe(1);
    const ev = evs[0];
    if (ev.event !== "agent_used") throw new Error("wrong type");
    expect(ev.blockId).toBe("b1");
    expect(ev.matchSignal).toBe("jaccard");
    expect(ev.matchScore).toBeCloseTo(0.42);
  });

  it("emitOutcome writes an outcome event with control / regression fields", () => {
    const store = makeStore();
    emitOutcome(store, {
      queryId: "q1", resolved: true, control: false, tokens: 4200, steps: 14, ts: 200,
    });
    emitOutcome(store, {
      queryId: "q2", resolved: false, control: true, regressed: true, ts: 201,
    });
    const evs = store.readEvents({ eventType: "outcome" });
    expect(evs.length).toBe(2);
    const e1 = evs[0];
    if (e1.event !== "outcome") throw new Error("wrong");
    expect(e1.resolved).toBe(true);
    expect(e1.control).toBe(false);
    expect(e1.tokens).toBe(4200);
  });
});

// ---------------------------------------------------------------------------
// computeAggregates — the helpfulness definition
// ---------------------------------------------------------------------------

describe("computeAggregates", () => {
  it("returns zeros on empty store", () => {
    const store = makeStore();
    const agg = computeAggregates(store);
    expect(agg.counts).toEqual({ retrieval: 0, injection: 0, agentUsed: 0, outcome: 0 });
    expect(agg.rates.helpfulRate).toBeNull();
    expect(agg.rates.resolvedLift).toBeNull();
    expect(agg.perBlock).toEqual([]);
  });

  it("counts helpful only when injection ∧ agent_used ∧ resolved", () => {
    const store = makeStore();
    // Set up: one query with (inject, agent_used, resolved)
    store.appendEvent({ ts: 1, queryId: "q1", event: "retrieval", candidates: [{ blockId: "b1", score: 0.9 }], shadow: false });
    store.appendEvent({ ts: 2, queryId: "q1", event: "injection", blockId: "b1", score: 0.9 });
    store.appendEvent({ ts: 3, queryId: "q1", event: "agent_used", blockId: "b1", matchSignal: "jaccard", matchScore: 0.8 });
    store.appendEvent({ ts: 4, queryId: "q1", event: "outcome", resolved: true, control: false });

    // Second query: inject, no agent_used, resolved → neutral, not helpful
    store.appendEvent({ ts: 5, queryId: "q2", event: "retrieval", candidates: [{ blockId: "b1", score: 0.9 }], shadow: false });
    store.appendEvent({ ts: 6, queryId: "q2", event: "injection", blockId: "b1", score: 0.9 });
    store.appendEvent({ ts: 7, queryId: "q2", event: "outcome", resolved: true, control: false });

    // Third query: inject + agent_used + NOT resolved → counterproductive
    store.appendEvent({ ts: 8, queryId: "q3", event: "retrieval", candidates: [{ blockId: "b1", score: 0.9 }], shadow: false });
    store.appendEvent({ ts: 9, queryId: "q3", event: "injection", blockId: "b1", score: 0.9 });
    store.appendEvent({ ts: 10, queryId: "q3", event: "agent_used", blockId: "b1", matchSignal: "explicit", matchScore: 1.0 });
    store.appendEvent({ ts: 11, queryId: "q3", event: "outcome", resolved: false, control: false });

    const agg = computeAggregates(store);
    const b1 = agg.perBlock.find((r) => r.blockId === "b1")!;
    expect(b1.injected).toBe(3);
    expect(b1.agentUsed).toBe(2);
    expect(b1.helpful).toBe(1);
    expect(b1.counterproductive).toBe(1);
    expect(b1.neutral).toBe(1);

    expect(agg.rates.helpfulRate).toBeCloseTo(1 / 3);
    expect(agg.rates.counterproductiveRate).toBeCloseTo(1 / 3);
    expect(agg.rates.hitRate).toBeCloseTo(2 / 3);
  });

  it("coverage excludes shadow queries from the denominator", () => {
    const store = makeStore();
    // 1 treatment with injection.
    store.appendEvent({ ts: 1, queryId: "qt", event: "retrieval", candidates: [{ blockId: "b1", score: 0.9 }], shadow: false });
    store.appendEvent({ ts: 2, queryId: "qt", event: "injection", blockId: "b1", score: 0.9 });
    // 1 shadow with no injection.
    store.appendEvent({ ts: 3, queryId: "qs", event: "retrieval", candidates: [{ blockId: "b1", score: 0.9 }], shadow: true });
    // 1 treatment with no injection (gate skipped).
    store.appendEvent({ ts: 4, queryId: "qt2", event: "retrieval", candidates: [], shadow: false });

    const agg = computeAggregates(store);
    // 2 treatment retrievals, 1 had injection.
    expect(agg.rates.coverage).toBeCloseTo(0.5);
    expect(agg.retrieval.shadow).toBe(1);
    expect(agg.retrieval.treatment).toBe(2);
  });

  it("resolvedLift is null when either arm is empty", () => {
    const store = makeStore();
    // Treatment only.
    store.appendEvent({ ts: 1, queryId: "q1", event: "retrieval", candidates: [{ blockId: "b1", score: 0.9 }], shadow: false });
    store.appendEvent({ ts: 2, queryId: "q1", event: "injection", blockId: "b1", score: 0.9 });
    store.appendEvent({ ts: 3, queryId: "q1", event: "outcome", resolved: true, control: false });
    const agg = computeAggregates(store);
    expect(agg.rates.resolvedLift).toBeNull();
  });

  it("resolvedLift computes treatment − shadow resolution rates", () => {
    const store = makeStore();
    // Treatment: 2 outcomes, both resolved.
    store.appendEvent({ ts: 1, queryId: "q1", event: "retrieval", candidates: [{ blockId: "b1", score: 0.9 }], shadow: false });
    store.appendEvent({ ts: 2, queryId: "q1", event: "injection", blockId: "b1", score: 0.9 });
    store.appendEvent({ ts: 3, queryId: "q1", event: "outcome", resolved: true, control: false });
    store.appendEvent({ ts: 4, queryId: "q2", event: "retrieval", candidates: [{ blockId: "b1", score: 0.9 }], shadow: false });
    store.appendEvent({ ts: 5, queryId: "q2", event: "injection", blockId: "b1", score: 0.9 });
    store.appendEvent({ ts: 6, queryId: "q2", event: "outcome", resolved: true, control: false });
    // Shadow: 2 outcomes, 1 resolved.
    store.appendEvent({ ts: 7, queryId: "qs1", event: "retrieval", candidates: [], shadow: true });
    store.appendEvent({ ts: 8, queryId: "qs1", event: "outcome", resolved: true, control: true });
    store.appendEvent({ ts: 9, queryId: "qs2", event: "retrieval", candidates: [], shadow: true });
    store.appendEvent({ ts: 10, queryId: "qs2", event: "outcome", resolved: false, control: true });

    const agg = computeAggregates(store);
    // Treatment: 2/2 = 1.0; shadow: 1/2 = 0.5; lift = 0.5
    expect(agg.rates.resolvedLift).toBeCloseTo(0.5);
  });

  it("tokenLift measures mean(tokens|treatment) − mean(tokens|shadow)", () => {
    const store = makeStore();
    // Treatment tokens: 100, 150 → mean 125
    store.appendEvent({ ts: 1, queryId: "q1", event: "outcome", resolved: true, control: false, tokens: 100 });
    store.appendEvent({ ts: 2, queryId: "q2", event: "outcome", resolved: true, control: false, tokens: 150 });
    // Shadow tokens: 200, 300 → mean 250
    store.appendEvent({ ts: 3, queryId: "qs1", event: "outcome", resolved: true, control: true, tokens: 200 });
    store.appendEvent({ ts: 4, queryId: "qs2", event: "outcome", resolved: false, control: true, tokens: 300 });

    const agg = computeAggregates(store);
    expect(agg.rates.tokenLift).toBeCloseTo(125 - 250);
  });

  it("windows and runId filters narrow the scope", () => {
    const store = makeStore();
    store.appendEvent(
      { ts: 10, queryId: "q1", event: "retrieval", candidates: [], shadow: false },
      { runId: "old-run" },
    );
    store.appendEvent(
      { ts: 100, queryId: "q2", event: "retrieval", candidates: [], shadow: false },
      { runId: "new-run" },
    );
    const a = computeAggregates(store, { afterTs: 50 });
    expect(a.counts.retrieval).toBe(1);
    const b = computeAggregates(store, { runId: "new-run" });
    expect(b.counts.retrieval).toBe(1);
  });

  it("per-block retrieved count reflects retrieval candidate lists", () => {
    const store = makeStore();
    store.appendEvent({
      ts: 1, queryId: "q1", event: "retrieval",
      candidates: [
        { blockId: "A", score: 0.9 },
        { blockId: "B", score: 0.7 },
      ],
      shadow: false,
    });
    store.appendEvent({
      ts: 2, queryId: "q2", event: "retrieval",
      candidates: [{ blockId: "A", score: 0.8 }],
      shadow: true, // shadow still retrieves blocks
    });
    const agg = computeAggregates(store);
    const a = agg.perBlock.find((r) => r.blockId === "A")!;
    const b = agg.perBlock.find((r) => r.blockId === "B")!;
    expect(a.retrieved).toBe(2);
    expect(b.retrieved).toBe(1);
  });
});
