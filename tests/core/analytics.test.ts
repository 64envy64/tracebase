import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlockStore } from "../../src/core/block-store.js";
import { BlockServer } from "../../src/core/block-serving.js";
import {
  JsonlEventSink,
  EventEmitter,
  exportEventsToJsonl,
  importEventsFromJsonl,
  emitAgentUsed,
  emitFactAgentUsed,
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
    expect(agg.counts).toEqual({
      retrieval: 0, injection: 0, agentUsed: 0, outcome: 0,
      factInjection: 0, factAgentUsed: 0,
    });
    expect(agg.rates.helpfulRate).toBeNull();
    expect(agg.rates.factHelpfulRate).toBeNull();
    expect(agg.rates.resolvedLift).toBeNull();
    expect(agg.perBlock).toEqual([]);
    expect(agg.perFact).toEqual([]);
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

// ---------------------------------------------------------------------------
// P1 — runId round-trip
// ---------------------------------------------------------------------------

describe("analytics — runId round-trip", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tb-runid-"));
    path = join(dir, "e.jsonl");
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("readEvents returns runId that was written via the extra param", () => {
    const store = makeStore();
    store.appendEvent(
      { ts: 1, queryId: "q1", event: "retrieval", candidates: [], shadow: false },
      { runId: "run-1" },
    );
    const ev = store.readEvents({})[0];
    expect(ev.runId).toBe("run-1");
    expect(store.readEvents({ runId: "run-1" }).length).toBe(1);
  });

  it("readEvents returns runId that was written via the event object", () => {
    const store = makeStore();
    store.appendEvent(
      { ts: 1, queryId: "q1", event: "retrieval", candidates: [], shadow: false, runId: "run-2" },
    );
    const ev = store.readEvents({})[0];
    expect(ev.runId).toBe("run-2");
    expect(store.readEvents({ runId: "run-2" }).length).toBe(1);
  });

  it("runId survives SQLite → JSONL → SQLite round-trip", () => {
    const src = makeStore();
    storeActive(src, SAMPLE);
    const server = new BlockServer(src);
    server.recall({ text: "metaclass inspect", runId: "bench-42" });
    emitAgentUsed(src, {
      queryId: "sep-q", blockId: "some-b", matchSignal: "jaccard", matchScore: 0.5,
      runId: "bench-42",
    });
    emitOutcome(src, { queryId: "sep-q", resolved: true, control: false, runId: "bench-42" });

    const wrote = exportEventsToJsonl(src, path);
    expect(wrote).toBeGreaterThan(0);

    // Sanity: the JSONL file actually has runId on every line.
    const lines = readFileSync(path, "utf8").trim().split("\n");
    for (const line of lines) {
      expect(JSON.parse(line).runId).toBe("bench-42");
    }

    const dst = makeStore();
    const imported = importEventsFromJsonl(dst, path);
    expect(imported).toBe(wrote);

    // Filtered query works after round-trip.
    const byRun = dst.readEvents({ runId: "bench-42" });
    expect(byRun.length).toBe(imported);
  });
});

// ---------------------------------------------------------------------------
// P2 — strict per-variant validation on import
// ---------------------------------------------------------------------------

