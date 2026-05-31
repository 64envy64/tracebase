/**
 * Generic JSONL importer (Phase 4) + the dual-path boundary proof.
 *
 * One runtime-captured pattern and one imported pattern enter BlockStore through
 * the same ingestion path; retrieval does not care which source produced them.
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import { BlockServer } from "../../src/core/block-serving.js";
import { captureTurnFromTexts } from "../../src/runtime/capture-turn.js";
import { importPatternsFromJsonl, formatImportSummary } from "../../src/ingest/import-patterns.js";
import { PATTERN_DTO_SCHEMA_VERSION, type ReasoningPatternDTO } from "../../src/ingest/pattern-dto.js";

function makeStore(): BlockStore {
  return new BlockStore(new Database(":memory:"));
}

function dto(situation: string, over: Partial<ReasoningPatternDTO> = {}): ReasoningPatternDTO {
  return {
    schemaVersion: PATTERN_DTO_SCHEMA_VERSION,
    pattern: {
      situation,
      mechanism: `the ${situation} arises from an ordering assumption that does not hold`,
      deadEnds: [],
      unlock: "reorder the operations so the invariant holds before use",
      verification: "the failing case now passes",
    },
    scope: { language: "python" },
    provenance: { sourceType: "import", capturedAt: 1, captureVersion: "v1" },
    ...over,
  };
}

const jsonl = (...ds: ReasoningPatternDTO[]): string => ds.map((d) => JSON.stringify(d)).join("\n");

describe("importPatternsFromJsonl", () => {
  it("imports valid records and makes them recallable; reports a summary", () => {
    const store = makeStore();
    const s = importPatternsFromJsonl(
      store,
      jsonl(dto("asyncio task cancellation swallows the CancelledError"), dto("numpy broadcasting mismatch on ragged arrays")),
    );
    expect(s.total).toBe(2);
    expect(s.accepted).toBe(2);
    expect(store.countBlocks("active")).toBe(2);

    const server = new BlockServer(store);
    const hit = server.recall({ text: "asyncio task cancellation swallows CancelledError" });
    expect(hit.shouldInject).toBe(true);
  });

  it("dry-run validates without persisting", () => {
    const store = makeStore();
    const s = importPatternsFromJsonl(store, jsonl(dto("redis pipeline drops the last command on reconnect")), { dryRun: true });
    expect(s.accepted).toBe(1);
    expect(s.dryRun).toBe(true);
    expect(store.countBlocks()).toBe(0);
  });

  it("a malformed JSON line is rejected without aborting the batch", () => {
    const store = makeStore();
    const text = `{ not valid json\n${JSON.stringify(dto("valid kafka consumer rebalance storm under load"))}`;
    const s = importPatternsFromJsonl(store, text);
    expect(s.total).toBe(2);
    expect(s.rejected).toBe(1);
    expect(s.accepted).toBe(1);
    expect(s.results[0]!.reason).toBe("malformed:json");
  });

  it("blank lines are skipped; duplicates collapse", () => {
    const store = makeStore();
    const d = dto("postgres advisory lock leaks across pooled connections");
    const s = importPatternsFromJsonl(store, `${JSON.stringify(d)}\n\n${JSON.stringify(d)}\n`);
    expect(s.total).toBe(2);
    expect(s.accepted).toBe(1);
    expect(s.duplicate).toBe(1);
    expect(store.countBlocks("active")).toBe(1);
  });

  it("formatImportSummary lists rejection reasons", () => {
    const store = makeStore();
    const s = importPatternsFromJsonl(store, `garbage\n${JSON.stringify(dto("valid grpc deadline propagation lost across hops"))}`);
    const line = formatImportSummary(s);
    expect(line).toMatch(/1 accepted/);
    expect(line).toMatch(/line 1: rejected \(malformed:json\)/);
  });

  it("dual-path: a runtime-captured pattern and an imported pattern coexist, source-agnostic", () => {
    const store = makeStore();
    // Runtime capture (real heuristic path).
    captureTurnFromTexts(store, {
      userText:
        "The websocket server fails under load and drops messages because the send buffer overflows " +
        "and back-pressure is never applied, so frames error out and are silently discarded when the " +
        "client is slow.",
      assistantText:
        "The root cause is that the send path enqueues frames without checking the buffer high-water " +
        "mark, so once the socket buffer fills the excess frames are dropped instead of awaited.\n\n" +
        "Apply back-pressure by awaiting drain when the buffer crosses the high-water mark before " +
        "enqueueing more frames, then verify no frames are dropped under a slow-client load test.",
    });
    // Import.
    importPatternsFromJsonl(store, jsonl(dto("graphql n+1 query explosion on nested resolvers")));

    expect(store.countBlocks("active")).toBe(2);
    const server = new BlockServer(store);
    // Both recall; the store has no notion of source at retrieval time.
    expect(server.recall({ text: "websocket server drops messages under load buffer back-pressure" }).shouldInject).toBe(true);
    expect(server.recall({ text: "graphql n+1 query explosion nested resolvers" }).shouldInject).toBe(true);
  });
});
