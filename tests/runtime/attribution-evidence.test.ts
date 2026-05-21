/**
 * Attribution evidence tests — May-2026 C2.
 *
 * Hand-built event log + synthetic detector inputs. The hand-rolled
 * cases name the failure modes the C2 directive specifically warned
 * about — agent ignored the injection but task succeeded; shadow
 * cohort that shouldn't see agent_used; cross-runId leakage.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import { createBlock } from "../../src/core/block.js";
import {
  detectDiffTouchesRecalledFile,
  detectLoopRedirectFollowed,
  detectTestOrCommandSuccessAfterRedirect,
  detectToolPathMatchesMemory,
  HELPFUL_MIN_STRENGTH,
  isStrictlyHelpful,
  meetsHelpfulThreshold,
  MODERATE_JACCARD_THRESHOLD,
  retrievalIsShadow,
  STRENGTH_RANK,
  STRONG_JACCARD_THRESHOLD,
  strengthFromMatchSignal,
} from "../../src/runtime/attribution-evidence.js";
import type { ReasoningBlock, StoreBlockInput } from "../../src/types.js";

let store: BlockStore;

beforeEach(() => {
  store = new BlockStore(new Database(":memory:"));
});

afterEach(() => {
  store.close();
});

function seedActiveBlock(input: StoreBlockInput): ReasoningBlock {
  const b = createBlock(input);
  b.status = "candidate";
  store.storeBlock(b);
  store.attachCaseRef({
    blockId: b.id,
    traceId: `trace-${b.provenance.sourceTaskId}`,
    role: "origin",
    evidenceQuality: "strong",
  });
  return store.updateBlockStatus(b.id, "active")!;
}

function seedRetrieval(queryId: string, shadow: boolean, runId?: string) {
  const payload: Record<string, unknown> = {
    ts: Date.now(),
    queryId,
    event: "retrieval",
    candidates: [{ blockId: "b-1", score: 0.5 }],
    shadow,
  };
  if (runId) payload.runId = runId;
  store.appendEvent(payload as never);
}

describe("strengthFromMatchSignal", () => {
  it("explicit always wins", () => {
    expect(strengthFromMatchSignal("explicit", 0)).toBe("explicit");
    expect(strengthFromMatchSignal("explicit", 1)).toBe("explicit");
  });

  it("jaccard at strong threshold returns strong", () => {
    expect(strengthFromMatchSignal("jaccard", STRONG_JACCARD_THRESHOLD)).toBe("strong");
    expect(strengthFromMatchSignal("jaccard", 0.9)).toBe("strong");
  });

  it("jaccard at moderate threshold returns moderate", () => {
    expect(strengthFromMatchSignal("jaccard", MODERATE_JACCARD_THRESHOLD)).toBe("moderate");
    expect(strengthFromMatchSignal("jaccard", 0.30)).toBe("moderate");
  });

  it("jaccard below moderate threshold returns weak", () => {
    expect(strengthFromMatchSignal("jaccard", 0.1)).toBe("weak");
    expect(strengthFromMatchSignal("jaccard", 0)).toBe("weak");
  });

  it("embedding uses the same ladder", () => {
    expect(strengthFromMatchSignal("embedding", 0.5)).toBe("strong");
    expect(strengthFromMatchSignal("embedding", 0.20)).toBe("moderate");
    expect(strengthFromMatchSignal("embedding", 0.10)).toBe("weak");
  });
});

describe("STRENGTH_RANK + HELPFUL_MIN_STRENGTH", () => {
  it("strength rank is monotonic explicit > strong > moderate > weak", () => {
    expect(STRENGTH_RANK.explicit).toBeGreaterThan(STRENGTH_RANK.strong);
    expect(STRENGTH_RANK.strong).toBeGreaterThan(STRENGTH_RANK.moderate);
    expect(STRENGTH_RANK.moderate).toBeGreaterThan(STRENGTH_RANK.weak);
  });

  it("HELPFUL_MIN_STRENGTH=moderate: weak does NOT meet, moderate does", () => {
    expect(HELPFUL_MIN_STRENGTH).toBe("moderate");
    expect(meetsHelpfulThreshold("weak")).toBe(false);
    expect(meetsHelpfulThreshold("moderate")).toBe(true);
    expect(meetsHelpfulThreshold("strong")).toBe(true);
    expect(meetsHelpfulThreshold("explicit")).toBe(true);
  });
});

describe("retrievalIsShadow", () => {
  it("returns true when retrieval event is missing (defensive)", () => {
    expect(retrievalIsShadow({ queryId: "missing", store })).toBe(true);
  });

  it("returns true when retrieval event has shadow=true", () => {
    seedRetrieval("q-shadow", true);
    expect(retrievalIsShadow({ queryId: "q-shadow", store })).toBe(true);
  });

  it("returns false when retrieval event has shadow=false", () => {
    seedRetrieval("q-normal", false);
    expect(retrievalIsShadow({ queryId: "q-normal", store })).toBe(false);
  });

  it("respects runId filter — cross-runId leakage prevented", () => {
    seedRetrieval("q-x", false, "session-A");
    // Same queryId, different runId — should NOT match.
    expect(retrievalIsShadow({ queryId: "q-x", store, runId: "session-B" })).toBe(true);
    // Same runId → finds the event.
    expect(retrievalIsShadow({ queryId: "q-x", store, runId: "session-A" })).toBe(false);
  });
});

describe("detectDiffTouchesRecalledFile", () => {
  it("emits strong evidence when a touched path matches a recalled file", () => {
    seedRetrieval("q-1", false);
    const out = detectDiffTouchesRecalledFile(
      { queryId: "q-1", store },
      ["src/app/auth.ts"],
      [{ id: "file-1", path: "src/app/auth.ts" }],
    );
    expect(out).toEqual([{ id: "file-1", kind: "diff_touches_recalled_file", strength: "strong" }]);
  });

  it("normalises Windows-style backslashes against POSIX paths", () => {
    seedRetrieval("q-1", false);
    const out = detectDiffTouchesRecalledFile(
      { queryId: "q-1", store },
      ["src\\app\\auth.ts"],
      [{ id: "file-1", path: "src/app/auth.ts" }],
    );
    expect(out.length).toBe(1);
  });

  it("returns empty when retrieval was shadow (no agent_used for control cohort)", () => {
    seedRetrieval("q-shadow", true);
    const out = detectDiffTouchesRecalledFile(
      { queryId: "q-shadow", store },
      ["src/app/auth.ts"],
      [{ id: "file-1", path: "src/app/auth.ts" }],
    );
    expect(out).toEqual([]);
  });

  it("returns empty when no touched paths overlap (false-positive guard)", () => {
    seedRetrieval("q-1", false);
    const out = detectDiffTouchesRecalledFile(
      { queryId: "q-1", store },
      ["src/unrelated/util.ts"],
      [{ id: "file-1", path: "src/app/auth.ts" }],
    );
    expect(out).toEqual([]);
  });
});

describe("detectToolPathMatchesMemory", () => {
  it("emits strong evidence when tool arg contains a body anchor substring", () => {
    seedRetrieval("q-1", false);
    const b = seedActiveBlock({
      trigger: { situation: "pytest collects wrong package", invariants: {} },
      body: {
        mechanism: "x",
        deadEnds: [],
        unlock: "rename the conftest.py at repo root",
        verification: "pytest --collect-only succeeds",
      },
      provenance: { sourceTaskId: "p-1", extractedFrom: "trajectory", distilledBy: "llm" },
    });
    const out = detectToolPathMatchesMemory(
      { queryId: "q-1", store },
      "rm /repo/conftest.py",
      [b],
    );
    expect(out).toEqual([
      { id: b.id, kind: "tool_path_matches_memory", strength: "strong" },
    ]);
  });

  it("returns empty on shadow cohort", () => {
    seedRetrieval("q-shadow", true);
    const b = seedActiveBlock({
      trigger: { situation: "pytest collects wrong package", invariants: {} },
      body: { mechanism: "x", deadEnds: [], unlock: "rename conftest.py at repo root", verification: "z" },
      provenance: { sourceTaskId: "p-1", extractedFrom: "trajectory", distilledBy: "llm" },
    });
    const out = detectToolPathMatchesMemory({ queryId: "q-shadow", store }, "rm /repo/conftest.py", [b]);
    expect(out).toEqual([]);
  });

  it("ignores trivial overlap (less than 6 contiguous chars)", () => {
    seedRetrieval("q-1", false);
    const b = seedActiveBlock({
      trigger: { situation: "trivial unlock", invariants: {} },
      body: { mechanism: "x", deadEnds: [], unlock: "use", verification: "ok" },
      provenance: { sourceTaskId: "p-2", extractedFrom: "trajectory", distilledBy: "llm" },
    });
    const out = detectToolPathMatchesMemory({ queryId: "q-1", store }, "use some random arg", [b]);
    expect(out).toEqual([]); // unlock too short to anchor
  });
});

describe("detectLoopRedirectFollowed", () => {
  beforeEach(() => seedRetrieval("q-redirect", false));

  it("credits strong evidence when next tool diverges from the looping pattern", () => {
    const out = detectLoopRedirectFollowed(
      { queryId: "q-redirect", store },
      "block-redirect",
      { toolName: "Read", argKey: "configX" },
      { toolName: "Bash", argKey: "lsX" }, // different tool entirely
    );
    expect(out).toEqual([
      { id: "block-redirect", kind: "loop_redirect_followed", strength: "strong" },
    ]);
  });

  it("does NOT credit when next observation matches the loop (agent kept looping)", () => {
    const out = detectLoopRedirectFollowed(
      { queryId: "q-redirect", store },
      "block-redirect",
      { toolName: "Read", argKey: "configX" },
      { toolName: "Read", argKey: "configX" }, // same pattern → agent ignored redirect
    );
    expect(out).toEqual([]);
  });

  it("does NOT credit when there is no next observation (silence is not evidence)", () => {
    const out = detectLoopRedirectFollowed(
      { queryId: "q-redirect", store },
      "block-redirect",
      { toolName: "Read", argKey: "configX" },
      null,
    );
    expect(out).toEqual([]);
  });
});

describe("detectTestOrCommandSuccessAfterRedirect", () => {
  beforeEach(() => seedRetrieval("q-redirect", false));

  it("credits only when followedAlready=true (no fabrication when agent never followed)", () => {
    const success = { kind: "test_pass" as const, ts: Date.now() };
    const followed = detectTestOrCommandSuccessAfterRedirect(
      { queryId: "q-redirect", store },
      "block-redirect",
      /*followedAlready*/ true,
      success,
    );
    expect(followed.length).toBe(1);
    const notFollowed = detectTestOrCommandSuccessAfterRedirect(
      { queryId: "q-redirect", store },
      "block-redirect",
      /*followedAlready*/ false,
      success,
    );
    expect(notFollowed).toEqual([]);
  });

  it("respects shadow gate", () => {
    seedRetrieval("q-redirect-shadow", true);
    const out = detectTestOrCommandSuccessAfterRedirect(
      { queryId: "q-redirect-shadow", store },
      "block-redirect",
      true,
      { kind: "test_pass", ts: Date.now() },
    );
    expect(out).toEqual([]);
  });
});

