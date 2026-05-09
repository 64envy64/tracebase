/**
 * 0.7.1 Contextual Runtime — naive-cache baseline corpus parity
 *
 * The pilot's "naive-cache" arm is the eval's required baseline
 * — a homegrown trajectory cache, no gate, no calibration,
 * just bag-of-words Jaccard. The cohort comparison only measures
 * "TraceBase retrieval + gating" if the naive baseline reads from
 * the SAME corpus TraceBase has indexed.
 *
 * This test verifies:
 *
 *   1. `buildNaiveCorpus` includes every fixture except the
 *      excluded ids — same shape TraceBase pre-seed produces.
 *   2. Excluded ids never appear in the naive corpus (no self-leak).
 *   3. Each corpus entry has a normalized DistillateSeed (deadEnds
 *      collapsed to a single string, situation/unlock present).
 *
 * If the corpus diverged, lift between TraceBase and naive-cache
 * could be attributed to differences in what each side has access
 * to, not to retrieval / gating quality.
 */
import { describe, it, expect } from "vitest";
import { buildNaiveCorpus } from "../../eval/contextual-runtime/providers.js";
import { loadPilotFixtures } from "../../eval/contextual-runtime/runner.js";
import {
  formatNaiveInjection,
  naiveRecall,
} from "../../eval/agentic/naive-cache.js";
import type { PilotFixture } from "../../eval/contextual-runtime/types.js";

const FIXTURES_DIR = "eval/agentic/fixtures";

describe("buildNaiveCorpus — corpus parity for the naive baseline", () => {
  it("includes every fixture not in excludeIds", () => {
    const fixtures = loadPilotFixtures(FIXTURES_DIR);
    expect(fixtures.length).toBeGreaterThan(0);
    const corpus = buildNaiveCorpus(fixtures, new Set());
    expect(corpus.length).toBe(fixtures.length);
    const ids = new Set(corpus.map((c) => c.meta.id));
    for (const f of fixtures) expect(ids.has(f.id)).toBe(true);
  });

  it("excludes the requested ids — no self-leak when fixture under test is excluded", () => {
    const fixtures = loadPilotFixtures(FIXTURES_DIR);
    if (fixtures.length === 0) return;
    const head = fixtures[0]!;
    const corpus = buildNaiveCorpus(fixtures, new Set([head.id]));
    expect(corpus.length).toBe(fixtures.length - 1);
    expect(corpus.find((c) => c.meta.id === head.id)).toBeUndefined();
  });

  it("normalizes deadEnds to a single string for the agentic DistillateSeed shape", () => {
    const f: PilotFixture = {
      id: "synthetic",
      language: "typescript",
      errorType: "synthetic",
      description: "synthetic problem about token-overlap baselines",
      seed: {
        situation: "synthetic situation about token-overlap baselines",
        unlock: "use jaccard token overlap to score a candidate match",
        deadEnds: ["regex-only matchers do not capture stems", "edit distance is too forgiving"],
      },
    };
    const corpus = buildNaiveCorpus([f], new Set());
    expect(corpus.length).toBe(1);
    expect(typeof corpus[0]!.seed.deadEnds).toBe("string");
    expect(corpus[0]!.seed.deadEnds).toContain("regex-only");
    expect(corpus[0]!.seed.deadEnds).toContain("edit distance");
  });

  it("naiveRecall returns a hit when the corpus contains a related entry", () => {
    const a: PilotFixture = {
      id: "a",
      language: "typescript",
      description: "form validation conflates 0 and missing input",
      seed: {
        situation: "form validation conflates 0 and missing input via truthiness check",
        unlock: "use value == null to distinguish missing from intentional zero",
        deadEnds: [],
      },
    };
    const b: PilotFixture = {
      id: "b",
      language: "typescript",
      description: "promise rejection handling",
      seed: {
        situation: "promise rejection without catch propagates to unhandled rejection",
        unlock: "attach a .catch() handler or wrap in try/await",
        deadEnds: [],
      },
    };
    const corpus = buildNaiveCorpus([a, b], new Set());
    const hit = naiveRecall(
      "form validation flags input value of 0 as missing required field",
      corpus,
    );
    expect(hit).not.toBeNull();
    expect(hit!.meta.id).toBe("a");
    const formatted = formatNaiveInjection(hit!);
    expect(formatted).toContain("Situation:");
    expect(formatted).toContain("Solution:");
  });
});