describe("importEventsFromJsonl — strict validation", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tb-strict-"));
    path = join(dir, "e.jsonl");
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("rejects an injection event missing blockId", () => {
    writeFileSync(path, `{"ts":1,"queryId":"q1","event":"injection","score":0.5}\n`);
    const store = makeStore();
    expect(importEventsFromJsonl(store, path)).toBe(0);
  });

  it("rejects an injection event missing score", () => {
    writeFileSync(path, `{"ts":1,"queryId":"q1","event":"injection","blockId":"b"}\n`);
    const store = makeStore();
    expect(importEventsFromJsonl(store, path)).toBe(0);
  });

  it("rejects a retrieval event without candidates array", () => {
    writeFileSync(path, `{"ts":1,"queryId":"q1","event":"retrieval","shadow":false}\n`);
    const store = makeStore();
    expect(importEventsFromJsonl(store, path)).toBe(0);
  });

  it("rejects a retrieval event with a malformed candidate row", () => {
    writeFileSync(
      path,
      `{"ts":1,"queryId":"q1","event":"retrieval","shadow":false,"candidates":[{"blockId":"b"}]}\n`,
    );
    const store = makeStore();
    expect(importEventsFromJsonl(store, path)).toBe(0);
  });

  it("rejects an agent_used event with an unknown matchSignal", () => {
    writeFileSync(
      path,
      `{"ts":1,"queryId":"q","event":"agent_used","blockId":"b","matchSignal":"bogus","matchScore":0.5}\n`,
    );
    const store = makeStore();
    expect(importEventsFromJsonl(store, path)).toBe(0);
  });

  it("rejects an outcome event missing resolved", () => {
    writeFileSync(path, `{"ts":1,"queryId":"q","event":"outcome","control":false}\n`);
    const store = makeStore();
    expect(importEventsFromJsonl(store, path)).toBe(0);
  });

  it("rejects an event with non-string runId", () => {
    writeFileSync(
      path,
      `{"ts":1,"queryId":"q","event":"retrieval","shadow":false,"candidates":[],"runId":123}\n`,
    );
    const store = makeStore();
    expect(importEventsFromJsonl(store, path)).toBe(0);
  });

  it("accepts a fully-valid event of each variant", () => {
    writeFileSync(path,
      `{"ts":1,"queryId":"q","event":"retrieval","shadow":false,"candidates":[{"blockId":"b","score":0.9}]}\n` +
      `{"ts":2,"queryId":"q","event":"injection","blockId":"b","score":0.9}\n` +
      `{"ts":3,"queryId":"q","event":"agent_used","blockId":"b","matchSignal":"jaccard","matchScore":0.4}\n` +
      `{"ts":4,"queryId":"q","event":"outcome","resolved":true,"control":false}\n`,
    );
    const store = makeStore();
    expect(importEventsFromJsonl(store, path)).toBe(4);

});
  it("rejects an outcome with an unrecognised \`attribution\` value", () => {
    // The provenance field is optional but, when present, must be
    // exactly "explicit" or "inferred". Anything else (typo,
    // malformed upstream feed, hand-edited row) would otherwise
    // silently count as explicit in verifiedHelpfulRuns — the gate
    // is `!== "inferred"`, so unknown values pass through as if
    // they were canonical.
    writeFileSync(
      path,
      `{"ts":1,"queryId":"q","event":"outcome","resolved":true,"control":false,"attribution":"garbage"}\n`,
    );
    const store = makeStore();
    expect(importEventsFromJsonl(store, path)).toBe(0);
  });

  it("accepts both halves of the attribution union (inferred + explicit)", () => {
    // Both halves of the closed union must round-trip cleanly,
    // otherwise honest re-import of an exported event log would
    // silently drop the soft Stop-hook outcomes and
    // verifiedHelpfulRuns would over-count.
    writeFileSync(
      path,
      `{"ts":1,"queryId":"q1","event":"outcome","resolved":true,"control":false,"attribution":"inferred"}\n` +
      `{"ts":2,"queryId":"q2","event":"outcome","resolved":true,"control":false,"attribution":"explicit"}\n`,
    );
    const store = makeStore();
    expect(importEventsFromJsonl(store, path)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// P3 — shadow/control authoritative source
// ---------------------------------------------------------------------------

describe("computeAggregates — shadow authoritative source", () => {
  it("uses retrieval.shadow over outcome.control when they disagree", () => {
    const store = makeStore();
    // retrieval says shadow=true (i.e. a control query) but outcome
    // self-reports control=false. Retrieval must win.
    store.appendEvent({
      ts: 1, queryId: "q1", event: "retrieval", candidates: [], shadow: true,
    });
    store.appendEvent({
      ts: 2, queryId: "q1", event: "outcome", resolved: true, control: false, tokens: 100,
    });
    // Second query: retrieval says treatment, outcome reports control.
    // Also a mismatch; treatment wins.
    store.appendEvent({
      ts: 3, queryId: "q2", event: "retrieval",
      candidates: [{ blockId: "b", score: 0.9 }], shadow: false,
    });
    store.appendEvent({
      ts: 4, queryId: "q2", event: "outcome", resolved: false, control: true, tokens: 200,
    });

    const agg = computeAggregates(store);
    expect(agg.integrity.shadowControlMismatches).toBe(2);
    // q1 → shadow bucket; q2 → treatment bucket per retrieval.
    expect(agg.outcome.totalShadow).toBe(1);
    expect(agg.outcome.totalTreatment).toBe(1);
    expect(agg.outcome.resolvedShadow).toBe(1);
    expect(agg.outcome.resolvedTreatment).toBe(0);
  });

  it("falls back to outcome.control when no retrieval is in the window", () => {
    const store = makeStore();
    store.appendEvent({
      ts: 1, queryId: "orphan", event: "outcome", resolved: true, control: true,
    });
    const agg = computeAggregates(store);
    expect(agg.integrity.outcomesWithoutRetrieval).toBe(1);
    expect(agg.outcome.totalShadow).toBe(1);
    expect(agg.integrity.shadowControlMismatches).toBe(0);
  });

  it("reports zero mismatches when flags agree", () => {
    const store = makeStore();
    store.appendEvent({
      ts: 1, queryId: "q", event: "retrieval", candidates: [], shadow: true,
    });
    store.appendEvent({
      ts: 2, queryId: "q", event: "outcome", resolved: false, control: true,
    });
    const agg = computeAggregates(store);
    expect(agg.integrity.shadowControlMismatches).toBe(0);
    expect(agg.integrity.outcomesWithoutRetrieval).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// P4 — EventEmitter unifies SQLite + side-sink fan-out across helpers
// ---------------------------------------------------------------------------

describe("EventEmitter — unified fan-out", () => {
  it("emitAgentUsed through EventEmitter reaches both SQLite and side-sink", () => {
    const store = makeStore();
    const sideCaptured: AnalyticsEvent[] = [];
    const emitter = new EventEmitter(store, (ev) => sideCaptured.push(ev));

    emitAgentUsed(emitter, {
      queryId: "q", blockId: "b", matchSignal: "jaccard", matchScore: 0.5,
    });

    expect(store.countEvents("agent_used")).toBe(1);
    expect(sideCaptured.length).toBe(1);
    expect(sideCaptured[0].event).toBe("agent_used");
  });

  it("emitOutcome through EventEmitter reaches both SQLite and side-sink", () => {
    const store = makeStore();
    const sideCaptured: AnalyticsEvent[] = [];
    const emitter = new EventEmitter(store, (ev) => sideCaptured.push(ev));

    emitOutcome(emitter, {
      queryId: "q", resolved: true, control: false, tokens: 200,
    });

    expect(store.countEvents("outcome")).toBe(1);
    expect(sideCaptured.length).toBe(1);
    expect(sideCaptured[0].event).toBe("outcome");
  });

  it("BlockServer + emit helpers sharing an emitter cover all four event types on one sink", () => {
    const store = makeStore();
    storeActive(store, SAMPLE);
    const captured: AnalyticsEvent[] = [];
    const emitter = new EventEmitter(store, (ev) => captured.push(ev));

    const server = new BlockServer(store, { emitter });
    const out = server.recall({ text: "metaclass inspect" });
    const blockId = out.blocks[0]?.block.id ?? "b";
    emitAgentUsed(emitter, {
      queryId: out.queryId, blockId, matchSignal: "jaccard", matchScore: 0.5,
    });
    emitOutcome(emitter, {
      queryId: out.queryId, resolved: true, control: false,
    });

    const types = new Set(captured.map((e) => e.event));
    expect(types.has("retrieval")).toBe(true);
    expect(types.has("injection")).toBe(true);
    expect(types.has("agent_used")).toBe(true);
    expect(types.has("outcome")).toBe(true);
  });

  it("emitAgentUsed(store) still works as BlockStore back-compat", () => {
    const store = makeStore();
    emitAgentUsed(store, {
      queryId: "q", blockId: "b", matchSignal: "jaccard", matchScore: 0.5,
    });
    expect(store.countEvents("agent_used")).toBe(1);
  });

  it("side-sink exceptions never break EventEmitter.emit", () => {
    const store = makeStore();
    const emitter = new EventEmitter(store, () => { throw new Error("boom"); });
    expect(() => emitAgentUsed(emitter, {
      queryId: "q", blockId: "b", matchSignal: "jaccard", matchScore: 0.5,
    })).not.toThrow();
    expect(store.countEvents("agent_used")).toBe(1);
  });

  it("BlockServer prefers opts.emitter when both emitter and sideSink are given", () => {
    const store = makeStore();
    storeActive(store, SAMPLE);
    const emitterCaptured: AnalyticsEvent[] = [];
    const sideCaptured: AnalyticsEvent[] = [];
    const emitter = new EventEmitter(store, (ev) => emitterCaptured.push(ev));

    const server = new BlockServer(store, {
      emitter,
      sideSink: (ev) => sideCaptured.push(ev),
    });
    server.recall({ text: "metaclass inspect" });

    // emitter fires, sideSink option is ignored (the user should put
    // the sink inside the emitter if they want it covering emit*).
    expect(emitterCaptured.length).toBeGreaterThan(0);
    expect(sideCaptured.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Fact-level analytics (L4 first-class attribution)
// ---------------------------------------------------------------------------

describe("analytics — fact-level attribution", () => {
  it("BlockServer emits fact_injection events for above-gate facts", () => {
    const store = makeStore();
    storeActive(store, SAMPLE);
    // Statement shares tokens with the query so FTS returns a hit;
    // high confidence so the fact clears the default gate (threshold=0).
    store.storeFact({
      scope: "global",
      factType: "convention",
      statement: "metaclass inspection uses the standard library module",
      invariants: { language: "python" },
      source: { origin: "declared" },
      confidence: 0.9,
    });
    const server = new BlockServer(store);
    server.recall({ text: "metaclass inspect", invariants: { language: "python" } });

    const facts = store.readEvents({ eventType: "fact_injection" });
    expect(facts.length).toBe(1);
    const ev = facts[0];
    if (ev.event !== "fact_injection") throw new Error("wrong event");
    expect(ev.factId).toBeTruthy();
    expect(ev.calibratedProb).toBeCloseTo(0.9);
  });

  it("retrieval event carries factCandidates when facts are in the result", () => {
    const store = makeStore();
    storeActive(store, SAMPLE);
    // Statement shares BOTH tokens of the query so FTS AND-match succeeds.
    store.storeFact({
      scope: "global",
      factType: "convention",
      statement: "metaclass inspect convention for this repo",
      invariants: {},
      source: { origin: "declared" },
    });
    const server = new BlockServer(store);
    server.recall({ text: "metaclass inspect" });

    const retr = store.readEvents({ eventType: "retrieval" });
    expect(retr.length).toBe(1);
    const ev = retr[0];
    if (ev.event !== "retrieval") throw new Error("wrong event");
    expect(ev.factCandidates).toBeDefined();
    expect(ev.factCandidates!.length).toBe(1);
    expect(typeof ev.factCandidates![0].factId).toBe("string");
  });

  it("emitFactAgentUsed writes a fact_agent_used event", () => {
    const store = makeStore();
    emitFactAgentUsed(store, {
      queryId: "q", factId: "f1", matchSignal: "explicit", matchScore: 1.0,
    });
    const evs = store.readEvents({ eventType: "fact_agent_used" });
    expect(evs.length).toBe(1);
    const ev = evs[0];
    if (ev.event !== "fact_agent_used") throw new Error("wrong type");
    expect(ev.factId).toBe("f1");
    expect(ev.matchSignal).toBe("explicit");
  });

  it("computeAggregates classifies fact helpful/counter/neutral independently of blocks", () => {
    const store = makeStore();

    // Query q1: fact_injection + fact_agent_used + resolved → fact helpful
    //           block_injection + block_agent_used + resolved → block helpful
    store.appendEvent({
      ts: 1, queryId: "q1", event: "retrieval",
      candidates: [{ blockId: "B1", score: 0.9 }],
      factCandidates: [{ factId: "F1", score: 0.8 }],
      shadow: false,
    });
    store.appendEvent({ ts: 2, queryId: "q1", event: "injection", blockId: "B1", score: 0.9 });
    store.appendEvent({ ts: 3, queryId: "q1", event: "fact_injection", factId: "F1", score: 0.8 });
    store.appendEvent({ ts: 4, queryId: "q1", event: "agent_used", blockId: "B1", matchSignal: "jaccard", matchScore: 0.7 });
    store.appendEvent({ ts: 5, queryId: "q1", event: "fact_agent_used", factId: "F1", matchSignal: "explicit", matchScore: 1.0 });
    store.appendEvent({ ts: 6, queryId: "q1", event: "outcome", resolved: true, control: false });

    // Query q2: fact injected but not used by agent, task resolves → fact neutral
    store.appendEvent({
      ts: 7, queryId: "q2", event: "retrieval",
      candidates: [],
      factCandidates: [{ factId: "F1", score: 0.8 }],
      shadow: false,
    });
    store.appendEvent({ ts: 8, queryId: "q2", event: "fact_injection", factId: "F1", score: 0.8 });
    store.appendEvent({ ts: 9, queryId: "q2", event: "outcome", resolved: true, control: false });

    // Query q3: fact injected + used + NOT resolved → fact counterproductive
    store.appendEvent({
      ts: 10, queryId: "q3", event: "retrieval",
      candidates: [],
      factCandidates: [{ factId: "F1", score: 0.8 }],
      shadow: false,
    });
    store.appendEvent({ ts: 11, queryId: "q3", event: "fact_injection", factId: "F1", score: 0.8 });
    store.appendEvent({ ts: 12, queryId: "q3", event: "fact_agent_used", factId: "F1", matchSignal: "jaccard", matchScore: 0.4 });
    store.appendEvent({ ts: 13, queryId: "q3", event: "outcome", resolved: false, control: false });

    const agg = computeAggregates(store);

    const b1 = agg.perBlock.find((r) => r.blockId === "B1")!;
    expect(b1.helpful).toBe(1);

    const f1 = agg.perFact.find((r) => r.factId === "F1")!;
    expect(f1.injected).toBe(3);
    expect(f1.agentUsed).toBe(2);
    expect(f1.helpful).toBe(1);
    expect(f1.counterproductive).toBe(1);
    expect(f1.neutral).toBe(1);

    expect(agg.rates.factHelpfulRate).toBeCloseTo(1 / 3);
    expect(agg.rates.factCounterproductiveRate).toBeCloseTo(1 / 3);
    expect(agg.rates.factHitRate).toBeCloseTo(2 / 3);
    // Block metrics remain independent.
    expect(agg.rates.helpfulRate).toBeCloseTo(1);
  });

  it("coverage counts queries with EITHER block or fact injection", () => {
    const store = makeStore();
    // Treatment query with only a fact injection.
    store.appendEvent({
      ts: 1, queryId: "q1", event: "retrieval",
      candidates: [], factCandidates: [{ factId: "F1", score: 0.8 }], shadow: false,
    });
    store.appendEvent({ ts: 2, queryId: "q1", event: "fact_injection", factId: "F1", score: 0.8 });
    // Treatment query with no injection at all (gate skipped).
    store.appendEvent({ ts: 3, queryId: "q2", event: "retrieval", candidates: [], shadow: false });
    const agg = computeAggregates(store);
    expect(agg.rates.coverage).toBeCloseTo(0.5);
  });

  it("import strict-rejects fact_injection missing factId", () => {
    const dir = mkdtempSync(join(tmpdir(), "tb-strict-fact-"));
    const path = join(dir, "e.jsonl");
    try {
      writeFileSync(path, `{"ts":1,"queryId":"q","event":"fact_injection","score":0.9}\n`);
      const store = makeStore();
      expect(importEventsFromJsonl(store, path)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("import accepts a valid fact_injection and fact_agent_used", () => {
    const dir = mkdtempSync(join(tmpdir(), "tb-strict-fact-ok-"));
    const path = join(dir, "e.jsonl");
    try {
      writeFileSync(path,
        `{"ts":1,"queryId":"q","event":"fact_injection","factId":"F1","score":0.9}\n` +
        `{"ts":2,"queryId":"q","event":"fact_agent_used","factId":"F1","matchSignal":"explicit","matchScore":1.0}\n`,
      );
      const store = makeStore();
      expect(importEventsFromJsonl(store, path)).toBe(2);
      expect(store.countEvents("fact_injection" as never)).toBe(1);
      expect(store.countEvents("fact_agent_used" as never)).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retrieval event with malformed factCandidates is rejected on import", () => {
    const dir = mkdtempSync(join(tmpdir(), "tb-strict-factcand-"));
    const path = join(dir, "e.jsonl");
    try {
      writeFileSync(path,
        `{"ts":1,"queryId":"q","event":"retrieval","shadow":false,"candidates":[],"factCandidates":[{"factId":"F1"}]}\n`,
      );
      const store = makeStore();
      expect(importEventsFromJsonl(store, path)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fact injection events survive SQLite → JSONL → SQLite round-trip", () => {
    const dir = mkdtempSync(join(tmpdir(), "tb-fact-rt-"));
    const path = join(dir, "e.jsonl");
    try {
      const src = makeStore();
      src.appendEvent(
        { ts: 1, queryId: "q", event: "fact_injection", factId: "F1", score: 0.9 },
        { runId: "rt-1" },
      );
      src.appendEvent(
        { ts: 2, queryId: "q", event: "fact_agent_used", factId: "F1", matchSignal: "jaccard", matchScore: 0.8 },
        { runId: "rt-1" },
      );
      exportEventsToJsonl(src, path);

      const dst = makeStore();
      expect(importEventsFromJsonl(dst, path)).toBe(2);
      const byRun = dst.readEvents({ runId: "rt-1" });
      expect(byRun.length).toBe(2);
      const byFact = dst.readEvents({ factId: "F1" });
      expect(byFact.length).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Schema migration v1 → v2 (analytics_events gets fact_id column)
// ---------------------------------------------------------------------------

describe("BlockStore — v1 → v2 analytics_events migration", () => {
  it("migrates a v1-schema DB through v2 → v3 and accepts new events after", () => {
    const dir = mkdtempSync(join(tmpdir(), "tb-mig-"));
    const path = join(dir, "migrate.db");
    try {
      // Manually construct a v1-shaped DB including reasoning_blocks,
      // analytics_events (with the legacy CHECK), and schema_meta. We
      // must include reasoning_blocks because the v2→v3 migration ALTERs
      // it to add distillation/validation/verification hook columns.
      const raw = new Database(path);
      raw.exec(`
        CREATE TABLE reasoning_blocks (
          id                  TEXT PRIMARY KEY,
          version             INTEGER NOT NULL,
          created_at          INTEGER NOT NULL,
          updated_at          INTEGER NOT NULL,
          status              TEXT NOT NULL,
          trig_situation      TEXT NOT NULL,
          trig_fingerprint    TEXT NOT NULL,
          trig_keywords       TEXT NOT NULL DEFAULT '[]',
          trig_language       TEXT,
          trig_framework      TEXT,
          trig_error_type     TEXT,
          trig_api_surface    TEXT NOT NULL DEFAULT '[]',
          body_mechanism      TEXT NOT NULL,
          body_dead_ends      TEXT NOT NULL DEFAULT '[]',
          body_unlock         TEXT NOT NULL,
          body_verification   TEXT NOT NULL,
          prov_source_task_id        TEXT NOT NULL,
          prov_source_agent          TEXT,
          prov_source_model          TEXT,
          prov_extracted_from        TEXT NOT NULL,
          prov_distilled_at          INTEGER NOT NULL,
          prov_distilled_by          TEXT NOT NULL,
          prov_distilled_with_model  TEXT,
          prov_parent_trace_id       TEXT,
          stats_times_retrieved        INTEGER NOT NULL DEFAULT 0,
          stats_times_injected         INTEGER NOT NULL DEFAULT 0,
          stats_times_agent_used       INTEGER NOT NULL DEFAULT 0,
          stats_times_helpful          INTEGER NOT NULL DEFAULT 0,
          stats_times_counterproductive INTEGER NOT NULL DEFAULT 0,
          stats_last_used_at           INTEGER,
          stats_cum_tokens_saved       INTEGER NOT NULL DEFAULT 0,
          stats_cum_steps_saved        INTEGER NOT NULL DEFAULT 0,
          qual_confidence          REAL NOT NULL DEFAULT 0.5,
          qual_wilson_lb           REAL NOT NULL DEFAULT 0,
          qual_calibration_cohort  TEXT,
          embed_situation          BLOB,
          embed_unlock             BLOB,
          embed_model              TEXT
        );
        CREATE TABLE analytics_events (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          ts          INTEGER NOT NULL,
          event_type  TEXT NOT NULL CHECK(event_type IN ('retrieval','injection','agent_used','outcome')),
          query_id    TEXT NOT NULL,
          block_id    TEXT,
          run_id      TEXT,
          shadow      INTEGER,
          payload     TEXT NOT NULL
        );
        CREATE TABLE v2_schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO v2_schema_meta(key, value) VALUES ('version', '1');
        INSERT INTO analytics_events (ts, event_type, query_id, run_id, shadow, payload)
          VALUES (1, 'retrieval', 'q1', 'old-run', 0,
                  '{"ts":1,"queryId":"q1","event":"retrieval","candidates":[],"shadow":false}');
      `);
      raw.close();

      // Opening via BlockStore walks v1 → v2 → v3. Legacy rows preserved;
      // new fact events insertable; new provenance/verification columns
      // exist on reasoning_blocks.
      const store = new BlockStore(path);
      const legacy = store.readEvents({ runId: "old-run" });
      expect(legacy.length).toBe(1);

      // Fact event — would violate the v1 CHECK constraint; must now work.
      store.appendEvent({
        ts: 2, queryId: "q2", event: "fact_injection", factId: "F1", score: 0.9,
      });
      expect(store.readEvents({ factId: "F1" }).length).toBe(1);

      // v3 columns exist and round-trip via a block insert.
      const b = createBlock(SAMPLE); b.status = "candidate";
      b.provenance.distillationConfidence = 0.82;
      b.provenance.validationReport = {
        passed: true, checkedAt: 999, checks: [{ name: "leakage", passed: true }],
      };
      b.verification = { status: "unverified" };
      store.storeBlock(b);
      const got = store.getBlock(b.id)!;
      expect(got.provenance.distillationConfidence).toBeCloseTo(0.82);
      expect(got.provenance.validationReport?.passed).toBe(true);
      expect(got.verification?.status).toBe("unverified");

      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});


// ---------------------------------------------------------------------------
// Unit invariant — helpedTasks and verifiedHelpedTasks must share
// units. If verifiedHelpedTasks slipped back to funnel.verifiedHelpfulRuns
// (queryId-distinct) while helpedTasks stayed as Σ perBlock.helpful, then
// any query that helped >1 block would generate a phantom "inferred"
// credit in the savings UI (because the subtraction lies).
// ---------------------------------------------------------------------------
describe("computeAggregates + computeImpact — multi-block single-query helpedTasks/verifiedHelpedTasks unit invariant", () => {
  it("a single explicit-outcome query that helps two blocks yields helpedTasks=2 and verifiedHelpedTasks=2 (no phantom inferred credit)", async () => {
    const { computeImpact } = await import("../../src/core/impact.js");
    const store = new BlockStore(new Database(":memory:"));
    try {
      const queryId = "q-multi-1";
      const blockA = "block-A";
      const blockB = "block-B";
      // Retrieval surfaces both blocks; both pass the gate.
      store.appendEvent({
        ts: 1, queryId, event: "retrieval", shadow: false,
        candidates: [
          { blockId: blockA, score: 0.9 },
          { blockId: blockB, score: 0.88 },
        ],
      });
      store.appendEvent({ ts: 2, queryId, event: "injection", blockId: blockA, score: 0.9 });
      store.appendEvent({ ts: 3, queryId, event: "injection", blockId: blockB, score: 0.88 });
      // The agent uses BOTH.
      emitAgentUsed(store, { queryId, blockId: blockA, matchSignal: "explicit", matchScore: 1.0 });
      emitAgentUsed(store, { queryId, blockId: blockB, matchSignal: "explicit", matchScore: 1.0 });
      // Single explicit outcome — no inferred path at all.
      emitOutcome(store, { queryId, resolved: true, control: false, attribution: "explicit" });

      const agg = computeAggregates(store);
      const impact = computeImpact(agg);

      // 2 blocks * 1 helpful query = 2 per-block helpful credits.
      expect(impact.helpedTasks).toBe(2);
      // verifiedHelpedTasks must be in the SAME unit. Subtracting
      // them must yield zero — no inferred help happened here.
      expect(impact.verifiedHelpedTasks).toBe(2);
      expect(impact.helpedTasks - impact.verifiedHelpedTasks).toBe(0);

      // Sanity: funnel.helpfulRuns is the queryId-distinct count,
      // which IS 1 here. Crossing surfaces (per-block vs per-query)
      // is the whole bug we're regressing against.
      expect(agg.funnel.helpfulRuns).toBe(1);
      expect(agg.funnel.verifiedHelpfulRuns).toBe(1);
    } finally {
      store.close();
    }
  });

  it("two queries — one explicit, one inferred — yields helpedTasks=2 and verifiedHelpedTasks=1 (one truly-inferred credit)", async () => {
    const { computeImpact } = await import("../../src/core/impact.js");
    const store = new BlockStore(new Database(":memory:"));
    try {
      const blockId = "block-X";
      // Query #1 — explicit outcome.
      const q1 = "q-explicit";
      store.appendEvent({ ts: 1, queryId: q1, event: "retrieval", shadow: false, candidates: [{ blockId, score: 0.9 }] });
      store.appendEvent({ ts: 2, queryId: q1, event: "injection", blockId, score: 0.9 });
      emitAgentUsed(store, { queryId: q1, blockId, matchSignal: "explicit", matchScore: 1.0 });
      emitOutcome(store, { queryId: q1, resolved: true, control: false, attribution: "explicit" });

      // Query #2 — Stop-hook inferred outcome.
      const q2 = "q-inferred";
      store.appendEvent({ ts: 10, queryId: q2, event: "retrieval", shadow: false, candidates: [{ blockId, score: 0.85 }] });
      store.appendEvent({ ts: 11, queryId: q2, event: "injection", blockId, score: 0.85 });
      emitAgentUsed(store, { queryId: q2, blockId, matchSignal: "jaccard", matchScore: 0.5 });
      emitOutcome(store, { queryId: q2, resolved: true, control: false, attribution: "inferred" });

      const impact = computeImpact(computeAggregates(store));
      expect(impact.helpedTasks).toBe(2);
      expect(impact.verifiedHelpedTasks).toBe(1);
      expect(impact.helpedTasks - impact.verifiedHelpedTasks).toBe(1);
    } finally {
      store.close();
    }
  });
});
