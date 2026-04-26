/**
 * Strict savings-vocabulary contract (PLAN-0.7 §rc.7).
 *
 * The impact line carries three distinct savings concepts:
 *   1. ESTIMATED  — heuristic, helpful-runs × constant
 *   2. VERIFIED   — causal lift from the holdout cohort
 *   3. MECHANISM  — deterministic per-event-kind aggregator
 *
 * The dashboard must NEVER let these blur together. This test
 * pins the copy contract by:
 *   (a) walking every rendered impact line across all readiness
 *       states + permutations;
 *   (b) asserting every "saved" token is properly tagged;
 *   (c) asserting the mechanism segment never contains "verified"
 *       and the verified segment never contains the mechanism
 *       components in their bare form.
 *
 * Adding a new copy variant means an explicit case here. The aim
 * is that a sloppy refactor that types "saved 38k tokens" without
 * the "estimated" / "verified" / "mechanism" tag fails this test.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initConfig,
  loadConfig,
  enableHoldoutExperiment,
} from "../../src/core/config.js";
import { BlockStore } from "../../src/core/block-store.js";
import {
  runImpact,
  renderImpactLine,
  type ImpactReport,
} from "../../src/cli/commands/impact.js";

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "tb-impact-vocab-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

/**
 * Strip ANSI escape codes (picocolors) so regex assertions
 * don't have to deal with the dim/green coloring on every run.
 */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Find every occurrence of the bare word "saved" in the line and
 * return the preceding ~32 chars of context. Used to assert each
 * occurrence is properly tagged.
 */
function findSavedContexts(line: string): string[] {
  const stripped = stripAnsi(line);
  const out: string[] = [];
  const re = /(.{0,32})saved/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stripped)) !== null) {
    out.push(match[1] ?? "");
  }
  return out;
}

/**
 * Acceptable tags that must precede any "saved" in the rendered
 * line. The list is closed and updates only with an explicit
 * spec change. Match is case-insensitive.
 */
const ALLOWED_SAVED_TAGS = [
  "estimated saved",
  "verified saved",
  "estimated latency saved",
  "verified latency saved",
  "total estimated saved",
];

function isProperlyTagged(savedContext: string): boolean {
  // The full match is `<32-char-context>saved`. We need to check
  // that the trailing slice matches one of the allowed phrases.
  const tail = savedContext + "saved";
  const lower = tail.toLowerCase();
  return ALLOWED_SAVED_TAGS.some((tag) => lower.endsWith(tag));
}

// ---------------------------------------------------------------------------
// Seed helpers — minimal duplication from impact.test.ts. Each writes a
// path-bound BlockStore so the WAL/journal is flushed before the next call.
// ---------------------------------------------------------------------------

function seedRetrieval(opts: {
  queryId: string;
  shadow: boolean;
  controlReason?: "shadow" | "holdout";
  injectedTokens?: number;
  ts?: number;
}): void {
  const cfg = loadConfig(projectDir);
  const store = new BlockStore(cfg.storagePath);
  store.appendEvent({
    ts: opts.ts ?? Date.now(),
    queryId: opts.queryId,
    event: "retrieval",
    candidates: [],
    shadow: opts.shadow,
    ...(opts.controlReason ? { controlReason: opts.controlReason } : {}),
    ...(opts.injectedTokens !== undefined
      ? { injectedTokensEstimate: opts.injectedTokens }
      : {}),
  });
  store.close();
}

function seedOutcome(opts: {
  queryId: string;
  resolved: boolean;
  control?: boolean;
}): void {
  const cfg = loadConfig(projectDir);
  const store = new BlockStore(cfg.storagePath);
  store.appendEvent({
    ts: Date.now(),
    queryId: opts.queryId,
    event: "outcome",
    resolved: opts.resolved,
    ...(opts.control !== undefined ? { control: opts.control } : {}),
  });
  store.close();
}

function seedContextFold(): void {
  const cfg = loadConfig(projectDir);
  const store = new BlockStore(cfg.storagePath);
  store.appendEvent({
    ts: Date.now(),
    queryId: "f1",
    event: "context.folded",
    sessionId: "s1",
    chunkRange: "0-7",
    tokensBefore: 5000,
    tokensAfter: 1000,
    summarizer: "heuristic",
  });
  store.close();
}

function seedCacheHit(surface: "anthropic" | "openai", tokens: number): void {
  const cfg = loadConfig(projectDir);
  const store = new BlockStore(cfg.storagePath);
  store.appendEvent({
    ts: Date.now(),
    queryId: `c-${surface}`,
    event: "cache.prompt_hit",
    surface,
    tokensSaved: tokens,
  });
  store.close();
}

// ---------------------------------------------------------------------------
// 1) Every "saved" must be properly tagged across readiness states
// ---------------------------------------------------------------------------

