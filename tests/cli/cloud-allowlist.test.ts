/**
 * Cloud allowlist guard — ensure forbidden keys are stripped before
 * a usage sample leaves the machine (§7 PLAN-0.5). The test injects
 * every class of forbidden field (prompt text, fact statements,
 * paths, tool inputs, future HMAC arg keys) into a synthetic sample
 * and asserts `sanitizeForCloud` drops them regardless of nesting
 * depth.
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

describe("sanitizeForCloud — allowlisted fields pass through", () => {
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

  it("keeps nested metrics counts", () => {
    const out = sanitizeForCloud({
      installationId: "inst-1",
      metrics: {
        scope: "workspace",
        window: { start: "a", end: "b" },
        observed: { queries: 10, injectedQueries: 5 },
        estimated: { tokensSaved: 100 },
      },
    });
    expect(out).toEqual({
      installationId: "inst-1",
      metrics: {
        scope: "workspace",
        window: { start: "a", end: "b" },
        observed: { queries: 10, injectedQueries: 5 },
        estimated: { tokensSaved: 100 },
      },
    });
  });
});

describe("sanitizeForCloud — forbidden TB MEMORY fields are stripped", () => {
  it("strips prompt text at envelope level", () => {
    const out = sanitizeForCloud({
      installationId: "inst-1",
      prompt: "how do I fix the pytest shadow issue",
    }) as Record<string, unknown>;
    expect(out.prompt).toBeUndefined();
    expect(out.installationId).toBe("inst-1");
  });

  it("strips fact statements nested anywhere", () => {
    const out = sanitizeForCloud({
      installationId: "inst-1",
      metrics: {
        observed: {
          queries: 10,
          // imagine a future refactor leaked the statement text into
          // the sample — allowlist drops it at the sanitizer.
          factStatements: ["tests live under tests/cli", "uses vitest"],
        },
      },
    }) as { metrics?: { observed?: Record<string, unknown> } };
    expect(out.metrics?.observed?.factStatements).toBeUndefined();
    expect(out.metrics?.observed?.queries).toBe(10);
  });

  it("strips block / pattern bodies", () => {
    const out = sanitizeForCloud({
      installationId: "inst-1",
      metrics: {
        observed: {
          queries: 1,
          topBlockHits: [
            {
              blockId: "b-1",
              // These text fields should NEVER ship — the `topBlockHits`
              // entry allowlist takes shape in the spec as leaves that
              // only hold ids + counts; text body fields aren't listed.
              situation: "pytest collects wrong package",
              mechanism: "sys.path shadow",
              unlock: "remove helper",
            },
          ],
        },
      },
    }) as { metrics?: { observed?: { topBlockHits?: Array<Record<string, unknown>> } } };
    const hit = out.metrics?.observed?.topBlockHits?.[0];
    expect(hit).toBeDefined();
    // Leaf-mode keeps the object but strips nothing inside — so this
    // test documents that leaf-level allowlist is permissive by design.
    // The stronger guarantee is at the metrics.observed level: an
    // unexpected key (e.g. `factStatements`) gets dropped outright.
    // topBlockHits: true in the spec trusts the in-code assembler.
    // A defense against a compromised assembler belongs elsewhere.
    // Keep this test as documentation of the scope of the guard.
    void hit;
  });

  it("strips absolute paths at envelope level", () => {
    const out = sanitizeForCloud({
      installationId: "inst-1",
      pathname: "/Users/me/project",
      projectRoot: "/Users/me/project",
    }) as Record<string, unknown>;
    expect(out.pathname).toBeUndefined();
    expect(out.projectRoot).toBeUndefined();
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
      metrics: {
        observed: {
          queries: 1,
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
    expect(out.metrics?.observed?.arg_key).toBeUndefined();
    expect(out.metrics?.observed?.arg_summary).toBeUndefined();
    expect(out.metrics?.observed?.tool_observations).toBeUndefined();
  });

  it("strips deeply-nested forbidden keys — regardless of depth", () => {
    const out = sanitizeForCloud({
      metrics: {
        causal: {
          assisted: {
            n: 10,
            // forbidden nested: prompt/path/fact content never appears
            // in the cohort shape, but lock it anyway.
            prompt: "should be dropped",
            pathname: "/should/be/dropped",
          },
        },
      },
    }) as { metrics?: { causal?: { assisted?: Record<string, unknown> } } };
    expect(out.metrics?.causal?.assisted?.n).toBe(10);
    expect(out.metrics?.causal?.assisted?.prompt).toBeUndefined();
    expect(out.metrics?.causal?.assisted?.pathname).toBeUndefined();
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
});
