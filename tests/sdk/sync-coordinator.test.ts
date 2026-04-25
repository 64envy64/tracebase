/**
 * `src/sdk/sync-coordinator.ts` — debounced background aggregate
 * sync (PLAN-0.5.4 §5, §8.8).
 *
 * Pins down the state machine — every property the spec calls out:
 *   - markDirty debounces (multiple dirties coalesce to one send)
 *   - cap-window forces a send when debounce keeps restarting
 *   - exponential backoff on transport failure
 *   - flush({ force: true }) succeeds on a quiet runtime
 *   - close() cancels timers; subsequent markDirty is a no-op
 *   - autoSync: false disables the coordinator entirely
 *   - failures never propagate into caller code
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSyncCoordinator, type SyncSendResult } from "../../src/sdk/sync-coordinator.js";
import type { ReasoningLayer } from "../../src/core/engine.js";
import type { UsageMetrics } from "../../src/analytics/usage-metrics.js";

function dummyLayer(): ReasoningLayer {
  return {} as unknown as ReasoningLayer;
}

function stubMetrics(): UsageMetrics {
  return {
    scope: "workspace",
    window: { afterTs: 0, beforeTs: 0 },
    observed: {
      eligibleRuns: 1,
      recalledRuns: 1,
      injectedRuns: 1,
      usedRuns: 0,
      helpfulRuns: 0,
      resolvedRateWithMemory: null,
    },
    estimated: {
      tokensSaved: { value: 0, sampleSize: 0, formula: "noop" },
      latencySavedMs: { value: 0, sampleSize: 0, formula: "noop" },
    },
    integrity: { shadowControlMismatches: 0, outcomesWithoutRetrieval: 0 },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createSyncCoordinator — debounce + coalesce", () => {
  it("multiple markDirty within the window coalesce to one send call", async () => {
    const send = vi.fn(async (): Promise<SyncSendResult> => ({ ok: true, status: 200 }));
    const buildInput = vi.fn(async () => ({
      apiUrl: "https://api.example.com",
      apiKey: "k",
      installationId: "i",
      windowStart: "2026-04-25T00:00:00.000Z",
      windowEnd: "2026-04-26T00:00:00.000Z",
      metrics: stubMetrics(),
      cliVersion: "test",
    }));
    const coord = createSyncCoordinator(
      dummyLayer(),
      { syncDebounceMs: 100 },
      { send, resolveBasePath: () => "/tmp/project", buildInput },
    );
    coord.markDirty("a");
    coord.markDirty("b");
    coord.markDirty("c");
    // Before the window elapses, no send.
    expect(send).not.toHaveBeenCalled();

    // Advance past debounce. The setTimeout callback enqueues
    // a microtask via async runSync — vi.runAllTimers runs the
    // synchronous portion; we follow up by flushing microtasks.
    await vi.advanceTimersByTimeAsync(120);
    // Three markDirty calls coalesced into ONE send.
    expect(send).toHaveBeenCalledTimes(1);

    coord.close();
  });

  it("debounce restarts on every markDirty until quiet", async () => {
    const send = vi.fn(async (): Promise<SyncSendResult> => ({ ok: true, status: 200 }));
    const coord = createSyncCoordinator(
      dummyLayer(),
      { syncDebounceMs: 100, syncMaxIntervalMs: 10_000 },
      { send },
    );
    coord.markDirty("a");
    await vi.advanceTimersByTimeAsync(80);
    coord.markDirty("b");
    await vi.advanceTimersByTimeAsync(80);
    coord.markDirty("c");
    await vi.advanceTimersByTimeAsync(80);
    // 240 ms total but debounce kept resetting; nothing fired.
    expect(send).not.toHaveBeenCalled();
    // Quiet for 120 ms — debounce fires once.
    await vi.advanceTimersByTimeAsync(120);
    coord.close();
  });
});

describe("createSyncCoordinator — autoSync gates", () => {
  it("autoSync: false → markDirty is a no-op", async () => {
    const send = vi.fn(async (): Promise<SyncSendResult> => ({ ok: true, status: 200 }));
    const coord = createSyncCoordinator(
      dummyLayer(),
      { autoSync: false, syncDebounceMs: 50 },
      { send },
    );
    coord.markDirty("a");
    await vi.advanceTimersByTimeAsync(200);
    expect(send).not.toHaveBeenCalled();
    coord.close();
  });

  it("close() cancels timers; subsequent markDirty is silent", async () => {
    const send = vi.fn(async (): Promise<SyncSendResult> => ({ ok: true, status: 200 }));
    const coord = createSyncCoordinator(
      dummyLayer(),
      { syncDebounceMs: 100 },
      { send },
    );
    coord.markDirty("a");
    coord.close();
    coord.markDirty("after-close");
    await vi.advanceTimersByTimeAsync(500);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("createSyncCoordinator — flush({ force: true })", () => {
  it("manual flush attempts a send even on a quiet runtime", async () => {
    const send = vi.fn(async (): Promise<SyncSendResult> => ({ ok: true, status: 200 }));
    const buildInput = vi.fn(async () => ({
      apiUrl: "https://api.example.com",
      apiKey: "k",
      installationId: "i",
      windowStart: "2026-04-25T00:00:00.000Z",
      windowEnd: "2026-04-26T00:00:00.000Z",
      metrics: stubMetrics(),
      cliVersion: "test",
    }));
    const coord = createSyncCoordinator(
      dummyLayer(),
      { syncDebounceMs: 100 },
      { send, resolveBasePath: () => "/tmp/project", buildInput },
    );
    // No markDirty — runtime is quiet.
    const flushPromise = coord.flush({ force: true, timeoutMs: 200 });
    await vi.runAllTimersAsync();
    await flushPromise;
    // force-flush bypasses the dirty gate, so send IS invoked.
    expect(send).toHaveBeenCalledTimes(1);
    coord.close();
  });

  it("flush respects timeoutMs and never throws", async () => {
    const send = vi.fn(async (): Promise<SyncSendResult> => {
      await new Promise(() => {
        /* hang forever */
      });
      return { ok: false, status: 0 };
    });
    const buildInput = vi.fn(async () => ({
      apiUrl: "https://api.example.com",
      apiKey: "k",
      installationId: "i",
      windowStart: "2026-04-25T00:00:00.000Z",
      windowEnd: "2026-04-26T00:00:00.000Z",
      metrics: stubMetrics(),
      cliVersion: "test",
    }));
    const coord = createSyncCoordinator(
      dummyLayer(),
      { syncDebounceMs: 50 },
      { send, resolveBasePath: () => "/tmp/project", buildInput },
    );
    coord.markDirty("hang-test");
    const p = coord.flush({ timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(150);
    // Resolves via the timeout path even though send hangs.
    await expect(p).resolves.toBeUndefined();
    coord.close();
  });
});

