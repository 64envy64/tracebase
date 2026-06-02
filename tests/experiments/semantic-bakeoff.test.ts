/**
 * Phase D.5 Track B — the semantic-applicability bakeoff substrate ($0 smoke).
 *
 * Proves the substrate invariants with NO model, network, or weights: the typed
 * boundary, a strict deadline + total fail-open, scanned-DTOs-only, no-implicit-
 * network, deterministic fake provider, and a frozen reproducible manifest.
 */
import { describe, it, expect } from "vitest";
import {
  runProbe,
  runBakeoff,
  scanProbeDTO,
  DeterministicFakeProvider,
  CANDIDATE_MANIFEST,
  manifestDigest,
  type BakeoffProvider,
  type BakeoffProbeDTO,
} from "../../src/experiments/semantic-bakeoff/index.js";
import { DeterministicApplicabilityReranker, type ApplicabilityCandidate } from "../../src/core/applicability-reranker.js";

const cand = (id: string, mech: string[]): ApplicabilityCandidate => ({
  blockId: id,
  tokens: { situation: ["balance", "off"], mechanism: mech, unlock: ["kahan", "sum"], invariants: [] },
  signals: { isPitfall: false, helpful: 2, harmful: 0, unresolved: 0, familySupport: 2, sourceDiversity: 1 },
});
const probe = (probeId: string, candidates: ApplicabilityCandidate[]): BakeoffProbeDTO => ({
  probeId,
  query: { literalText: "running balance is off by a tiny fraction", causalText: "floating point rounding accumulates" },
  candidates,
});
const reg = (manifestId: string, provider: ConstructorParameters<typeof DeterministicFakeProvider>[0] | DeterministicFakeProvider, network: BakeoffProvider["network"] = "local-process"): BakeoffProvider => ({
  manifestId,
  provider: provider instanceof DeterministicFakeProvider ? provider : new DeterministicFakeProvider(provider),
  network,
});
const fallback = () => new DeterministicApplicabilityReranker();
const DTO = probe("p1", [cand("b1", ["rounding", "error", "bits"]), cand("b2", ["unrelated", "tokens"])]);

describe("bakeoff boundary — deadline + total fail-open", () => {
  it("a healthy provider serves its own verdicts (no fallback)", async () => {
    const out = await runProbe(reg("fake", {}), DTO, fallback(), { now: () => 0 });
    expect(out.usedFallback).toBe(false);
    expect(out.providerName).toBe("fake-deterministic");
    expect(out.results).toHaveLength(2);
  });

  it("fails open to the deterministic baseline on null / throw", async () => {
    const onNull = await runProbe(reg("fake", { returnNull: true }), DTO, fallback(), { now: () => 0 });
    expect(onNull.usedFallback).toBe(true);
    expect(onNull.fallbackReason).toBe("null");
    expect(onNull.providerName).toBe(new DeterministicApplicabilityReranker().name);
    const onThrow = await runProbe(reg("fake", { throwErr: true }), DTO, fallback(), { now: () => 0 });
    expect(onThrow.usedFallback).toBe(true);
    expect(onThrow.fallbackReason).toBe("threw");
  });

  it("a STRICT deadline fails open with reason=timeout", async () => {
    // delay 60ms >> deadline 5ms → the race resolves to timeout, fallback serves.
    const out = await runProbe(reg("fake", { delayMs: 60 }), DTO, fallback(), { deadlineMs: 5 });
    expect(out.usedFallback).toBe(true);
    expect(out.fallbackReason).toBe("timeout");
    expect(out.results).not.toBeNull(); // the baseline still produced a verdict
  });

  it("NO implicit network: a remote-explicit provider is blocked unless allowRemote", async () => {
    const remote = reg("fake-remote", {}, "remote-explicit");
    const blocked = await runProbe(remote, DTO, fallback(), { now: () => 0 });
    expect(blocked.usedFallback).toBe(true);
    expect(blocked.fallbackReason).toBe("network-blocked");
    const allowed = await runProbe(remote, DTO, fallback(), { now: () => 0, allowRemote: true });
    expect(allowed.usedFallback).toBe(false); // opt-in lets it run
  });
});

describe("bakeoff harness — scanned DTOs only + determinism", () => {
  it("drops a leaky fixture BEFORE any provider sees it (scanned DTOs only)", async () => {
    const leaky = probe("leaky", [cand("b1", ["see", "/Users/secret/leak.ts", "here"])]);
    const run = await runBakeoff([reg("fake", {})], [DTO, leaky], { now: () => 0 });
    expect(run.rejected).toHaveLength(1);
    expect(run.rejected[0]!.probeId).toBe("leaky");
    expect(run.rejected[0]!.pattern).toBe("abs-path-posix");
    expect(run.scanned).toBe(1);
    // only the clean DTO produced an outcome.
    expect(run.outcomes.every((o) => o.probeId === "p1")).toBe(true);
  });

  it("scanProbeDTO returns null on a clean fixture, a pattern name on a leak", () => {
    expect(scanProbeDTO(DTO)).toBeNull();
    expect(scanProbeDTO(probe("x", [cand("b", ["AKIA", "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"])]))).toBe("api-key-sk");
  });

  it("is deterministic: identical inputs → identical outcomes", async () => {
    const a = await runProbe(reg("fake", {}), DTO, fallback(), { now: () => 0 });
    const b = await runProbe(reg("fake", {}), DTO, fallback(), { now: () => 0 });
    expect(JSON.stringify(a.results)).toBe(JSON.stringify(b.results));
  });
});

describe("frozen candidate manifest", () => {
  it("every candidate has a source + a license; confirmed ones are verified Apache-2.0 w/ weights", () => {
    for (const e of CANDIDATE_MANIFEST) {
      expect(e.source.length).toBeGreaterThan(0);
      expect(e.license.length).toBeGreaterThan(0);
    }
    const baseline = CANDIDATE_MANIFEST.find((e) => e.id === "deterministic-baseline")!;
    expect(baseline.weightsDownloadable).toBe(false);
    expect(baseline.network).toBe("none");
    for (const id of ["qwen3-reranker-0.6b", "bge-reranker-v2-m3", "memreranker"]) {
      const e = CANDIDATE_MANIFEST.find((c) => c.id === id)!;
      expect(e.status).toBe("verified");
      expect(e.license).toBe("apache-2.0");
      expect(e.weightsDownloadable).toBe(true);
      expect(e.offlineCapable).toBe(true);
      expect(e.source).toContain("huggingface.co");
    }
  });

  it("manifestDigest is stable + content-addressed (order-sensitive)", () => {
    expect(manifestDigest()).toBe(manifestDigest()); // stable
    expect(manifestDigest([...CANDIDATE_MANIFEST].reverse())).not.toBe(manifestDigest());
  });
});