describe("isStrictlyHelpful — strict §L6 gate (C2)", () => {
  it("rejects when outcome is missing", () => {
    expect(isStrictlyHelpful({ evidenceStrength: "strong" }, null)).toBe(false);
  });

  it("rejects when agent_used is missing", () => {
    expect(isStrictlyHelpful(null, { resolved: true, control: false })).toBe(false);
  });

  it("rejects when outcome.control=true (shadow cohort cannot be helpful)", () => {
    expect(isStrictlyHelpful({ evidenceStrength: "strong" }, { resolved: true, control: true })).toBe(false);
  });

  it("rejects when outcome.resolved=false", () => {
    expect(isStrictlyHelpful({ evidenceStrength: "strong" }, { resolved: false, control: false })).toBe(false);
  });

  it("rejects when evidence is weak even with resolved=true", () => {
    // The directive's named failure mode: outcome.resolved=true must
    // NOT automatically credit every injected item.
    expect(isStrictlyHelpful({ evidenceStrength: "weak" }, { resolved: true, control: false })).toBe(false);
  });

  it("credits moderate evidence with resolved=true", () => {
    expect(isStrictlyHelpful({ evidenceStrength: "moderate" }, { resolved: true, control: false })).toBe(true);
  });

  it("credits strong evidence with resolved=true", () => {
    expect(isStrictlyHelpful({ evidenceStrength: "strong" }, { resolved: true, control: false })).toBe(true);
  });

  it("credits explicit evidence with resolved=true (authoritative)", () => {
    expect(isStrictlyHelpful({ evidenceStrength: "explicit" }, { resolved: true, control: false })).toBe(true);
  });

  it("legacy event (no evidenceStrength): defaults to permissive (legacyAsHelpful=true)", () => {
    // Pre-C2 agent_used rows have no evidenceStrength. The default
    // keeps them counted to preserve dashboard back-compat. Strict
    // aggregators can pass legacyAsHelpful=false.
    expect(isStrictlyHelpful({}, { resolved: true, control: false })).toBe(true);
    expect(isStrictlyHelpful({}, { resolved: true, control: false }, { legacyAsHelpful: false })).toBe(false);
  });
});