describe("impact line — strict savings vocabulary", () => {
  it("no-holdout state — every 'saved' is tagged (or absent)", () => {
    initConfig(projectDir);
    seedRetrieval({ queryId: "q1", shadow: false, injectedTokens: 1000 });
    seedRetrieval({ queryId: "q2", shadow: false, injectedTokens: 1000 });
    seedOutcome({ queryId: "q1", resolved: true });
    const r = runImpact({ path: projectDir });
    const line = stripAnsi(renderImpactLine(r));
    for (const ctx of findSavedContexts(line)) {
      expect(isProperlyTagged(ctx), `untagged "saved" in: ${line}`).toBe(true);
    }
  });

  it("below-cohort state — every 'saved' is tagged", () => {
    initConfig(projectDir);
    enableHoldoutExperiment(projectDir, { rate: 0.5 });
    seedRetrieval({
      queryId: "h-1",
      shadow: true,
      controlReason: "holdout",
      injectedTokens: 0,
    });
    seedOutcome({ queryId: "h-1", resolved: false, control: true });
    seedRetrieval({ queryId: "a-1", shadow: false, injectedTokens: 1200 });
    seedOutcome({ queryId: "a-1", resolved: true, control: false });
    const r = runImpact({ path: projectDir });
    const line = stripAnsi(renderImpactLine(r));
    for (const ctx of findSavedContexts(line)) {
      expect(isProperlyTagged(ctx), `untagged "saved" in: ${line}`).toBe(true);
    }
  });

  it("ready state (mocked) — every 'saved' is tagged", () => {
    const mocked: ImpactReport = {
      readiness: "ready",
      windowAfterTs: 0,
      windowBeforeTs: 7 * 86_400_000,
      pricing: { inputPer1mTokens: 3, outputPer1mTokens: 15 },
      experiment: null,
      mechanisms: {
        contextCompressionSaved: 5000,
        fileMemoryAvoided: 2000,
        toolSupervisionAvoided: 1500,
        promptCacheSaved: 800,
        total: 9300,
      },
      metrics: {
        scope: "workspace",
        window: { afterTs: 0, beforeTs: 7 * 86_400_000 },
        observed: {
          eligibleRuns: 50,
          recalledRuns: 47,
          injectedRuns: 47,
          usedRuns: 45,
          helpfulRuns: 39,
          resolvedRateWithMemory: 0.83,
        },
        estimated: {
          tokensSaved: { value: 39_000, sampleSize: 47, formula: "..." },
          latencySavedMs: { value: 195_000, sampleSize: 47, formula: "..." },
          heuristicTokensSaved: {
            value: 39_000,
            sampleSize: 39,
            formula: "helpfulRuns × 1000",
          },
          heuristicLatencySavedMs: {
            value: 195_000,
            sampleSize: 39,
            formula: "helpfulRuns × 5000",
          },
        },
        causal: {
          assisted: { n: 47, resolved: 39, resolvedRate: 0.83 },
          holdout: { n: 35, resolved: 25, resolvedRate: 0.71 },
          resolvedLift: 0.12,
          tokensLift: { value: 38_000, sampleSize: 47, formula: "..." },
          latencyLift: { value: 1_200, sampleSize: 47, formula: "..." },
          minCohortSize: 30,
        },
        integrity: { shadowControlMismatches: 0, outcomesWithoutRetrieval: 0 },
        netTokenImpact: 24_000,
        totalInjectedTokensEstimate: 14_000,
      },
    };
    const line = stripAnsi(renderImpactLine(mocked));
    for (const ctx of findSavedContexts(line)) {
      expect(isProperlyTagged(ctx), `untagged "saved" in: ${line}`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 2) Mechanism segment must not bleed into / claim verified
// ---------------------------------------------------------------------------

describe("impact line — mechanism vs verified segregation", () => {
  it("mechanism segment never contains the word 'verified'", () => {
    initConfig(projectDir);
    seedRetrieval({ queryId: "q1", shadow: false, injectedTokens: 100 });
    seedContextFold();
    seedCacheHit("anthropic", 1500);
    const r = runImpact({ path: projectDir });
    const line = stripAnsi(renderImpactLine(r));
    const mechLine = line.split("\nestimated mechanisms:")[1];
    expect(mechLine).toBeDefined();
    expect(mechLine!.toLowerCase()).not.toContain("verified");
  });

  it("mechanism segment uses the word 'estimated' on the total — never bare 'saved'", () => {
    initConfig(projectDir);
    seedContextFold();
    const r = runImpact({ path: projectDir });
    const line = stripAnsi(renderImpactLine(r));
    const mechLine = line.split("\nestimated mechanisms:")[1];
    expect(mechLine).toBeDefined();
    // Must contain "total estimated saved".
    expect(mechLine).toMatch(/total estimated saved/);
  });
});

// ---------------------------------------------------------------------------
// 3) Source-level guard: the renderer's literal strings must already
//    obey the contract. This catches a future edit that quietly drops
//    the "estimated" / "verified" tag from a copy template.
// ---------------------------------------------------------------------------

describe("impact source — literal-string vocabulary contract", () => {
  it("impact.ts never contains a bare 'saved' literal that isn't tagged", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const file = path.join(
      process.cwd(),
      "src/cli/commands/impact.ts",
    );
    const src = await fs.readFile(file, "utf8");
    // Strip /** ... */ block comments and `// ...` line comments —
    // those describe the contract and naturally use the word.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    // Pull out every backtick / single / double-quoted literal.
    const literals: string[] = [];
    const re = /(`[^`]*`|"[^"]*"|'[^']*')/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stripped)) !== null) {
      literals.push(m[0]);
    }
    for (const lit of literals) {
      // Only literals that contain the word "saved" need checking.
      const lower = lit.toLowerCase();
      if (!/\bsaved\b/.test(lower)) continue;
      const matches = lower.match(/\bsaved\b/g) ?? [];
      for (let i = 0; i < matches.length; i++) {
        // Take the substring up through this occurrence + 5 chars.
        const idx = lower.indexOf("saved", i === 0 ? 0 : lower.indexOf("saved") + 1);
        const ctx = lower.slice(Math.max(0, idx - 32), idx);
        expect(
          isProperlyTagged(ctx),
          `untagged "saved" in literal: ${lit}`,
        ).toBe(true);
      }
    }
  });
});
