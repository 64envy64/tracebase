/**
 * attribution-inference — Stop-hook evidence scoring.
 *
 * What's pinned here
 * ------------------
 *  - The tokeniser preserves the symbol shapes that show up in real
 *    agent transcripts (auth_token, --mcp, CORS) and drops the noise
 *    (single letters, punctuation).
 *  - The evidence scorer pulls from `block.body.unlock` +
 *    `block.body.verification`, NOT block.body.mechanism — the former
 *    are where the agent's actual output overlaps; the latter is the
 *    reasoning prose, which would inflate the score on every retrieval
 *    just because the agent echoed the prompt.
 *  - `inferAgentUsedFromTranscript` reads the local injection event
 *    log, scores each against the transcript, and returns the pairs
 *    that crossed the threshold. The lookback window excludes stale
 *    injections so a Stop-hook firing today doesn't credit a block
 *    that was injected last week.
 *  - The function is pure — it never emits events. Wire-up tests in
 *    `tests/cli/capture-turn.test.ts` already cover the emit-on-emit
 *    path; this file isolates the scoring logic.
 */

import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  inferAgentUsedFromTranscript,
  scoreBlockEvidenceAgainstTranscript,
  tokenize,
  DEFAULT_EVIDENCE_THRESHOLD,
  DEFAULT_LOOKBACK_MS,
} from "../../src/runtime/attribution-inference.js";
import { BlockStore } from "../../src/core/block-store.js";
import { storeReasoningPattern } from "../../src/server/mcp-v2-helpers.js";
import type { ReasoningBlock } from "../../src/types.js";

function freshStore(): BlockStore {
  return new BlockStore(new Database(":memory:"));
}

function seedBlock(
  store: BlockStore,
  args: { situation: string; mechanism: string; unlock: string; verification: string },
): { id: string; block: ReasoningBlock } {
  const r = storeReasoningPattern(store, args);
  const block = store.getBlock(r.blockId);
  if (!block) throw new Error("seed failed: block not in store");
  return { id: r.blockId, block };
}

/**
 * May-2026 C2.1 — seed a matching non-shadow retrieval event before
 * any injection. Pre-C2.1 the inference module was lenient: an
 * injection event without a matching retrieval would still credit if
 * the transcript matched. Tightening the gate (production always
 * emits retrieval → injection) means the tests must mirror that
 * causal order. Without this helper, every assertion would fail
 * because the strict gate drops queryIds with no non-shadow
 * retrieval.
 */
function seedRetrieval(
  store: BlockStore,
  queryId: string,
  opts: { runId?: string; ts?: number; shadow?: boolean } = {},
): void {
  const payload: Record<string, unknown> = {
    ts: opts.ts ?? Date.now() - 60_000,
    queryId,
    event: "retrieval",
    candidates: [],
    shadow: opts.shadow ?? false,
  };
  if (opts.runId !== undefined) payload.runId = opts.runId;
  store.appendEvent(payload as never);
}

describe("tokenize", () => {
  it("lowercases and applies the ≥3-char filter", () => {
    const tokens = tokenize("The CORS error in Express API");
    expect(tokens).toContain("cors");
    expect(tokens).toContain("error");
    expect(tokens).toContain("express");
    expect(tokens).toContain("api");
    // "the", "in" — "the" is 3 chars so survives the filter; "in" is
    // 2 and gets dropped. Pinning both behaviours so a later tweak of
    // MIN_TOKEN_LEN can't drift the threshold by accident.
    expect(tokens).toContain("the");
    expect(tokens).not.toContain("in");
  });

  it("keeps underscore and hyphen identifiers intact", () => {
    const tokens = tokenize("set --auth_token in the request and run npm-install");
    expect(tokens).toContain("--auth_token");
    expect(tokens).toContain("npm-install");
  });

  it("drops 1-2 char noise", () => {
    const tokens = tokenize("a b c hi if go to do");
    expect(tokens).toEqual([]);
  });

  it("survives empty / whitespace-only input", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   \n\t  ")).toEqual([]);
  });
});

