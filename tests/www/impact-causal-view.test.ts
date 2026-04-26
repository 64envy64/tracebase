/**
 * Phase 3.5 — ImpactView causal section regressions.
 *
 * Textual guard (react-dom lives only in www/) — locks the
 * three-state UI contract around `metrics.causal`:
 *   1. absent          → "no causal data yet" card
 *   2. under threshold → cohort sizes + explicit waiting copy
 *   3. above threshold → cohort cards + lift tiles
 *
 * Also locks the separation from `estimated`:
 *   - "Shadow-based estimate" heading is present
 *   - Estimated never rebrands itself as causal proof
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const IMPACT_VIEW = readFileSync(
  resolve(__dirname, "../../www/src/components/dashboard/ImpactView.tsx"),
  "utf-8",
);

describe("ImpactView — causal section markup", () => {
  it("includes a dedicated CausalSection that renders from metrics.causal only", () => {
    expect(IMPACT_VIEW).toContain("function CausalSection");
    // The section must receive `causal` as a prop, not reach into
    // other fields to fabricate one.
    expect(IMPACT_VIEW).toMatch(/function CausalSection\(\{\s*causal[^}]*\}/);
    // And it must be wired from totals.causal specifically, not
    // from `estimated` or anywhere else.
    expect(IMPACT_VIEW).toContain("<CausalSection causal={totals.causal}");
  });

  it("absent state: renders 'No causal data yet' copy when metrics.causal is undefined", () => {
    expect(IMPACT_VIEW).toContain("No causal data yet");
    // 0.6.1 — points at the init re-run path; the experiment
    // command is no longer surfaced on the CLI.
    expect(IMPACT_VIEW).toMatch(/tracebase init --holdout-rate/);
  });

  it("under-threshold state: keeps lift hidden and explains the waiting gate", () => {
    expect(IMPACT_VIEW).toContain("Waiting for each cohort to reach");
    // Explicit per-arm remaining counts so a user knows exactly
    // how far the experiment still has to run.
    expect(IMPACT_VIEW).toMatch(/Remaining: assisted/);
    expect(IMPACT_VIEW).toMatch(/held-out/);
  });

  it("above-threshold state: renders Resolved-rate lift, Tokens saved, Latency saved", () => {
    expect(IMPACT_VIEW).toContain('label="Resolved rate lift"');
    expect(IMPACT_VIEW).toContain('label="Tokens saved"');
    expect(IMPACT_VIEW).toContain('label="Latency saved"');
  });

  it("assisted vs held-out: uses the honest copy, never 'proof' / 'project-level certainty'", () => {
    expect(IMPACT_VIEW).toContain("Assisted vs held-out");
    // Guardrails from the reviewer brief:
    expect(IMPACT_VIEW).not.toMatch(/\bproof\b(?!\s*,?\s*not)/i);
    expect(IMPACT_VIEW).not.toMatch(/project-level certainty/i);
    // Rate lift uses percentage-points, not percentages, so the
    // number cannot read as a relative change.
    expect(IMPACT_VIEW).toContain("formatRateLift");
    expect(IMPACT_VIEW).toMatch(/pp/);
  });
});

describe("ImpactView — estimated stays explicitly diagnostic", () => {
  it("labels the shadow-based estimate as diagnostic, not causal", () => {
    expect(IMPACT_VIEW).toContain("Shadow-based estimate");
    expect(IMPACT_VIEW).toMatch(/Not a causal comparison/);
  });

  it("does not merge causal and estimated into one surface", () => {
    // Two separate <section> nodes. The causal section uses
    // aria-label="Causal: assisted vs held-out"; the estimated
    // uses aria-label="Diagnostic estimate (shadow-based)". Both
    // must be present as distinct landmarks.
    expect(IMPACT_VIEW).toMatch(/aria-label="Causal: assisted vs held-out"/);
    expect(IMPACT_VIEW).toMatch(/aria-label="Diagnostic estimate \(shadow-based\)"/);
  });

  it("never infers a causal number from estimated data", () => {
    // Regression guard: no code path in the view may pull from
    // `estimated.tokensSaved` / `estimated.latencySavedMs` to fill
    // in a causal tile. Simple textual check — the causal tiles
    // must reference causal.tokensLift / causal.latencyLift only.
    const causalBlockMatch = IMPACT_VIEW.match(/function CausalSection[\s\S]+?^\}/m);
    expect(causalBlockMatch).not.toBeNull();
    const causalSrc = causalBlockMatch![0];
    expect(causalSrc).not.toMatch(/estimated\.tokensSaved/);
    expect(causalSrc).not.toMatch(/estimated\.latencySavedMs/);
  });
});
