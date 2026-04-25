/**
 * Cloud allowlist guard — ensure forbidden keys are stripped before
 * a usage sample leaves the machine (§7 PLAN-0.5).
 *
 * Three coverage axes:
 *
 *   1. Legitimate UsageMetrics fields survive the sanitizer round-
 *      trip. The type definitions in `src/analytics/usage-metrics.ts`
 *      are the reference shape; if they drift, this test notices.
 *
 *   2. Forbidden body-like fields (prompt, statement, path, blockId,
 *      factId, mechanism, situation, unlock, verification, arg_key,
 *      arg_summary, tool_use_id, session_id, batch_id, tool_input,
 *      tool_response) are stripped at every nesting depth — including
 *      inside what looks like an allowlisted aggregate collection
 *      (`topBlockHits`, `topFactHits` placeholder names, plain
 *      `observed.*`, `causal.*`, etc.).
 *
 *   3. The sanitizer enforces primitive-only leaves — an object
 *      masquerading as a value at a `true` leaf is dropped whole.
 *      This is the tightening the 0.5.0 patch put in place after the
 *      earlier permissive `copyLeaf` recursion was removed.
 *
 * Every phase of 0.5.x extends this file with the new forbidden
 * shapes introduced by that phase. 0.5.0 covers TB MEMORY leakage
 * (statements, factIds, prompts); 0.5.2 will add tool_observations
 * keys (arg_key, arg_summary, tool_use_id, session_id, batch_id).
 */
import { describe, it, expect } from "vitest";
import {
  sanitizeForCloud,
  USAGE_SAMPLE_ALLOWLIST,
} from "../../src/cli/cloud-allowlist.js";

describe("sanitizeForCloud — real UsageMetrics fields pass through", () => {
  it("keeps envelope fields", () => {
    const out = sanitizeForCloud({
      installationId: "inst-1",
      windowStart: "2026-04-24T00:00:00Z",
      windowEnd: "2026-04-25T00:00:00Z",
      cliVersion: "0.5.0",
    });
    expect(out).toEqual({
      installationId: "inst-1",
      windowStart: "2026-04-24T00:00:00Z",
      windowEnd: "2026-04-25T00:00:00Z",
      cliVersion: "0.5.0",
    });
  });

  it("keeps every documented UsageMetrics field (real type shape)", () => {
    const sample = {
      installationId: "inst-1",
      windowStart: "2026-04-24T00:00:00Z",
      windowEnd: "2026-04-25T00:00:00Z",
      cliVersion: "0.5.0",
      metrics: {
        scope: "workspace",
        window: { afterTs: 1, beforeTs: 2 },
        observed: {
          eligibleRuns: 10,
          recalledRuns: 8,
          injectedRuns: 5,
          usedRuns: 3,
          helpfulRuns: 2,
          resolvedRateWithMemory: 0.4,
        },
        estimated: {
          tokensSaved: { value: 120, sampleSize: 5, formula: "mean(shadow) − mean(assisted)" },
          latencySavedMs: { value: 350, sampleSize: 5, formula: "mean_shadow_ms − mean_assisted_ms" },
        },
        causal: {
          assisted: { n: 10, resolved: 4, resolvedRate: 0.4 },
          holdout: { n: 8, resolved: 2, resolvedRate: 0.25 },
          resolvedLift: 0.15,
          tokensLift: { value: 50, sampleSize: 4, formula: "..." },
          latencyLift: { value: 100, sampleSize: 4, formula: "..." },
          minCohortSize: 3,
        },
        integrity: {
          shadowControlMismatches: 0,
          outcomesWithoutRetrieval: 1,
        },
      },
    };
    const out = sanitizeForCloud(sample);
    // Deep-equal — no legit field should drop.
    expect(out).toEqual(sample);
  });
});

