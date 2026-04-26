/**
 * Cloud envelope PII regression — 0.7.0-rc.1 §Ground.
 *
 * Two distinct boundaries are exercised here:
 *
 *   1. WIRE BOUNDARY (`sanitizeForCloud`): every per-event-kind
 *      aggregate sub-object on `metrics.mechanisms.*` is stripped of
 *      planted PII (path / sessionId / argKey / argSummary / raw
 *      toolName / pattern matched substring) before the payload
 *      leaves the machine.
 *
 *   2. AGGREGATOR BOUNDARY (`toolFamily`): a custom toolName like
 *      `"MyCompany.SecretInternalProbe"` is collapsed to its
 *      eight-family slot (`"other"`) at count time, so the literal
 *      name never even enters the cloud-bound counts map. The wire
 *      sanitiser is the second line of defence; this is the first.
 *
 * Coverage here is intentionally orthogonal to the broader
 * `tests/cli/cloud-allowlist.test.ts` — that file is the per-field
 * allowlist regression; this one is a focused privacy smoke test the
 * spec calls out by name.
 */
import { describe, it, expect } from "vitest";
import { sanitizeForCloud } from "../../src/cli/cloud-allowlist.js";
import { toolFamily, toolFamilyOf } from "../../src/runtime/tool-family.js";

const ALL_NEW_EVENT_KINDS = [
  "fileIndex",
  "fileMemory",
  "toolSupervision",
  "loopRedirect",
  "contextFold",
  "injectionRejected",
  "promptCache",
] as const;

describe("no-pii-in-envelope — wire boundary (sanitizeForCloud)", () => {
  it("planted PII fields on every new mechanism aggregate are stripped", () => {
    // Plant the same five PII fields on EVERY mechanism family. The
    // wire sanitiser must drop all of them; only the documented
    // counts + closed-enum histograms survive.
    const planted = {
      path: "/Users/me/secret/project",
      sessionId: "sess-deadbeef",
      argKey: "hmac-deadbeef",
      argSummary: "Read /Users/me/secret/project/keys.env",
      toolName: "MyCompany.SecretInternalProbe",
    };
    const buildMechanismPayload = (key: string) => ({
      // One known-good count per family so we can verify the
      // sanitiser didn't drop the whole family by accident.
      ...(key === "fileIndex" && { completedCount: 1 }),
      ...(key === "fileMemory" && { recallCount: 1 }),
      ...(key === "toolSupervision" && { warnCount: 1 }),
      ...(key === "loopRedirect" && { redirectCount: 1 }),
      ...(key === "contextFold" && { chunkCount: 1 }),
      ...(key === "injectionRejected" && { rejectCount: 1 }),
      ...(key === "promptCache" && { hitCount: 1 }),
      ...planted,
    });
    const mechanisms: Record<string, ReturnType<typeof buildMechanismPayload>> = {};
    for (const k of ALL_NEW_EVENT_KINDS) mechanisms[k] = buildMechanismPayload(k);

    const safe = sanitizeForCloud({ metrics: { mechanisms } }) as {
      metrics?: { mechanisms?: Record<string, Record<string, unknown>> };
    };
    const m = safe.metrics?.mechanisms ?? {};

    for (const k of ALL_NEW_EVENT_KINDS) {
      expect(m[k], `mechanisms.${k} must survive`).toBeDefined();
      for (const piiKey of Object.keys(planted)) {
        expect(
          m[k]?.[piiKey],
          `mechanisms.${k}.${piiKey} must be stripped`,
        ).toBeUndefined();
      }
    }

    const serialized = JSON.stringify(safe);
    expect(serialized).not.toContain("/Users/me/secret/project");
    expect(serialized).not.toContain("sess-deadbeef");
    expect(serialized).not.toContain("hmac-deadbeef");
    expect(serialized).not.toContain("Read /Users/me/secret/project/keys.env");
    // The literal custom toolName must NEVER appear anywhere in the
    // payload — not even buried in a free-form string field. This
    // catches a future aggregator that decides to ship a "lastSeenTool"
    // free-form string at any nesting depth.
    expect(serialized).not.toContain("MyCompany.SecretInternalProbe");
  });
});

describe("no-pii-in-envelope — aggregator boundary (toolFamily collapse)", () => {
  it("custom toolName like 'MyCompany.SecretInternalProbe' collapses to 'other' at count time", () => {
    // The aggregator that turns raw `tool_observations` rows into
    // the cloud `byFamily` histogram MUST run every literal tool
    // name through `toolFamily()` before incrementing a bucket. The
    // unit-of-truth for that promise is `toolFamily()` itself: the
    // function returns `"other"` for unknown names, which is the
    // bucket the aggregator increments.
    expect(toolFamily("MyCompany.SecretInternalProbe")).toBe("other");
    expect(toolFamily("UndocumentedFutureToolXYZ")).toBe("other");
    expect(toolFamily("")).toBe("other");
    expect(toolFamilyOf("MyCompany.SecretInternalProbe")).toBe("other");
  });

  it("a sample raw-observations array reduces to family-bucket counts only", () => {
    // Simulate what an aggregator does: walk a list of tool
    // observations, project every `tool_name` through
    // `toolFamily()`, increment the right bucket. Assert the
    // resulting bucket map contains ONLY family slot names — no
    // literal tool names of any kind.
    const rawObservations = [
      { tool_name: "Read" },
      { tool_name: "Grep" },
      { tool_name: "Bash" },
      { tool_name: "MyCompany.SecretInternalProbe" },
      { tool_name: "Internal::Mystery" },
      { tool_name: "" },
    ];
    const counts: Record<string, number> = {};
    for (const obs of rawObservations) {
      const family = toolFamily(obs.tool_name);
      counts[family] = (counts[family] ?? 0) + 1;
    }
    // The keys of the resulting map are ONLY family slots.
    const keys = Object.keys(counts).sort();
    for (const k of keys) {
      expect(
        ["read", "search", "shell", "edit", "write", "web", "task", "other"],
        `unexpected bucket ${k}`,
      ).toContain(k);
    }
    // Specifically: literal tool names did NOT become bucket keys.
    expect(keys).not.toContain("MyCompany.SecretInternalProbe");
    expect(keys).not.toContain("Read");
    expect(keys).not.toContain("Internal::Mystery");
    // And the unknowns did land in `other` (3: probe + Internal +
    // empty).
    expect(counts.other).toBe(3);
  });
});
