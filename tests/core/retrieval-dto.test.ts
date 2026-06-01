/**
 * Phase C.2 — privacy-hardened retrieval DTO boundary.
 *
 * Proves a (remote-capable) provider receives ONLY sanitized, bounded DTOs:
 * the intent text is leakage-scrubbed + length-bounded, documents carry opaque
 * ids + scanned token sets (leaky body fields redacted), and a remote provider
 * is refused unless it explicitly opts in.
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import { BlockServer } from "../../src/core/block-serving.js";
import { importPatternsFromJsonl } from "../../src/ingest/import-patterns.js";
import { PATTERN_DTO_SCHEMA_VERSION as V } from "../../src/ingest/pattern-dto.js";
import { buildRetrievalIntent, buildRetrievalDocument, MAX_INTENT_CHARS } from "../../src/core/retrieval-dto.js";
import type {
  RetrievalProvider,
  RetrievalIntent,
  RetrievalContext,
  RetrievalCandidate,
  RetrievalProviderCapabilities,
} from "../../src/core/retrieval-provider.js";
import type { ReasoningBlock } from "../../src/types.js";

const LEAK_PATH = "/Users/alice/secret/app.ts";
const LEAK_SECRET = "sk-ant-deadbeefdeadbeefdeadbeef01";

describe("buildRetrievalIntent", () => {
  it("scrubs leakage spans and bounds the length", () => {
    const intent = buildRetrievalIntent(`fix the bug in ${LEAK_PATH} using key ${LEAK_SECRET} now`, undefined, 5);
    expect(intent.text).not.toContain("/Users");
    expect(intent.text).not.toContain("sk-ant");
    expect(intent.text).toContain("[redacted]");
    expect(intent.limit).toBe(5);
    const long = buildRetrievalIntent("x ".repeat(2000), undefined, 5);
    expect(long.text.length).toBeLessThanOrEqual(MAX_INTENT_CHARS);
  });
});

describe("buildRetrievalDocument", () => {
  it("exposes only an opaque id + scanned tokens; redacts a leaky body field", () => {
    const block = {
      id: "blk-1",
      kind: "success",
      trigger: { situation: "a config merge drops an optional key", invariants: {}, keywords: ["config", "merge", "optional"], fingerprint: "fp-1" },
      body: { mechanism: `the fix lives at ${LEAK_PATH} where the guard is added`, deadEnds: [], unlock: "guard the access", verification: "re-run" },
      provenance: { sourceTaskId: "t1", extractedFrom: "imported", distilledAt: 1, distilledBy: "manual" },
      stats: { timesRetrieved: 0, timesInjected: 0, timesAgentUsed: 0, timesHelpful: 0, timesCounterproductive: 0, cumulativeTokensSaved: 0, cumulativeStepsSaved: 0 },
      quality: { confidence: 0.5 },
      version: 2,
      createdAt: 1,
      updatedAt: 1,
      status: "active",
    } as unknown as ReasoningBlock;
    const doc = buildRetrievalDocument(block);
    expect(doc.blockId).toBe("blk-1");
    // mechanism tripped the leakage guard -> redacted -> no tokens.
    expect(doc.tokens!.mechanism).toEqual([]);
    const all = JSON.stringify(doc);
    expect(all).not.toContain("/Users");
    expect(all).not.toContain("secret");
    // situation tokens still present (clean field).
    expect(doc.tokens!.situation.length).toBeGreaterThan(0);
  });
});

// A fake remote provider that records exactly what crossed the boundary.
class RecordingRemoteProvider implements RetrievalProvider {
  readonly name = "fake-remote";
  readonly capabilities: RetrievalProviderCapabilities;
  received: { intent?: RetrievalIntent; docCount: number; serialized: string } = { docCount: 0, serialized: "" };
  constructor(explicitOptIn: boolean) {
    this.capabilities = { location: "remote", payload: "sanitized-text", explicitOptIn };
  }
  async retrieve(intent: RetrievalIntent, ctx: RetrievalContext): Promise<RetrievalCandidate[] | null> {
    this.received = { intent, docCount: ctx.documents.length, serialized: JSON.stringify({ intent, documents: ctx.documents }) };
    return [];
  }
}

function freshStore(): BlockStore {
  const store = new BlockStore(new Database(":memory:"));
  const dto = JSON.stringify({
    schemaVersion: V,
    pattern: { situation: "a config merge drops an optional key on retry", mechanism: "the absent key yields undefined and is dereferenced without a null guard", unlock: "guard the access before dereferencing", verification: "re-run" },
    scope: { language: "general" },
    signals: { tags: ["null-guard"] },
    provenance: { sourceType: "import", sourceRef: "t:ng", capturedAt: 1, captureVersion: "t" },
  });
  importPatternsFromJsonl(store, dto, { now: 1 });
  return store;
}

describe("remote provider boundary", () => {
  it("refuses a remote provider that has NOT explicitly opted in", async () => {
    const store = freshStore();
    const provider = new RecordingRemoteProvider(false);
    const server = new BlockServer(store, { gateThreshold: 0, retrievalMode: "on", retrievalProvider: provider });
    await server.recallHybrid({ text: "a value was dereferenced while undefined with no guard" });
    expect(provider.received.intent).toBeUndefined(); // never invoked
    store.close();
  });

  it("an opted-in remote provider receives ONLY sanitized intent + scanned documents (no raw prompt/body/path)", async () => {
    const store = freshStore();
    const provider = new RecordingRemoteProvider(true);
    const server = new BlockServer(store, { gateThreshold: 0, retrievalMode: "on", retrievalProvider: provider });
    await server.recallHybrid({ text: `dereferenced undefined value, see ${LEAK_PATH} and ${LEAK_SECRET}` });
    expect(provider.received.intent).toBeDefined();
    expect(provider.received.docCount).toBeGreaterThanOrEqual(1);
    const s = provider.received.serialized;
    expect(s).not.toContain("/Users"); // intent path scrubbed
    expect(s).not.toContain("sk-ant"); // intent secret scrubbed
    // The document carries an opaque id + token arrays, never the raw block JSON
    // (no provenance, fingerprint, stats, or full body sentences cross).
    expect(s).not.toContain("sourceTaskId");
    expect(s).not.toContain("fingerprint");
    expect(s).not.toContain("provenance");
    store.close();
  });
});
