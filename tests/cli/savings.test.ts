/**
 * `tracebase savings` — visual dashboard tests.
 *
 * Pins:
 *   - empty store → honest no-data message, no fabricated rows
 *   - per-mechanism rollup matches `computeMechanismSavings`
 *   - per-tool-family rows render only when supervision events fired
 *   - rows sorted by saved tokens descending; impact bar scaled to top row
 *   - efficiency = total / (total + injected), clamped to [0, 1]
 *   - vocabulary contract: every "saved" tagged ("estimated saved" /
 *     "total estimated saved"); never "verified"
 *   - JSON shape includes all four mechanism keys + aggregates
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initConfig, loadConfig } from "../../src/core/config.js";
import { BlockStore } from "../../src/core/block-store.js";
import {
  runSavings,
  renderSavingsDashboard,
  buildMechanismRows,
  buildFamilyRows,
} from "../../src/cli/commands/savings.js";

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "tb-savings-"));
  initConfig(projectDir);
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Open the project's BlockStore once, run the seed callback,
 * close. Multiple back-to-back BlockStore opens against the same
 * SQLite file flap intermittently; one open per test avoids it.
 */
function withStore(fn: (store: BlockStore) => void): void {
  const cfg = loadConfig(projectDir);
  const store = new BlockStore(cfg.storagePath);
  try {
    fn(store);
  } finally {
    store.close();
  }
}

function appendFold(store: BlockStore, idx: number): void {
  store.appendEvent({
    ts: Date.now() - idx * 1000,
    queryId: `f${idx}`,
    event: "context.folded",
    sessionId: "s1",
    chunkRange: `${idx * 8}-${(idx + 1) * 8 - 1}`,
    tokensBefore: 4000,
    tokensAfter: 200,
    summarizer: "heuristic",
  });
}

function appendToolBlock(store: BlockStore, toolName: string, idx: number): void {
  store.appendEvent({
    ts: Date.now() - idx * 1000,
    queryId: `t-${toolName}-${idx}`,
    event: "tool_supervision.suppressed",
    argKey: `k-${toolName}-${idx}`,
    toolName,
    blocked: true,
  });
}

function appendCacheHit(store: BlockStore, surface: "anthropic" | "openai", tokens: number): void {
  store.appendEvent({
    ts: Date.now(),
    queryId: `c-${surface}-${tokens}`,
    event: "cache.prompt_hit",
    surface,
    tokensSaved: tokens,
  });
}

// ---------------------------------------------------------------------------
// runSavings — compute layer
// ---------------------------------------------------------------------------

describe("runSavings — compute", () => {
  it("returns the not-initialized error on uninitialized project", () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "tb-savings-noinit-"));
    try {
      const r = runSavings({ path: elsewhere });
      expect(r.savings.total).toBe(0);
      expect(r.totalEvents).toBe(0);
      expect(r.error).toMatch(/not initialized/);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("returns zero totals when store has no mechanism events yet", () => {
    const r = runSavings({ path: projectDir });
    expect(r.savings.total).toBe(0);
    expect(r.totalEvents).toBe(0);
  });

  it("aggregates all four mechanism components from seeded events", () => {
    withStore((store) => {
      for (let i = 0; i < 3; i++) appendFold(store, i);
      for (let i = 0; i < 4; i++) appendToolBlock(store, "Read", i);
      appendCacheHit(store, "anthropic", 1500);
    });

    const r = runSavings({ path: projectDir });
    expect(r.savings.contextCompressionSaved).toBe(3 * 3800);
    expect(r.savings.toolSupervisionAvoided).toBe(4 * 1500);
    expect(r.savings.promptCacheSaved).toBe(1500);
    expect(r.savings.total).toBe(3 * 3800 + 4 * 1500 + 1500);
    expect(r.totalEvents).toBe(3 + 4 + 1);
  });

  it("efficiency = total / (total + injected), clamped to [0, 1]", () => {
    withStore((store) => {
      for (let i = 0; i < 2; i++) appendFold(store, i); // 2 × 3800 = 7600 saved
      store.appendEvent({
        ts: Date.now(),
        queryId: "r1",
        event: "retrieval",
        candidates: [],
        shadow: false,
        injectedTokensEstimate: 2400,
      });
    });
    const r = runSavings({ path: projectDir });
    expect(r.tokensInjected).toBe(2400);
    expect(r.savings.total).toBe(7600);
    expect(r.efficiency).toBeCloseTo(0.76, 3);
  });
});

// ---------------------------------------------------------------------------
// buildMechanismRows — sorted descending, impact relative to top row
// ---------------------------------------------------------------------------

describe("buildMechanismRows — sort + impact bar scaling", () => {
  it("rows sorted by saved tokens descending; #1 has impact=1.0", () => {
    withStore((store) => {
      for (let i = 0; i < 4; i++) appendFold(store, i); // 4 × 3800 = 15200 (top)
      for (let i = 0; i < 2; i++) appendToolBlock(store, "Read", i); // 2 × 1500 = 3000
      appendCacheHit(store, "anthropic", 800); // 800
    });

    const r = runSavings({ path: projectDir });
    const rows = buildMechanismRows(r);
    expect(rows).toHaveLength(3);
    expect(rows[0]!.name).toBe("context fold");
    expect(rows[0]!.rank).toBe(1);
    expect(rows[0]!.impact).toBe(1);
    expect(rows[1]!.name).toBe("tool supervision");
    expect(rows[1]!.impact).toBeCloseTo(3000 / 15200, 3);
    expect(rows[2]!.name).toBe("prompt cache");
  });

  it("zero-saved mechanisms are dropped from the rendered rows", () => {
    withStore((store) => {
      appendToolBlock(store, "Read", 0);
    });
    const r = runSavings({ path: projectDir });
    const rows = buildMechanismRows(r);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("tool supervision");
  });
});