describe("false-positive cases the C2 directive named", () => {
  it("injected-but-ignored: no agent_used emission with concrete evidence → no helpful credit", () => {
    // Setup: block injected, outcome resolved, but no diff / tool /
    // anchor evidence. The detectors return empty arrays → no
    // agent_used event → isStrictlyHelpful sees null agent_used.
    seedRetrieval("q-ignored", false);
    const diffEvidence = detectDiffTouchesRecalledFile(
      { queryId: "q-ignored", store },
      [], // empty diff
      [{ id: "file-1", path: "src/x.ts" }],
    );
    expect(diffEvidence).toEqual([]);
    // Even if outcome resolved, no agent_used was emitted, so helpful = false.
    expect(isStrictlyHelpful(null, { resolved: true, control: false })).toBe(false);
  });

  it("success-from-unrelated-fix: task resolved but agent's diff touched UNRELATED files", () => {
    seedRetrieval("q-unrelated", false);
    const out = detectDiffTouchesRecalledFile(
      { queryId: "q-unrelated", store },
      ["src/components/Header.tsx"], // agent fixed something else
      [{ id: "file-1", path: "src/runtime/cache.ts" }], // recalled this file
    );
    expect(out).toEqual([]);
  });

  it("shadow cohort: even with strong corroborating diff, no agent_used emitted", () => {
    seedRetrieval("q-shadow", true);
    const out = detectDiffTouchesRecalledFile(
      { queryId: "q-shadow", store },
      ["src/app/auth.ts"],
      [{ id: "file-1", path: "src/app/auth.ts" }],
    );
    expect(out).toEqual([]);
  });

  it("cross-session leakage: runId mismatch denies attribution", () => {
    seedRetrieval("q-x", false, "session-A");
    // A diff observation in session-B must NOT credit a queryId
    // injected in session-A even though the queryId text matches.
    const out = detectDiffTouchesRecalledFile(
      { queryId: "q-x", store, runId: "session-B" },
      ["src/app/auth.ts"],
      [{ id: "file-1", path: "src/app/auth.ts" }],
    );
    // retrievalIsShadow returns true (no matching retrieval for the
    // other runId) → no credit.
    expect(out).toEqual([]);
  });
});