describe("sanitizeForCloud — body-like fields are stripped at every depth", () => {
  it("strips prompt text at envelope level", () => {
    const out = sanitizeForCloud({
      installationId: "inst-1",
      prompt: "how do I fix the pytest shadow issue",
    }) as Record<string, unknown>;
    expect(out.prompt).toBeUndefined();
    expect(out.installationId).toBe("inst-1");
  });

  it("strips absolute paths + projectRoot at envelope level", () => {
    const out = sanitizeForCloud({
      installationId: "inst-1",
      pathname: "/Users/me/project",
      projectRoot: "/Users/me/project",
      cwd: "/Users/me/project",
    }) as Record<string, unknown>;
    expect(out.pathname).toBeUndefined();
    expect(out.projectRoot).toBeUndefined();
    expect(out.cwd).toBeUndefined();
  });

  it("strips injected body-like keys inside metrics.observed", () => {
    const out = sanitizeForCloud({
      installationId: "inst-1",
      metrics: {
        observed: {
          eligibleRuns: 10,
          // every one of these is forbidden even though it lives
          // inside an allowlisted container.
          factStatements: ["tests live under tests/cli"],
          prompt: "should be dropped",
          statement: "should be dropped",
          path: "/abs/path",
          mechanism: "should be dropped",
          situation: "should be dropped",
          unlock: "should be dropped",
          verification: "should be dropped",
          blockId: "b-1",
          factId: "f-1",
        },
      },
    }) as { metrics?: { observed?: Record<string, unknown> } };
    const observed = out.metrics?.observed ?? {};
    expect(observed.eligibleRuns).toBe(10);
    for (const k of [
      "factStatements",
      "prompt",
      "statement",
      "path",
      "mechanism",
      "situation",
      "unlock",
      "verification",
      "blockId",
      "factId",
    ]) {
      expect(observed[k], `observed.${k} must be stripped`).toBeUndefined();
    }
  });

  it("strips body-like keys inside causal cohorts", () => {
    const out = sanitizeForCloud({
      metrics: {
        causal: {
          assisted: {
            n: 10,
            resolved: 4,
            resolvedRate: 0.4,
            // forbidden nested: prompt/path/fact content never belongs
            // in a cohort row but lock it anyway.
            prompt: "dropped",
            pathname: "/dropped",
            situation: "dropped",
            blockId: "dropped",
            factId: "dropped",
          },
          holdout: {
            n: 8,
            resolved: 2,
            resolvedRate: 0.25,
            mechanism: "dropped",
            statement: "dropped",
          },
        },
      },
    }) as {
      metrics?: {
        causal?: {
          assisted?: Record<string, unknown>;
          holdout?: Record<string, unknown>;
        };
      };
    };
    const assisted = out.metrics?.causal?.assisted ?? {};
    const holdout = out.metrics?.causal?.holdout ?? {};
    expect(assisted.n).toBe(10);
    expect(holdout.n).toBe(8);
    for (const k of ["prompt", "pathname", "situation", "blockId", "factId"]) {
      expect(assisted[k], `assisted.${k} must be stripped`).toBeUndefined();
    }
    for (const k of ["mechanism", "statement"]) {
      expect(holdout[k], `holdout.${k} must be stripped`).toBeUndefined();
    }
  });

  it("strips body-like keys inside UsageEstimate (value/sampleSize/formula only)", () => {
    // `formula` survives as-is (short programmatic string), but any
    // other key at the same level must not.
    const out = sanitizeForCloud({
      metrics: {
        estimated: {
          tokensSaved: {
            value: 100,
            sampleSize: 5,
            formula: "mean(shadow) − mean(assisted)",
            // forbidden — not in the UsageEstimate allowlist
            prompt: "dropped",
            mechanism: "dropped",
            blockId: "dropped",
            rawValues: [1, 2, 3],
          },
        },
      },
    }) as { metrics?: { estimated?: { tokensSaved?: Record<string, unknown> } } };
    const t = out.metrics?.estimated?.tokensSaved ?? {};
    expect(t.value).toBe(100);
    expect(t.sampleSize).toBe(5);
    expect(t.formula).toMatch(/^mean/);
    for (const k of ["prompt", "mechanism", "blockId", "rawValues"]) {
      expect(t[k], `tokensSaved.${k} must be stripped`).toBeUndefined();
    }
  });

  it("strips top-hit / reuse surfaces that were never allowlisted", () => {
    // Historical regression: an earlier draft of the allowlist had
    // `topBlockHits: true` and `topFactHits: true` as permissive
    // leaves that copied every nested key verbatim. They were never
    // real UsageMetrics fields and are now fully absent from the
    // allowlist; body-like content inside them must be dropped.
    const out = sanitizeForCloud({
      metrics: {
        observed: {
          eligibleRuns: 1,
          topBlockHits: [
            {
              blockId: "b-1",
              hits: 5,
              // fields a careless assembler might include —
              // NONE of these may leave the machine.
              situation: "pytest collects wrong package",
              mechanism: "sys.path shadow",
              unlock: "remove helper",
              verification: "pytest --collect-only",
              path: "/abs/project/src/a.ts",
            },
          ],
          topFactHits: [
            {
              factId: "f-1",
              hits: 3,
              statement: "tests live under tests/cli",
              scope: "project",
              path: "/abs/project/tests/cli",
            },
          ],
          reuseByBlockKind: { success: 10, pitfall: 2 },
        },
      },
    }) as { metrics?: { observed?: Record<string, unknown> } };
    const obs = out.metrics?.observed ?? {};
    expect(obs.eligibleRuns).toBe(1);
    // Entire topBlockHits / topFactHits / reuseByBlockKind keys are
    // absent — they aren't in the real UsageMetrics type and they
    // aren't in the allowlist.
    expect(obs.topBlockHits).toBeUndefined();
    expect(obs.topFactHits).toBeUndefined();
    expect(obs.reuseByBlockKind).toBeUndefined();
  });

  it("strips future tool_observations keys reserved for phase 0.5.2", () => {
    // These keys don't exist today but must NOT land in metrics mode
    // when they do. Pin the guard now so a future diff that bubbles
    // them up breaks a test, not user privacy.
    const out = sanitizeForCloud({
      installationId: "inst-1",
      arg_key: "hmac-abcdef",
      arg_summary: "Read src/foo.ts",
      tool_use_id: "tu-1",
      session_id: "sess-1",
      batch_id: "batch-1",
      tool_input: { file_path: "/abs/foo.ts" },
      tool_response: "full response body",
      metrics: {
        observed: {
          eligibleRuns: 1,
          arg_key: "hmac-xyz",
          arg_summary: "Grep foo",
          tool_observations: [
            { tool_name: "Read", arg_key: "hmac-abc", session_id: "s", batch_id: "b" },
          ],
        },
      },
    }) as {
      arg_key?: unknown;
      metrics?: { observed?: Record<string, unknown> };
    } & Record<string, unknown>;
    expect(out.arg_key).toBeUndefined();
    expect(out.arg_summary).toBeUndefined();
    expect(out.tool_use_id).toBeUndefined();
    expect(out.session_id).toBeUndefined();
    expect(out.batch_id).toBeUndefined();
    expect(out.tool_input).toBeUndefined();
    expect(out.tool_response).toBeUndefined();
    expect(out.metrics?.observed?.arg_key).toBeUndefined();
    expect(out.metrics?.observed?.arg_summary).toBeUndefined();
    expect(out.metrics?.observed?.tool_observations).toBeUndefined();
  });
});