describe("scoreBlockEvidenceAgainstTranscript", () => {
  it("scores high when the transcript echoes unlock keywords", () => {
    const store = freshStore();
    const { block } = seedBlock(store, {
      situation: "CORS error in Express API on the dashboard frontend.",
      mechanism: "Preflight OPTIONS request is rejected because the origin isn't whitelisted.",
      unlock:
        "Add cors middleware to express and whitelist the auth_token origin. Call app.use(cors()) before the auth router.",
      verification: "Confirm preflight OPTIONS returns 204 and the browser console shows no CORS errors.",
    });
    const transcript =
      "I added the cors middleware to express, called app.use(cors()) before the auth router, whitelisted the auth_token origin, and confirmed preflight OPTIONS returns 204 — the browser console is clean now.";
    const score = scoreBlockEvidenceAgainstTranscript(block, tokenize(transcript));
    expect(score).toBeGreaterThanOrEqual(DEFAULT_EVIDENCE_THRESHOLD);
    store.close();
  });

  it("scores low when the transcript is on a completely different topic", () => {
    const store = freshStore();
    const { block } = seedBlock(store, {
      situation: "CORS error in Express API",
      mechanism: "Preflight OPTIONS rejected because of missing origin whitelist.",
      unlock: "Add cors middleware to express and whitelist the auth_token origin.",
      verification: "OPTIONS preflight returns 204.",
    });
    const transcript =
      "We refactored the database pool to use connection caching and moved the migration runner into a separate worker.";
    const score = scoreBlockEvidenceAgainstTranscript(block, tokenize(transcript));
    expect(score).toBeLessThan(DEFAULT_EVIDENCE_THRESHOLD);
    store.close();
  });

  it("ignores situation/mechanism — only unlock+verification feed evidence", () => {
    const store = freshStore();
    // The situation/mechanism describe the problem in great detail.
    // The unlock/verification are deliberately unrelated bytes. If the
    // scorer were sourcing from mechanism, the transcript that echoes
    // the problem would crank the score even though the agent didn't
    // actually act on the pattern. Pinning the source-of-evidence
    // contract here.
    const { block } = seedBlock(store, {
      situation: "User reports CORS error when calling auth API from the dashboard.",
      mechanism: "Browser sends preflight OPTIONS request that the API rejects.",
      unlock: "completely-unrelated jargon: kefir samovar troika balalaika.",
      verification: "matryoshka pelmeni pirozhki babushka.",
    });
    const transcript =
      "User reports CORS error when calling auth API from the dashboard. The browser sends a preflight OPTIONS request that the API rejects.";
    const score = scoreBlockEvidenceAgainstTranscript(block, tokenize(transcript));
    expect(score).toBeLessThan(DEFAULT_EVIDENCE_THRESHOLD);
    store.close();
  });
});

