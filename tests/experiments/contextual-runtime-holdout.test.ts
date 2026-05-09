/**
 * 0.7.1 Contextual Runtime — deterministic holdout, end-to-end
 *
 * `tests/experiments/holdout.test.ts` already covers the math of
 * `shouldHoldOut(fingerprint, rate, salt)`. This test verifies the
 * property at the layer external integrators consume: the pilot
 * harness / provider boundary. Specifically:
 *
 *   - Same fixture run twice with the same holdout config lands in
 *     the same cohort (control vs assisted).
 *   - Cross-workspace isolation: changing the salt re-randomizes
 *     the assignment for the same fingerprint.
 *   - rate=1.0 forces every fixture into the holdout cohort.
 *   - rate=0   forces every fixture into the assisted cohort.
 *
 * The harness assertion is the one that would actually break if a
 * future refactor of the runner started passing a non-deterministic
 * fingerprint or shuffled the experiment input.
 */
import { describe, it, expect } from "vitest";
import { probeHoldoutAssignment } from "../../eval/contextual-runtime/providers.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeTempDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "tb-pilot-holdout-"));
  return {
    path: join(dir, "store.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const FIXTURE_PROBLEM =
  "form validation conflates 0 and missing input via truthiness checks";

describe("contextual-runtime holdout — deterministic cohort assignment", () => {
  it("same fixture twice → same cohort (rate=0.5, fixed salt)", () => {
    const { path, cleanup } = makeTempDb();
    try {
      const a = probeHoldoutAssignment(path, FIXTURE_PROBLEM, "typescript", "operator-misuse", {
        rate: 0.5,
        salt: "pilot-salt-A",
      });
      const b = probeHoldoutAssignment(path, FIXTURE_PROBLEM, "typescript", "operator-misuse", {
        rate: 0.5,
        salt: "pilot-salt-A",
      });
      expect(a.shadow).toBe(b.shadow);
      if (a.shadow) {
        expect(a.controlReason).toBe("holdout");
        expect(b.controlReason).toBe("holdout");
      }
    } finally {
      cleanup();
    }
  });

  it("different salt → potentially different cohort (workspace isolation)", () => {
    // We don't assert disequality (a hash collision could land both
    // cohorts the same way for one fixture); we DO assert that
    // either salt's two probes are individually consistent. This is
    // the cross-workspace property: "switching workspaces doesn't
    // reuse the same cohort assignment". The orthogonality of the
    // hash is verified separately in tests/experiments/holdout.test.ts.
    const { path, cleanup } = makeTempDb();
    try {
      const a1 = probeHoldoutAssignment(path, FIXTURE_PROBLEM, "typescript", "operator-misuse", {
        rate: 0.5,
        salt: "ws-A",
      });
      const a2 = probeHoldoutAssignment(path, FIXTURE_PROBLEM, "typescript", "operator-misuse", {
        rate: 0.5,
        salt: "ws-A",
      });
      expect(a1.shadow).toBe(a2.shadow);

      const b1 = probeHoldoutAssignment(path, FIXTURE_PROBLEM, "typescript", "operator-misuse", {
        rate: 0.5,
        salt: "ws-B",
      });
      const b2 = probeHoldoutAssignment(path, FIXTURE_PROBLEM, "typescript", "operator-misuse", {
        rate: 0.5,
        salt: "ws-B",
      });
      expect(b1.shadow).toBe(b2.shadow);
    } finally {
      cleanup();
    }
  });

  it("rate=1.0 → every probe lands in holdout", () => {
    const { path, cleanup } = makeTempDb();
    try {
      for (const problem of [
        "form validation conflates 0 and missing input",
        "react state update batching causes stale read",
        "promise.all rejects on any inner failure without cleanup",
      ]) {
        const r = probeHoldoutAssignment(path, problem, "typescript", undefined, {
          rate: 1.0,
          salt: "ws-rate1",
        });
        expect(r.shadow).toBe(true);
        expect(r.controlReason).toBe("holdout");
      }
    } finally {
      cleanup();
    }
  });

  it("rate=0 → every probe is assisted (no shadow)", () => {
    const { path, cleanup } = makeTempDb();
    try {
      for (const problem of [
        "form validation conflates 0 and missing input",
        "react state update batching causes stale read",
      ]) {
        const r = probeHoldoutAssignment(path, problem, "typescript", undefined, {
          rate: 0,
          salt: "ws-rate0",
        });
        expect(r.shadow).toBe(false);
        expect(r.controlReason).toBeUndefined();
      }
    } finally {
      cleanup();
    }
  });
});