// ---------------------------------------------------------------------------
// buildFamilyRows — only when supervision fired
// ---------------------------------------------------------------------------

describe("buildFamilyRows — per-tool-family rollup", () => {
  it("returns empty array when no supervision events landed", () => {
    withStore((store) => {
      appendFold(store, 0);
    });
    const r = runSavings({ path: projectDir });
    expect(buildFamilyRows(r)).toHaveLength(0);
  });

  it("groups by canonical ToolFamily; sorts by saved tokens descending", () => {
    withStore((store) => {
      for (let i = 0; i < 5; i++) appendToolBlock(store, "Read", i); // read
      for (let i = 0; i < 2; i++) appendToolBlock(store, "Grep", i); // search
      for (let i = 0; i < 3; i++) appendToolBlock(store, "WebFetch", i); // web
    });
    const r = runSavings({ path: projectDir });
    const rows = buildFamilyRows(r);
    // 5 read × 1500 = 7500   (top)
    // 3 web × 2000 = 6000
    // 2 search × 800 = 1600
    expect(rows.map((r) => r.family)).toEqual(["read", "web", "search"]);
    expect(rows[0]!.count).toBe(5);
    expect(rows[0]!.impact).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Render — vocabulary + visual presence
// ---------------------------------------------------------------------------

describe("renderSavingsDashboard — visual + copy contract", () => {
  it("empty state renders the honest no-data line, never a row of zeros", () => {
    const r = runSavings({ path: projectDir });
    const out = stripAnsi(renderSavingsDashboard(r));
    expect(out).toMatch(/TraceBase Token Savings/);
    expect(out).toMatch(/No mechanism events in this window yet/);
    expect(out).not.toMatch(/^\s+#\s+Mechanism\s+Count/m);
  });

  it("populated dashboard renders header, summary, By Mechanism, By Tool Family", () => {
    withStore((store) => {
      for (let i = 0; i < 3; i++) appendFold(store, i);
      for (let i = 0; i < 4; i++) appendToolBlock(store, "Read", i);
      appendCacheHit(store, "anthropic", 1200);
    });
    const r = runSavings({ path: projectDir });
    const out = stripAnsi(renderSavingsDashboard(r));
    expect(out).toMatch(/TraceBase Token Savings\s+\(window: 7d\)/);
    expect(out).toMatch(/Total events:/);
    expect(out).toMatch(/Tokens injected:/);
    expect(out).toMatch(/Tokens saved:/);
    expect(out).toMatch(/Efficiency meter:/);
    expect(out).toMatch(/By Mechanism/);
    expect(out).toMatch(/context fold/);
    expect(out).toMatch(/tool supervision/);
    expect(out).toMatch(/prompt cache/);
    expect(out).toMatch(/By Tool Family/);
    expect(out).toMatch(/read/);
  });

  it("vocabulary contract: every 'saved' is tagged; never 'verified'", () => {
    withStore((store) => {
      for (let i = 0; i < 2; i++) appendFold(store, i);
      appendCacheHit(store, "anthropic", 800);
    });
    const r = runSavings({ path: projectDir });
    const out = stripAnsi(renderSavingsDashboard(r));

    // Per-line check: a line that mentions "saved" must also use
    // "estimated" — accepts the column label "Tokens saved:" because
    // its value runs "X estimated saved" on the same line. Skip the
    // table header row (which has the column label "Saved" alone).
    for (const line of out.split("\n")) {
      if (!/\bsaved\b/i.test(line)) continue;
      if (/\s+Saved\s+/.test(line)) continue;
      expect(
        /estimated/i.test(line),
        `line uses "saved" without an "estimated" tag: ${JSON.stringify(line)}`,
      ).toBe(true);
    }
    expect(out.toLowerCase()).not.toContain("verified");
  });

  it("renders impact bars with █ and ░ chars (visual parity with the spec)", () => {
    // Seed a state that produces partial efficiency so ░ shows in
    // the meter. 2 folds (7600 saved) + 2400 injected → 0.76 eff.
    withStore((store) => {
      for (let i = 0; i < 2; i++) appendFold(store, i);
      store.appendEvent({
        ts: Date.now(),
        queryId: "r1",
        event: "retrieval",
        candidates: [],
        shadow: false,
        injectedTokensEstimate: 2400,
      });
    });
    const r = runSavings({ path: projectDir });
    const out = stripAnsi(renderSavingsDashboard(r));
    expect(out).toContain("█");
    expect(out).toContain("░");
  });
});

// ---------------------------------------------------------------------------
// JSON output shape
// ---------------------------------------------------------------------------

describe("runSavings — JSON shape", () => {
  it("includes the four mechanism components + aggregates passthrough", () => {
    withStore((store) => {
      appendFold(store, 0);
      appendCacheHit(store, "openai", 500);
    });
    const r = runSavings({ path: projectDir });
    expect(Object.keys(r.savings).sort()).toEqual([
      "contextCompressionSaved",
      "fileMemoryAvoided",
      "promptCacheSaved",
      "toolSupervisionAvoided",
      "total",
    ]);
    expect(r.aggregates).not.toBeNull();
    expect(r.aggregates!.contextFold.chunkCount).toBe(1);
    expect(r.aggregates!.promptCache.bySurface.openai).toBe(1);
  });
});