describe("inferAgentUsedFromTranscript — end-to-end against a real BlockStore", () => {
  it("returns one InferredUse when injection + transcript line up", () => {
    const store = freshStore();
    const { id: blockId } = seedBlock(store, {
      situation: "CORS error when calling the auth API from the dashboard frontend.",
      mechanism: "Preflight OPTIONS request to the auth API is rejected because the origin isn't whitelisted.",
      unlock:
        "Add cors middleware to express and whitelist the auth_token origin. Call app.use(cors()) before the auth router.",
      verification: "Confirm preflight OPTIONS returns 204 and the browser console shows no CORS errors.",
    });

    const queryId = "q-cors-001";
    seedRetrieval(store, queryId); // C2.1 gate: matching non-shadow retrieval required
    store.appendEvent({
      ts: Date.now() - 30_000,
      queryId,
      event: "injection",
      blockId,
      score: 0.85,
    });

    const transcript =
      "I added cors middleware to express, called app.use(cors()) before the auth router, whitelisted the auth_token origin, and confirmed preflight OPTIONS returns 204. The browser console is clean.";

    const uses = inferAgentUsedFromTranscript(store, transcript);
    expect(uses).toHaveLength(1);
    expect(uses[0].queryId).toBe(queryId);
    expect(uses[0].blockId).toBe(blockId);
    expect(uses[0].evidenceScore).toBeGreaterThanOrEqual(DEFAULT_EVIDENCE_THRESHOLD);
    store.close();
  });

  it("returns [] when the transcript shows no evidence of use", () => {
    const store = freshStore();
    const { id: blockId } = seedBlock(store, {
      situation: "CORS error in Express",
      mechanism: "Preflight rejected because of missing origin whitelist.",
      unlock: "Add cors middleware to express, whitelist the auth_token origin.",
      verification: "OPTIONS preflight returns 204.",
    });
    store.appendEvent({
      ts: Date.now() - 30_000,
      queryId: "q-cors-002",
      event: "injection",
      blockId,
      score: 0.85,
    });
    const transcript =
      "We migrated the connection pool to use redis and confirmed the cache hit rate is above 90%.";
    expect(inferAgentUsedFromTranscript(store, transcript)).toEqual([]);
    store.close();
  });

  it("excludes injections older than the lookback window", () => {
    const store = freshStore();
    const { id: blockId } = seedBlock(store, {
      situation: "CORS error in Express",
      mechanism: "Preflight rejected.",
      unlock: "Add cors middleware to express, whitelist the auth_token origin.",
      verification: "OPTIONS preflight returns 204.",
    });
    // 11 minutes ago — outside the 10-minute default window.
    store.appendEvent({
      ts: Date.now() - 11 * 60 * 1000,
      queryId: "q-stale",
      event: "injection",
      blockId,
      score: 0.85,
    });
    const transcript =
      "Added cors middleware to express, whitelisted the auth_token origin, confirmed preflight OPTIONS returns 204.";
    expect(inferAgentUsedFromTranscript(store, transcript)).toEqual([]);
    store.close();
  });

  it("dedupes (queryId, blockId) when the same pair fired multiple injection events", () => {
    const store = freshStore();
    const { id: blockId } = seedBlock(store, {
      situation: "CORS error in Express",
      mechanism: "Preflight rejected.",
      unlock: "Add cors middleware to express, whitelist the auth_token origin.",
      verification: "OPTIONS preflight returns 204.",
    });
    const queryId = "q-dup";
    seedRetrieval(store, queryId);
    for (let i = 0; i < 3; i += 1) {
      store.appendEvent({
        ts: Date.now() - (10_000 - i * 1000),
        queryId,
        event: "injection",
        blockId,
        score: 0.85,
      });
    }
    const transcript =
      "Added cors middleware to express, whitelisted the auth_token origin, confirmed OPTIONS returns 204.";
    expect(inferAgentUsedFromTranscript(store, transcript)).toHaveLength(1);
    store.close();
  });

  it("silently skips injections whose blockId no longer resolves", () => {
    const store = freshStore();
    // Never seed a real block — orphan injection points at a missing id.
    store.appendEvent({
      ts: Date.now() - 30_000,
      queryId: "q-orphan",
      event: "injection",
      blockId: "block-that-doesnt-exist",
      score: 0.85,
    });
    const transcript = "any text — block is gone, scorer has nothing to compare against.";
    expect(inferAgentUsedFromTranscript(store, transcript)).toEqual([]);
    store.close();
  });

  it("respects a custom evidence threshold", () => {
    const store = freshStore();
    const { id: blockId } = seedBlock(store, {
      situation: "CORS error in Express",
      mechanism: "Preflight rejected.",
      unlock: "Add cors middleware and whitelist origin.",
      verification: "Preflight returns 204.",
    });
    seedRetrieval(store, "q-thresh");
    store.appendEvent({
      ts: Date.now() - 30_000,
      queryId: "q-thresh",
      event: "injection",
      blockId,
      score: 0.85,
    });
    // Transcript has only a small token overlap with the block's unlock.
    const transcript = "Added the cors middleware, otherwise unrelated.";
    // Loose threshold should accept it; strict should reject.
    expect(
      inferAgentUsedFromTranscript(store, transcript, { evidenceThreshold: 0.05 }),
    ).toHaveLength(1);
    expect(
      inferAgentUsedFromTranscript(store, transcript, { evidenceThreshold: 0.9 }),
    ).toHaveLength(0);
    store.close();
  });

  it("default lookback constant is a 90-second window — bumped tighter to avoid cross-session leakage on shared workstations", () => {
    expect(DEFAULT_LOOKBACK_MS).toBe(90 * 1000);
  });

  it("scopes by runId when provided — events with a different runId never enter the candidate set", () => {
    const store = freshStore();
    const { id: blockId } = seedBlock(store, {
      situation: "CORS error in Express",
      mechanism: "Preflight rejected.",
      unlock: "Add cors middleware to express, whitelist the auth_token origin.",
      verification: "OPTIONS preflight returns 204.",
    });
    // Inject under runId "session-A".
    seedRetrieval(store, "q-A", { runId: "session-A" });
    store.appendEvent(
      {
        ts: Date.now() - 30_000,
        queryId: "q-A",
        event: "injection",
        blockId,
        score: 0.85,
      },
      { runId: "session-A" },
    );
    const transcript =
      "Added cors middleware to express, whitelisted the auth_token origin, OPTIONS returns 204.";
    // Same transcript, different scope.
    expect(
      inferAgentUsedFromTranscript(store, transcript, { runId: "session-A" }),
    ).toHaveLength(1);
    expect(
      inferAgentUsedFromTranscript(store, transcript, { runId: "session-B" }),
    ).toEqual([]);
    store.close();
  });

  it("skips shadow-arm queries — never credits agent_used on the control cohort", () => {
    const store = freshStore();
    const { id: blockId } = seedBlock(store, {
      situation: "CORS error in Express",
      mechanism: "Preflight rejected.",
      unlock: "Add cors middleware to express, whitelist the auth_token origin.",
      verification: "OPTIONS preflight returns 204.",
    });
    const queryId = "q-shadow";
    // Shadow retrieval — the agent never actually saw the injection.
    store.appendEvent({
      ts: Date.now() - 30_000,
      queryId,
      event: "retrieval",
      candidates: [{ blockId, score: 0.85 }],
      shadow: true,
    });
    store.appendEvent({
      ts: Date.now() - 29_000,
      queryId,
      event: "injection",
      blockId,
      score: 0.85,
    });
    const transcript =
      "Added cors middleware to express, whitelisted the auth_token origin, OPTIONS returns 204.";
    expect(inferAgentUsedFromTranscript(store, transcript)).toEqual([]);
    store.close();
  });
});
