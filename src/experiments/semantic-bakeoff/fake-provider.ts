/**
 * Deterministic FAKE applicability provider — the substrate's test double. It is
 * the ONLY non-baseline provider implemented here: the real model adapters
 * (Qwen3 / BGE / MemReranker — see the manifest) are deliberately NOT built yet
 * (no weights, no inference, no network). The fake lets the bakeoff harness be
 * exercised + the fail-open / timeout / determinism invariants be proven at $0.
 *
 * Fully deterministic: a fixed input yields a fixed verdict (a stable hash of the
 * candidate id). Configurable to simulate the failure modes the boundary must
 * absorb (null, throw, slow→timeout).
 */
import type {
  ApplicabilityProvider,
  ApplicabilityQueryViews,
  ApplicabilityCandidate,
  ApplicabilityContext,
  ApplicabilityResult,
  ApplicabilityVerdict,
} from "../../core/applicability-reranker.js";

/** Stable FNV-1a hash → [0,1). Deterministic, dependency-free. */
function stableUnit(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0xffffffff;
}

export interface FakeProviderOptions {
  /** Forced verdict; default derives a stable verdict from the candidate hash. */
  verdict?: ApplicabilityVerdict;
  /** Return null (simulate a clean fail-open). */
  returnNull?: boolean;
  /** Throw (simulate a provider crash). */
  throwErr?: boolean;
  /** Await this many ms before resolving (simulate a slow provider → deadline). */
  delayMs?: number;
  name?: string;
  featureVersion?: number;
}

export class DeterministicFakeProvider implements ApplicabilityProvider {
  readonly name: string;
  readonly featureVersion: number;
  constructor(private readonly opts: FakeProviderOptions = {}) {
    this.name = opts.name ?? "fake-deterministic";
    this.featureVersion = opts.featureVersion ?? 1;
  }

  async rank(
    _query: ApplicabilityQueryViews,
    candidates: readonly ApplicabilityCandidate[],
    _ctx: ApplicabilityContext,
  ): Promise<ApplicabilityResult[] | null> {
    if (this.opts.delayMs && this.opts.delayMs > 0) {
      await new Promise((r) => setTimeout(r, this.opts.delayMs));
    }
    if (this.opts.throwErr) throw new Error("fake provider failure");
    if (this.opts.returnNull) return null;
    return candidates.map((c) => {
      const u = stableUnit(c.blockId);
      const verdict: ApplicabilityVerdict = this.opts.verdict ?? (u > 0.66 ? "applicable" : u > 0.33 ? "uncertain" : "inapplicable");
      return {
        blockId: c.blockId,
        verdict,
        confidence: u,
        reasons: [],
        featureVersion: this.featureVersion,
        evidence: { mechanism: u, remediation: 0, invariants: 0, discriminativeGap: u / 2, contradiction: 0, familySupport: c.signals.familySupport },
      };
    });
  }
}