describe("sanitizeForCloud — primitive-only leaves, no arbitrary nesting", () => {
  it("rejects object-at-leaf at an allowlisted position", () => {
    // `scope` is a primitive leaf (string). If an assembler sneaks
    // an object in, the sanitizer must drop it rather than copy
    // every nested key verbatim.
    const out = sanitizeForCloud({
      metrics: {
        scope: { forbidden: "nested", prompt: "dropped" } as unknown,
      },
    }) as { metrics?: Record<string, unknown> };
    expect(out.metrics?.scope).toBeUndefined();
  });

  it("keeps arrays of primitives; drops arrays containing any object", () => {
    // This is documented behavior — arrays of primitives pass, any
    // object inside the array drops the whole thing. Forces the
    // maintainer to add an explicit nested spec for arrays-of-
    // objects rather than silently widen.
    const primitiveArray = sanitizeForCloud({
      installationId: "inst-1",
      metrics: {
        observed: { eligibleRuns: [1, 2, 3] as unknown as number },
      },
    }) as { metrics?: { observed?: { eligibleRuns?: unknown } } };
    // `eligibleRuns` declared as `number` but accepting array with
    // primitive elements at the `true` leaf is fine — sanitizer
    // isn't a type checker, it's a safety net.
    expect(Array.isArray(primitiveArray.metrics?.observed?.eligibleRuns)).toBe(true);

    const mixedArray = sanitizeForCloud({
      metrics: {
        observed: {
          eligibleRuns: [1, { forbidden: "nested" }, 3] as unknown as number,
        },
      },
    }) as { metrics?: { observed?: { eligibleRuns?: unknown } } };
    // Array contains an object → whole array dropped.
    expect(mixedArray.metrics?.observed?.eligibleRuns).toBeUndefined();
  });
});

describe("sanitizeForCloud — edge cases", () => {
  it("handles null / undefined inputs without throwing", () => {
    expect(sanitizeForCloud(null as unknown as object)).toBeNull();
    expect(sanitizeForCloud(undefined as unknown as object)).toBeUndefined();
  });

  it("drops primitive at top level (not an object)", () => {
    expect(sanitizeForCloud("a string" as unknown as object)).toBeUndefined();
    expect(sanitizeForCloud(42 as unknown as object)).toBeUndefined();
  });

  it("is pure — does not mutate input", () => {
    const input = {
      installationId: "inst-1",
      metrics: { scope: "workspace" },
      prompt: "forbidden",
    };
    sanitizeForCloud(input);
    expect(input.prompt).toBe("forbidden"); // source object unchanged
  });

  it("allowlist export is stable — every top-level key is documented", () => {
    // Sanity: the exported USAGE_SAMPLE_ALLOWLIST must be an object
    // with exactly the keys the plan lists. Lock it so a future edit
    // that accidentally widens the top surface is caught here.
    expect(Object.keys(USAGE_SAMPLE_ALLOWLIST).sort()).toEqual([
      "cliVersion",
      "installationId",
      "metrics",
      "windowEnd",
      "windowStart",
    ]);
  });

  it("metrics sub-allowlist shape is locked — no surprise widening", () => {
    const metrics = USAGE_SAMPLE_ALLOWLIST.metrics;
    expect(typeof metrics).toBe("object");
    if (typeof metrics !== "object") return;
    expect(Object.keys(metrics).sort()).toEqual([
      "causal",
      "estimated",
      "integrity",
      "observed",
      "scope",
      // 0.5.4 §6 — TB TOOL / TB LOOP aggregates. Counts only;
      // family vocabulary normalised (`read` / `search` / `shell`
      // / etc.) — never literal Claude tool names.
      "toolBatch",
      "window",
    ]);
  });
});