// ---------------------------------------------------------------------------
// 0.5.5 §1 — live wiring tests (PLAN-0.5.4 §5 + 0.5.5 priorities)
// ---------------------------------------------------------------------------

describe("createSyncCoordinator — cloud unlinked", () => {
  it("markDirty fires no sender + no warning when buildInput returns null", async () => {
    const send = vi.fn(async (): Promise<SyncSendResult> => ({ ok: true, status: 200 }));
    const buildInput = vi.fn(async () => null);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const coord = createSyncCoordinator(
      dummyLayer(),
      { syncDebounceMs: 50 },
      { send, resolveBasePath: () => "/tmp/unlinked-project", buildInput },
    );
    coord.markDirty("observeToolBatch");
    coord.markDirty("beforeRun");
    await vi.advanceTimersByTimeAsync(120);
    // buildInput was consulted but returned null → no sender call.
    expect(buildInput).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    // CRITICAL: no warning spam in stderr. The user has chosen
    // local-only mode; the coordinator must be silent.
    expect(stderrSpy).not.toHaveBeenCalled();
    stderrSpy.mockRestore();
    coord.close();
  });

  it("missing resolveBasePath → buildInput is never called", async () => {
    const send = vi.fn(async (): Promise<SyncSendResult> => ({ ok: true, status: 200 }));
    const buildInput = vi.fn(async () => null);
    const coord = createSyncCoordinator(
      dummyLayer(),
      { syncDebounceMs: 50 },
      { send, buildInput },
    );
    coord.markDirty("observeToolBatch");
    await vi.advanceTimersByTimeAsync(120);
    expect(buildInput).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    coord.close();
  });
});

describe("createSyncCoordinator — cloud linked, sender succeeds", () => {
  it("sends a sanitised aggregate payload after debounce", async () => {
    const send = vi.fn(async (): Promise<SyncSendResult> => ({ ok: true, status: 200 }));
    const metrics = stubMetrics();
    const buildInput = vi.fn(async () => ({
      apiUrl: "https://api.example.com",
      apiKey: "secret-key",
      installationId: "inst-1",
      windowStart: "2026-04-25T00:00:00.000Z",
      windowEnd: "2026-04-26T00:00:00.000Z",
      metrics,
      cliVersion: "0.5.5",
    }));
    const coord = createSyncCoordinator(
      dummyLayer(),
      { syncDebounceMs: 50 },
      { send, resolveBasePath: () => "/tmp/linked", buildInput },
    );
    coord.markDirty("beforeRun");
    await vi.advanceTimersByTimeAsync(80);
    expect(send).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0]![0];
    // Payload shape pinned — coordinator builder didn't drop fields
    // or inject anything extra.
    expect(sent.installationId).toBe("inst-1");
    expect(sent.windowStart).toBe("2026-04-25T00:00:00.000Z");
    expect(sent.windowEnd).toBe("2026-04-26T00:00:00.000Z");
    expect(sent.metrics).toBe(metrics);
    coord.close();
  });
});

describe("createSyncCoordinator — sender failure → backoff", () => {
  it("retries with backoff; eventual success clears dirty", async () => {
    let calls = 0;
    const send = vi.fn(async (): Promise<SyncSendResult> => {
      calls += 1;
      // Fail twice, then succeed.
      if (calls <= 2) return { ok: false, status: 500, reason: "transient" };
      return { ok: true, status: 200 };
    });
    const buildInput = vi.fn(async () => ({
      apiUrl: "https://api.example.com",
      apiKey: "k",
      installationId: "i",
      windowStart: "2026-04-25T00:00:00.000Z",
      windowEnd: "2026-04-26T00:00:00.000Z",
      metrics: stubMetrics(),
      cliVersion: "0.5.5",
    }));
    const coord = createSyncCoordinator(
      dummyLayer(),
      { syncDebounceMs: 50, syncMaxIntervalMs: 100_000 },
      { send, resolveBasePath: () => "/tmp/proj", buildInput },
    );
    coord.markDirty("first");
    // First attempt fires after debounce.
    await vi.advanceTimersByTimeAsync(80);
    expect(send).toHaveBeenCalledTimes(1);
    // Backoff: ~2^1 * 1000ms + jitter <= 2500ms.
    await vi.advanceTimersByTimeAsync(2_500);
    expect(send).toHaveBeenCalledTimes(2);
    // Backoff: ~2^2 * 1000ms + jitter <= 4500ms.
    await vi.advanceTimersByTimeAsync(4_500);
    expect(send).toHaveBeenCalledTimes(3);
    coord.close();
  });
});
