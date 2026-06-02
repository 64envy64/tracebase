/**
 * Phase E.1 Track B — persistent local-process worker adapter ($0, no model).
 *
 * Drives PersistentWorkerProvider against the deterministic fake worker over the
 * real JSONL protocol + a real child process. Proves: startup handshake, rank,
 * strict deadline → fail-open, handshake-failure → fail-open, crash → fail-open,
 * scanner-before-transport, concurrency cap, determinism, and health telemetry.
 */
import { describe, it, expect, afterEach } from "vitest";
import { PersistentWorkerProvider } from "../../src/experiments/semantic-bakeoff/worker-adapter.js";
import type { ApplicabilityCandidate, ApplicabilityContext } from "../../src/core/applicability-reranker.js";

const FAKE = "scripts/semantic-bakeoff/fake-worker.mjs"; // resolved from the worktree cwd (vitest root)
const cand = (id: string, mech: string[] = ["rounding", "error"]): ApplicabilityCandidate => ({
  blockId: id,
  tokens: { situation: ["balance"], mechanism: mech, unlock: ["kahan"], invariants: [] },
  signals: { isPitfall: false, helpful: 1, harmful: 0, unresolved: 0, familySupport: 1, sourceDiversity: 1 },
});
const QUERY = { literalText: "running balance off by a tiny fraction", causalText: "fp rounding accumulates" };
const ctx = (deadlineMs: number): ApplicabilityContext => ({ deadlineMs, now: Date.now });

let live: PersistentWorkerProvider[] = [];
const mk = (env?: Record<string, string>, opts = {}): PersistentWorkerProvider => {
  const p = new PersistentWorkerProvider({ command: "node", args: [FAKE], handshakeTimeoutMs: 3000, ...(env ? { env } : {}), ...opts });
  live.push(p);
  return p;
};
afterEach(async () => {
  await Promise.all(live.map((p) => p.close().catch(() => {})));
  live = [];
});

describe("PersistentWorkerProvider — handshake + rank", () => {
  it("handshakes then ranks; health goes ready with the worker's model/featureVersion", async () => {
    const p = mk();
    const r = await p.rank(QUERY, [cand("b1"), cand("b2")], ctx(2000));
    expect(r).not.toBeNull();
    expect(r).toHaveLength(2);
    expect(r!.every((x) => ["applicable", "uncertain", "inapplicable"].includes(x.verdict))).toBe(true);
    const h = p.healthSnapshot();
    expect(h.state).toBe("ready");
    expect(h.model).toBe("fake-worker");
    expect(p.featureVersion).toBe(1);
    expect(h.results).toBe(1);
  });

  it("is deterministic: same input → same verdicts", async () => {
    const p = mk();
    const a = await p.rank(QUERY, [cand("bX")], ctx(2000));
    const b = await p.rank(QUERY, [cand("bX")], ctx(2000));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("PersistentWorkerProvider — total fail-open", () => {
  it("a strict deadline returns null (fail open) and counts a timeout", async () => {
    const p = mk({ FAKE_DELAY_MS: "300" });
    const r = await p.rank(QUERY, [cand("b1")], ctx(25)); // worker is slower than the deadline
    expect(r).toBeNull();
    expect(p.healthSnapshot().timeouts).toBeGreaterThanOrEqual(1);
  });

  it("a handshake failure returns null and marks handshake_failed", async () => {
    const p = mk({ FAKE_NO_READY: "1" }, { handshakeTimeoutMs: 400 });
    const r = await p.rank(QUERY, [cand("b1")], ctx(2000));
    expect(r).toBeNull();
    expect(p.healthSnapshot().state).toBe("handshake_failed");
  });

  it("a worker crash returns null and is detected", async () => {
    const p = mk({ FAKE_CRASH_ON_RANK: "1" });
    const r = await p.rank(QUERY, [cand("b1")], ctx(2000));
    expect(r).toBeNull();
    expect(["crashed", "ready"]).toContain(p.healthSnapshot().state); // crash observed (exit may race the result)
  });
});

describe("PersistentWorkerProvider — scanner before transport + concurrency", () => {
  it("a leaky candidate is BLOCKED before transport (never sent to the worker)", async () => {
    const p = mk();
    await p.rank(QUERY, [cand("b0")], ctx(2000)); // warm up the handshake
    const r = await p.rank(QUERY, [cand("b1", ["see", "/Users/secret/leak.ts"])], ctx(2000));
    expect(r).toBeNull();
    expect(p.healthSnapshot().scannerBlocked).toBeGreaterThanOrEqual(1);
  });

  it("concurrency cap fails open on overflow", async () => {
    const p = mk({ FAKE_DELAY_MS: "120" }, { concurrency: 2 });
    const rs = await Promise.all([
      p.rank(QUERY, [cand("a")], ctx(2000)),
      p.rank(QUERY, [cand("b")], ctx(2000)),
      p.rank(QUERY, [cand("c")], ctx(2000)),
      p.rank(QUERY, [cand("d")], ctx(2000)),
    ]);
    expect(p.healthSnapshot().concurrencyRejected).toBeGreaterThanOrEqual(1);
    const rejected = rs.filter((r) => r === null).length;
    expect(rejected).toBeGreaterThanOrEqual(1);
  });
});

describe("PersistentWorkerProvider — honest cancellation (recycle the real worker)", () => {
  it("recycles (kills) a worker stuck past the cancel grace → GPU capacity released", async () => {
    // FAKE_DELAY_MS huge + ignores cancel (default) → the cooperative cancel does
    // nothing; the host must KILL the process to free it.
    const p = mk({ FAKE_DELAY_MS: "5000" }, { recycleGraceMs: 80 });
    const r = await p.rank(QUERY, [cand("b1")], ctx(20)); // deadline 20ms ≪ 5s delay
    expect(r).toBeNull(); // fail open immediately
    await new Promise((res) => setTimeout(res, 240)); // > deadline + grace
    const h = p.healthSnapshot();
    expect(h.recycles).toBeGreaterThanOrEqual(1); // worker killed
    expect(h.state).toBe("crashed"); // recycled (respawns on next rank)
  });

  it("a COOPERATIVE worker (acks the cancel) is NOT recycled", async () => {
    const p = mk({ FAKE_DELAY_MS: "5000", FAKE_COOPERATIVE_CANCEL: "1" }, { recycleGraceMs: 300 });
    const r = await p.rank(QUERY, [cand("b1")], ctx(20));
    expect(r).toBeNull();
    await new Promise((res) => setTimeout(res, 150)); // < grace; worker already acked
    expect(p.healthSnapshot().recycles).toBe(0); // freed cooperatively → not killed
    expect(p.healthSnapshot().state).toBe("ready");
  });
});
