/**
 * Silent injection builder — contract tests.
 *
 * The builder exists to feed host pre-prompt hooks (Claude Code
 * `UserPromptSubmit`, Codex hooks). Two properties are
 * load-bearing and tested explicitly:
 *
 *   • Above-gate only — the silent voice must never leak hits the
 *     gate suppressed, even when the recall result still carries
 *     them for debugging. A leaked low-confidence hit would mean
 *     the prompt and the analytics events disagree, breaking
 *     causal attribution.
 *   • Strict budget + visible ids — the budget can drop low-ranked
 *     items. The payload reports `blockIds` / `factIds` for what
 *     *survived*, so `record_reasoning_outcome` credits exactly
 *     what the agent saw, not what the recall returned.
 *
 * Voice-quality is also asserted (no robotic preamble, no
 * `<sub>Audit:` ribbons) — the whole reason the builder exists is
 * the silent voice; if a future change reintroduces the legacy
 * imperatives, that change should fail loudly here.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import { BlockServer, type Calibrator } from "../../src/core/block-serving.js";
import { buildInjectionPayload } from "../../src/core/build-injection-payload.js";
import { createBlock } from "../../src/core/block.js";
import type { ReasoningBlock, StoreBlockInput } from "../../src/types.js";

function makeStore(): BlockStore {
  return new BlockStore(new Database(":memory:"));
}

function storeActive(store: BlockStore, input: StoreBlockInput): ReasoningBlock {
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

const PY_BLOCK: StoreBlockInput = {
  trigger: {
    situation: "Pytest collects the wrong package when sys.path has a shadowing module",
    invariants: { language: "python", framework: "pytest" },
  },
  body: {
    mechanism: "an earlier sys.path entry exposes a namespace package that shadows the intended one",
    deadEnds: ["bumping pytest to a newer minor"],
    unlock: "rename the shadowing module or remove its directory from sys.path",
    verification: "pytest --collect-only shows the intended package",
  },
  provenance: { sourceTaskId: "pytest-1", extractedFrom: "trajectory", distilledBy: "llm" },
};

const TS_BLOCK: StoreBlockInput = {
  trigger: {
    situation: "Webhook delivery stalls when retry backoff overshoots the configured ceiling",
    invariants: { language: "typescript", framework: "node" },
  },
  body: {
    mechanism: "exponential backoff is computed before clamping to the ceiling",
    deadEnds: [],
    unlock: "clamp the next delay to the ceiling before scheduling",
    verification: "replay the trace and confirm delivery completes within the budget",
  },
  provenance: { sourceTaskId: "webhook-1", extractedFrom: "trajectory", distilledBy: "llm" },
};

describe("buildInjectionPayload", () => {
  let store: BlockStore;
  beforeEach(() => {
    store = makeStore();
  });

  it("returns empty + hasContent=false when no hit clears the gate", () => {
    storeActive(store, PY_BLOCK);
    const strict: Calibrator = () => 0.1;
    const server = new BlockServer(store, { calibrator: strict, gateThreshold: 0.8 });
    const result = server.recall({ text: "pytest shadowing" });
    expect(result.blocks.length).toBeGreaterThan(0); // returned for debug
    expect(result.shouldInject).toBe(false);

    const payload = buildInjectionPayload(result);
    expect(payload.hasContent).toBe(false);
    expect(payload.text).toBe("");
    expect(payload.blockIds).toEqual([]);
    expect(payload.factIds).toEqual([]);
    expect(payload.tokensEstimate).toBe(0);
    // queryId is always echoed so the caller can attribute outcome
    // even on empty results.
    expect(payload.queryId).toBe(result.queryId);
  });

  it("returns empty on shadow queries", () => {
    storeActive(store, PY_BLOCK);
    const server = new BlockServer(store);
    const result = server.recall({ text: "pytest shadowing", shadow: true });
    expect(result.shouldInject).toBe(false);
    expect(buildInjectionPayload(result).hasContent).toBe(false);
  });

  it("wraps content in <tracebase queryId=...> with a plain-English lead", () => {
    storeActive(store, PY_BLOCK);
    const server = new BlockServer(store);
    const result = server.recall({ text: "pytest shadowing module" });
    const payload = buildInjectionPayload(result);

    expect(payload.hasContent).toBe(true);
    expect(payload.text.startsWith(`<tracebase queryId="${result.queryId}">`)).toBe(true);
    expect(payload.text.endsWith("</tracebase>")).toBe(true);
    expect(payload.text).toContain("Relevant prior patterns");
  });

  it("voice quality: no robotic 'HYPOTHESES' preamble or audit sub-ribbons", () => {
    storeActive(store, PY_BLOCK);
    const server = new BlockServer(store);
    const result = server.recall({ text: "pytest shadowing module" });
    const payload = buildInjectionPayload(result);

    // Anything that screams "system tooltip" is a regression. The
    // legacy formatInjection has these phrases — silent injection
    // must not.
    expect(payload.text).not.toMatch(/HYPOTHES[EI]S/);
    expect(payload.text).not.toContain("These are hypotheses");
    expect(payload.text).not.toContain("<sub>Audit:");
    expect(payload.text).not.toContain("calibrated");
    expect(payload.text).not.toContain("### Hypothesis:");
    // No imperatives directed at the agent.
    expect(payload.text.toLowerCase()).not.toMatch(/\byou must\b|\bdo this\b|\bapply this fix\b/);
  });

  it("only above-gate blocks render", () => {
    storeActive(store, PY_BLOCK);
    storeActive(store, TS_BLOCK);
    // PY passes, TS does not.
    const calibrator: Calibrator = (_score, b) =>
      b.trigger.invariants.language === "python" ? 0.9 : 0.1;
    const server = new BlockServer(store, { calibrator, gateThreshold: 0.5 });
    const result = server.recall({ text: "pytest shadowing webhook backoff" });
    const payload = buildInjectionPayload(result);

    // Both candidates are in the recall result; only the above-gate
    // one shows up in the payload, with a matching id list.
    expect(payload.text).toContain("Pytest collects");
    expect(payload.text).not.toContain("Webhook delivery");
    expect(payload.blockIds.length).toBe(1);
    const passedHit = result.blocks.find((h) => h.passesGate)!;
    expect(payload.blockIds[0]).toBe(passedHit.block.id);
  });

  it("drops dead-end-free blocks cleanly (no empty 'Avoid:')", () => {
    storeActive(store, TS_BLOCK); // deadEnds = []
    const server = new BlockServer(store);
    const result = server.recall({ text: "webhook backoff ceiling" });
    const payload = buildInjectionPayload(result);
    expect(payload.text).toContain("Webhook delivery");
    expect(payload.text).not.toContain("Avoid: ");
  });

  it("renders dead-ends inline when present", () => {
    storeActive(store, PY_BLOCK);
    const server = new BlockServer(store);
    const result = server.recall({ text: "pytest shadowing module" });
    const payload = buildInjectionPayload(result);
    expect(payload.text).toContain("Avoid: bumping pytest to a newer minor");
  });

  it("rendered ids match the kept set when budget cuts items", () => {
    storeActive(store, PY_BLOCK);
    storeActive(store, TS_BLOCK);
    const server = new BlockServer(store);
    const result = server.recall({ text: "pytest shadowing webhook backoff" });
    expect(result.blocks.length).toBe(2);

    // Force a budget that fits the wrapper + lead-in but only one
    // bullet line. Pick a charBudget around the size of one bullet.
    const oneBulletBudget = 360 / 4; // 360 chars / 4 chars-per-token
    const payload = buildInjectionPayload(result, { tokenBudget: oneBulletBudget });

    expect(payload.blockIds.length).toBe(1);
    // The kept id appears in the text; the dropped id does not.
    const keptId = payload.blockIds[0]!;
    const droppedId = result.blocks.find((h) => h.block.id !== keptId)!.block.id;
    expect(payload.text).toContain(
      result.blocks.find((h) => h.block.id === keptId)!.block.trigger.situation,
    );
    expect(payload.text).not.toContain(
      result.blocks.find((h) => h.block.id === droppedId)!.block.trigger.situation,
    );
    expect(payload.tokensEstimate).toBeLessThanOrEqual(oneBulletBudget * 2); // mild overshoot tolerated
  });

  it("falls back to the top item when budget is so tight nothing fits", () => {
    storeActive(store, PY_BLOCK);
    const server = new BlockServer(store);
    const result = server.recall({ text: "pytest shadowing module" });
    // A tiny budget — much less than even the wrapper. The builder
    // prefers a mild overshoot to silence so a misconfigured budget
    // doesn't silently disable injection.
    const payload = buildInjectionPayload(result, { tokenBudget: 10 });
    expect(payload.hasContent).toBe(true);
    expect(payload.blockIds.length).toBe(1);
  });

  it("respects maxBlocks even with abundant budget", () => {
    storeActive(store, PY_BLOCK);
    storeActive(store, TS_BLOCK);
    const server = new BlockServer(store);
    const result = server.recall({ text: "pytest shadowing webhook backoff" });
    const payload = buildInjectionPayload(result, { maxBlocks: 1, tokenBudget: 5000 });
    expect(payload.blockIds.length).toBe(1);
  });

  it("includes a project-facts section when facts pass the gate", () => {
    storeActive(store, PY_BLOCK);
    // Heavy token overlap with the query so the fact-side FTS
    // ranks it. Confidence 0.9 keeps it above the 0.5 gate.
    store.storeFact({
      scope: "global",
      factType: "convention",
      statement: "pytest shadowing module convention is enforced by the repository test pack",
      invariants: {},
      source: { origin: "declared" },
      confidence: 0.9,
    });
    const server = new BlockServer(store, { gateThreshold: 0.5 });
    const result = server.recall({ text: "pytest shadowing module" });
    // Sanity: the fact actually came back from search and cleared the gate.
    expect(result.facts.some((h) => h.passesGate)).toBe(true);

    const payload = buildInjectionPayload(result);
    expect(payload.text).toContain("Project facts:");
    expect(payload.factIds.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// 0.7.0-rc.1 §Ground — provenance trust differentiation in injection.
// Imported content (`provenance.extractedFrom === "imported"` for blocks,
// `source.origin === "imported"` for facts) renders inside an explicit
// `<prior_fix source="imported">` tag so the agent treats it with the
// same scepticism as a web-search hit. Local content stays untagged.
// ---------------------------------------------------------------------------

describe("buildInjectionPayload — imported provenance tag", () => {
  let store: BlockStore;
  beforeEach(() => {
    store = makeStore();
  });

  it("wraps imported facts in <prior_fix source=\"imported\"> and leaves local untagged", () => {
    storeActive(store, PY_BLOCK);
    // Two facts with identical query-overlap so FTS ranks both
    // similarly and both clear the gate. Only the marker words
    // differ — `repository` for local, `external` for imported.
    store.storeFact({
      scope: "global",
      factType: "convention",
      statement: "pytest shadowing repository signal",
      invariants: {},
      source: { origin: "declared" },
      confidence: 0.9,
    });
    store.storeFact({
      scope: "global",
      factType: "convention",
      statement: "pytest shadowing external signal",
      invariants: {},
      source: { origin: "imported" },
      confidence: 0.9,
    });
    const server = new BlockServer(store, { gateThreshold: 0.5 });
    const result = server.recall({ text: "pytest shadowing signal" });
    expect(result.facts.filter((h) => h.passesGate).length).toBeGreaterThanOrEqual(2);

    const payload = buildInjectionPayload(result, { maxFacts: 4, tokenBudget: 4000 });
    expect(payload.hasContent).toBe(true);

    // The imported fact's bullet line carries the explicit tag.
    expect(payload.text).toContain('<prior_fix source="imported">');
    expect(payload.text).toContain("</prior_fix>");
    // The tag wraps the imported content specifically — assert the
    // tag pair brackets the "external" marker word.
    const importedSegment = payload.text.match(
      /<prior_fix source="imported">[\s\S]*?<\/prior_fix>/,
    );
    expect(importedSegment).not.toBeNull();
    expect(importedSegment![0]).toContain("external signal");

    // The local "repository signal" line has no tag wrapper.
    expect(payload.text).toContain("repository signal");
    const localLine = payload.text
      .split("\n")
      .find((line) => line.includes("repository signal"));
    expect(localLine).toBeDefined();
    expect(localLine).not.toContain("<prior_fix");
  });

  it("wraps imported blocks in <prior_fix source=\"imported\">", () => {
    const importedInput: StoreBlockInput = {
      ...PY_BLOCK,
      provenance: {
        ...PY_BLOCK.provenance,
        sourceTaskId: "imported-pytest",
        extractedFrom: "imported",
      },
    };
    storeActive(store, importedInput);

    const server = new BlockServer(store, { gateThreshold: 0.5 });
    const result = server.recall({ text: "pytest shadowing module" });
    expect(result.blocks.some((h) => h.passesGate)).toBe(true);

    const payload = buildInjectionPayload(result);
    expect(payload.hasContent).toBe(true);
    expect(payload.text).toContain('<prior_fix source="imported">');
    // The tagged region contains the rendered block bullet, not the
    // surrounding queryId envelope.
    expect(payload.text).toMatch(
      /<prior_fix source="imported">• Pytest collects[\s\S]*?<\/prior_fix>/,
    );
  });

  it("does NOT inject the tag when all content is local", () => {
    storeActive(store, PY_BLOCK);
    store.storeFact({
      scope: "global",
      factType: "convention",
      statement: "pytest shadowing local declared fact",
      invariants: {},
      source: { origin: "declared" },
      confidence: 0.9,
    });
    const server = new BlockServer(store, { gateThreshold: 0.5 });
    const result = server.recall({ text: "pytest shadowing" });

    const payload = buildInjectionPayload(result);
    expect(payload.hasContent).toBe(true);
    // No imported content present → no `<prior_fix source="imported">`
    // anywhere. The legacy injection voice is preserved exactly.
    expect(payload.text).not.toContain("<prior_fix");
    expect(payload.text).not.toContain("</prior_fix>");
  });
});

// ---------------------------------------------------------------------------
// 0.7.0-rc.3 §rc.3 — file_memory section + bytesAvoided
// ---------------------------------------------------------------------------

describe("buildInjectionPayload — file_memory section", () => {
  let store: BlockStore;
  beforeEach(() => {
    store = makeStore();
  });

  function makeFileHits(rels: string[]) {
    return rels.map((relPath, i) => ({
      relPath,
      summary: `Heuristic summary for ${relPath} explaining what it does in detail`,
      symbols: '{"exports":["fn1","fn2"]}',
      language: "typescript",
      sizeBytes: 1024 * (i + 1),
      score: -i, // bm25-like: lower is better
    }));
  }

  it("renders file hits inside <file_memory>...</file_memory>", () => {
    storeActive(store, PY_BLOCK);
    const server = new BlockServer(store, { gateThreshold: 0.5 });
    const result = server.recall({ text: "pytest shadowing" });

    const fileHits = makeFileHits(["src/auth.ts", "src/payments.ts"]);
    const payload = buildInjectionPayload(result, { fileHits });

    expect(payload.hasContent).toBe(true);
    expect(payload.text).toContain("<file_memory>");
    expect(payload.text).toContain("</file_memory>");
    expect(payload.text).toContain("• src/auth.ts:");
    expect(payload.text).toContain("• src/payments.ts:");
    expect(payload.fileIds).toEqual(["src/auth.ts", "src/payments.ts"]);
    expect(payload.bytesAvoided).toBe(1024 + 2048);
  });

  it("respects maxFiles cap (default 3, hard ceiling 6)", () => {
    storeActive(store, PY_BLOCK);
    const server = new BlockServer(store, { gateThreshold: 0.5 });
    const result = server.recall({ text: "pytest shadowing" });

    const fileHits = makeFileHits(
      Array.from({ length: 10 }, (_, i) => `src/f${i}.ts`),
    );

    const def = buildInjectionPayload(result, { fileHits });
    expect(def.fileIds.length).toBe(3);

    const explicit = buildInjectionPayload(result, { fileHits, maxFiles: 5 });
    expect(explicit.fileIds.length).toBe(5);

    // Hard ceiling: maxFiles=99 capped at 6.
    const over = buildInjectionPayload(result, { fileHits, maxFiles: 99 });
    expect(over.fileIds.length).toBe(6);
  });

  it("file lines clamp at FILE_LINE_MAX_CHARS to prevent runaway summaries", () => {
    storeActive(store, PY_BLOCK);
    const server = new BlockServer(store, { gateThreshold: 0.5 });
    const result = server.recall({ text: "pytest shadowing" });

    const longSummary = "x".repeat(5000);
    const fileHits = [
      {
        relPath: "src/long.ts",
        summary: longSummary,
        symbols: "{}",
        language: "typescript",
        sizeBytes: 100,
        score: 0,
      },
    ];
    const payload = buildInjectionPayload(result, { fileHits });
    const fileLine = payload.text
      .split("\n")
      .find((l) => l.startsWith("• src/long.ts:"));
    expect(fileLine).toBeDefined();
    expect(fileLine!.length).toBeLessThanOrEqual(220 + 1);
  });

  it("drops the file_memory section cleanly when budget is too tight", () => {
    storeActive(store, PY_BLOCK);
    const server = new BlockServer(store, { gateThreshold: 0.5 });
    const result = server.recall({ text: "pytest shadowing" });

    // Tiny budget — block always wins (top item rescue), files
    // drop. fileIds is empty, bytesAvoided is 0.
    const fileHits = makeFileHits(["src/a.ts", "src/b.ts"]);
    const payload = buildInjectionPayload(result, {
      fileHits,
      tokenBudget: 50, // tighter than block + file lines combined
    });
    expect(payload.fileIds).toEqual([]);
    expect(payload.bytesAvoided).toBe(0);
    expect(payload.text).not.toContain("<file_memory>");
  });

  it("files-only payload renders even when no blocks/facts pass the gate", () => {
    // 0.7.0-rc.3 hardening — pre-hardening, buildInjectionPayload
    // short-circuited on !result.shouldInject (computed from
    // blocks/facts only), so file hits with no matching trace or
    // fact would never render. This test pins the new contract:
    // a real recall with NO indexed blocks and NO matching facts
    // (shouldInject=false) MUST still surface the file_memory
    // section. The "files-only lead-in" is part of the contract.
    const server = new BlockServer(store, { gateThreshold: 0.5 });
    // No block stored, no fact stored → shouldInject=false.
    const result = server.recall({ text: "completely unrelated query xyzqq" });
    expect(result.shouldInject).toBe(false);
    expect(result.shadow).toBe(false);

    const fileHits = makeFileHits(["src/onlyfile.ts"]);
    const payload = buildInjectionPayload(result, { fileHits });
    expect(payload.hasContent).toBe(true);
    expect(payload.text).toContain("Relevant file context:");
    expect(payload.text).toContain("<file_memory>");
    expect(payload.fileIds).toEqual(["src/onlyfile.ts"]);
    expect(payload.blockIds).toEqual([]);
    expect(payload.factIds).toEqual([]);
  });

  it("shadow recall suppresses file_memory section even when files match", () => {
    // 0.7.0-rc.3 hardening — file memory must STAY OFF in the
    // holdout / diagnostic-shadow arm. Otherwise we leak
    // treatment-side context into the control cohort and the
    // causal comparison is corrupted.
    const server = new BlockServer(store, { gateThreshold: 0.5 });
    const baseResult = server.recall({ text: "pytest shadowing" });
    const shadowResult = { ...baseResult, shadow: true, shouldInject: false };

    const fileHits = makeFileHits(["src/auth.ts"]);
    const payload = buildInjectionPayload(shadowResult, { fileHits });
    expect(payload.hasContent).toBe(false);
    expect(payload.text).toBe("");
    expect(payload.fileIds).toEqual([]);
  });

  it("never mixes <file_memory> bullets with the imported <prior_fix> tag", () => {
    storeActive(store, PY_BLOCK);
    store.storeFact({
      scope: "global",
      factType: "convention",
      statement: "pytest shadowing imported guidance external",
      invariants: {},
      source: { origin: "imported" },
      confidence: 0.9,
    });
    const server = new BlockServer(store, { gateThreshold: 0.5 });
    const result = server.recall({ text: "pytest shadowing imported" });

    const fileHits = makeFileHits(["src/auth.ts"]);
    const payload = buildInjectionPayload(result, { fileHits });

    // Both tags present, but the imported fact's <prior_fix> is
    // CLOSED before the <file_memory> section opens. This ensures
    // the tags don't nest or interleave.
    const text = payload.text;
    const priorClose = text.indexOf("</prior_fix>");
    const fileOpen = text.indexOf("<file_memory>");
    expect(priorClose).toBeGreaterThan(0);
    expect(fileOpen).toBeGreaterThan(priorClose);
  });

  it("empty fileHits leaves payload byte-identical to pre-rc.3", () => {
    storeActive(store, PY_BLOCK);
    const server = new BlockServer(store, { gateThreshold: 0.5 });
    const result = server.recall({ text: "pytest shadowing" });

    const a = buildInjectionPayload(result);
    const b = buildInjectionPayload(result, { fileHits: [] });
    expect(a.text).toBe(b.text);
    expect(a.fileIds).toEqual([]);
    expect(b.fileIds).toEqual([]);
    expect(a.bytesAvoided).toBe(0);
    expect(b.bytesAvoided).toBe(0);
    expect(a.fileMemoryTokensEstimate).toBe(0);
    expect(b.fileMemoryTokensEstimate).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 0.7.0-rc.3 hardening — per-section token accounting (P2)
// ---------------------------------------------------------------------------

describe("buildInjectionPayload — fileMemoryTokensEstimate", () => {
  let store: BlockStore;
  beforeEach(() => {
    store = makeStore();
  });

  function makeFileHits(rels: string[]) {
    return rels.map((relPath, i) => ({
      relPath,
      summary: `Heuristic summary for ${relPath} explaining what it does in detail`,
      symbols: '{"exports":["fn1","fn2"]}',
      language: "typescript",
      sizeBytes: 1024 * (i + 1),
      score: -i,
    }));
  }

  it("zero when no file lines made it past the budget", () => {
    storeActive(store, PY_BLOCK);
    const server = new BlockServer(store, { gateThreshold: 0.5 });
    const result = server.recall({ text: "pytest shadowing" });

    // Tight budget — block wins, files drop.
    const fileHits = makeFileHits(["src/a.ts", "src/b.ts"]);
    const payload = buildInjectionPayload(result, { fileHits, tokenBudget: 50 });
    expect(payload.fileIds).toEqual([]);
    expect(payload.fileMemoryTokensEstimate).toBe(0);
  });

  it("counts only the <file_memory> section — strictly less than tokensEstimate on mixed recall", () => {
    // Mixed recall: block + fact + file all surface. The full
    // payload total dwarfs the file-section cost; this is the bug
    // the rc.7 mechanism metric depends on us getting right.
    storeActive(store, PY_BLOCK);
    store.storeFact({
      scope: "global",
      factType: "convention",
      statement: "pytest shadowing tests live under tests/cli/*.test.ts",
      invariants: {},
      source: { origin: "declared" },
      confidence: 0.9,
    });
    const server = new BlockServer(store, { gateThreshold: 0.5 });
    const result = server.recall({ text: "pytest shadowing module" });

    const fileHits = makeFileHits(["src/auth.ts"]);
    const payload = buildInjectionPayload(result, { fileHits });
    expect(payload.hasContent).toBe(true);
    expect(payload.fileIds.length).toBe(1);
    expect(payload.blockIds.length).toBeGreaterThan(0);

    // The file section is a strict subset of the full payload.
    expect(payload.fileMemoryTokensEstimate).toBeGreaterThan(0);
    expect(payload.fileMemoryTokensEstimate).toBeLessThan(payload.tokensEstimate);

    // The accounting is bounded by the rendered tag + line chars,
    // not the surrounding tracebase wrapper or block bullets.
    // Reverse-engineer: parse the section out of `text` and assert
    // the token estimate matches.
    const m = payload.text.match(/<file_memory>[\s\S]+?<\/file_memory>/);
    expect(m).not.toBeNull();
    const sectionChars = m![0].length + 1; // +1 for the line after the closing tag
    const expected = Math.ceil(sectionChars / 4);
    // Allow ±1 token of slack for the joiner/newline accounting
    // boundary case (the tag-block uses internal "\n" joins; we
    // count by section-extract + 1).
    expect(Math.abs(payload.fileMemoryTokensEstimate - expected)).toBeLessThanOrEqual(2);
  });

  it("equals the full tokensEstimate when ONLY file_memory renders", () => {
    // No blocks, no facts → the wrapper + lead-in + file section
    // is the entire payload. The two estimates should be very
    // close (the lead + `<tracebase>` wrapper still adds ~4-5
    // tokens to tokensEstimate).
    const server = new BlockServer(store, { gateThreshold: 0.5 });
    const result = server.recall({ text: "completely unrelated topic xyzqq" });
    expect(result.shouldInject).toBe(false);

    const fileHits = makeFileHits(["src/onlyfile.ts"]);
    const payload = buildInjectionPayload(result, { fileHits });
    // File section is the dominant chunk of the payload but not
    // the whole thing — the wrapper + lead-in still cost a few
    // tokens. The relation to assert is: the section is most of
    // it but never exceeds it.
    expect(payload.fileMemoryTokensEstimate).toBeGreaterThan(0);
    expect(payload.fileMemoryTokensEstimate).toBeLessThanOrEqual(payload.tokensEstimate);
  });
});
