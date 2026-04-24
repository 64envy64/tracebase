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
