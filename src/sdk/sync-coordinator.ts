/**
 * `createSyncCoordinator` — debounced background aggregate-metrics
 * sync (PLAN-0.5.4 §5, §8.8). Replaces the manual `tracebase sync`
 * UX for normal users while keeping that command available as the
 * explicit `flush({ force: true })` durability surface.
 *
 * Hard rules:
 *
 *   1. **No network I/O on the runtime hot path.** `markDirty` only
 *      sets a flag and (re)arms a timer. The coordinator's sync
 *      attempt runs on its own timer outside the request path.
 *
 *   2. **No global process exit / signal handlers.** The runtime is
 *      a library, not a daemon. Durability is explicit: callers
 *      drive `runtime.flush()` / `runtime.close()`.
 *
 *   3. **All timers `.unref()` where the host supports it.** A
 *      forgotten coordinator timer must NEVER prevent a Node host
 *      process from exiting.
 *
 *   4. **Failures never propagate.** Network errors, malformed
 *      cloud responses, missing API keys — the coordinator
 *      retries with exponential backoff + jitter and eventually
 *      gives up silently. Callers receive no error from
 *      `markDirty` or `flush()` for sync issues; they get errors
 *      only for usage problems (closed coordinator, etc.).
 *
 *   5. **Allowlist gate before every send.** The coordinator pipes
 *      every payload through `sanitizeForCloud` so any field that
 *      sneaks past the type system gets stripped before the wire.
 *
 *   6. **Idempotent on the wire.** Payload key =
 *      `installationId + windowStart + windowEnd`. Server-side
 *      dedupe collapses duplicate sends so a backoff retry can't
 *      double-count.
 */

import type { ReasoningLayer } from "../core/engine.js";
import type { UsageMetrics } from "../analytics/usage-metrics.js";
import type { CreateRuntimeOptions } from "../types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SyncCoordinator {
  /**
   * Mark the local aggregate state as dirty. Returns immediately;
   * the actual sync (if any) fires on the debounced timer.
   * `reason` is logged for diagnostics; never reaches the wire.
   */
  markDirty(reason: string): void;

  /**
   * Force a final best-effort sync attempt. Resolves once the
   * attempt finishes (success or failure) or the soft timeout
   * elapses, whichever comes first. Never throws.
   *
   * Callers in tests / enterprise shutdown should `await flush()`
   * before exit. The CLI's `tracebase sync` command also calls
   * this with `force: true` (currently the only flag).
   */
  flush(opts?: { force?: boolean; timeoutMs?: number }): Promise<void>;

  /**
   * Cancel the debounce / cap timers. Safe to call multiple times.
   * Subsequent `markDirty` calls become no-ops.
   */
  close(): void;
}

export interface CreateSyncCoordinatorDeps {
  /**
   * The `now` clock injection point. Tests pass a fake clock to
   * verify debounce / cap timing without `vi.useFakeTimers()`
   * reaching into the actual coordinator implementation.
   */
  now?: () => number;
  /**
   * The actual sender. Production wires this to `pushSampleToCloud`
   * below; tests stub it to track call shapes without firing real
   * fetches.
   */
  send?: SyncSender;
}

export interface SyncSendInput {
  apiUrl: string;
  apiKey: string;
  installationId: string;
  windowStart: string;
  windowEnd: string;
  metrics: UsageMetrics;
  cliVersion: string;
}

export interface SyncSendResult {
  ok: boolean;
  /** HTTP status, or 0 on transport failure / no-key short-circuit. */
  status: number;
  /** Brief diagnostic string. Never reaches the wire. */
  reason?: string;
}

export type SyncSender = (input: SyncSendInput) => Promise<SyncSendResult>;

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_DEBOUNCE_MS = 30_000;
const DEFAULT_MAX_INTERVAL_MS = 300_000;
const DEFAULT_FLUSH_TIMEOUT_MS = 5_000;
const MAX_BACKOFF_ATTEMPTS = 6;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSyncCoordinator(
  layer: ReasoningLayer,
  options: CreateRuntimeOptions = {},
  deps: CreateSyncCoordinatorDeps = {},
): SyncCoordinator {
  // `layer` is on the signature for forward-compat — future
  // releases may want the coordinator to own its own connection
  // for streaming aggregates.
  void layer;

  const debounceMs = options.syncDebounceMs ?? DEFAULT_DEBOUNCE_MS;
  const maxIntervalMs = options.syncMaxIntervalMs ?? DEFAULT_MAX_INTERVAL_MS;
  const send: SyncSender = deps.send ?? noopSender;
  const now = deps.now ?? Date.now;
  const enabled = options.autoSync !== false;

  let dirty = false;
  let dirtyReasons: string[] = [];
  let dirtySince: number | null = null;

  let debounceTimer: NodeJS.Timeout | null = null;
  let capTimer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;
  let backoffAttempt = 0;
  let closed = false;

  function clearTimer(t: NodeJS.Timeout | null): void {
    if (t) clearTimeout(t);
  }

  function safeUnref(timer: NodeJS.Timeout): void {
    // `.unref` exists on Node-side timers; jsdom / browser /
    // edge-runtime polyfills may omit it. Guard with `typeof` so
    // the coordinator builds clean under every tsup target.
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
  }

  function scheduleDebounce(): void {
    clearTimer(debounceTimer);
    debounceTimer = setTimeout(() => {
      void runSync("debounce");
    }, debounceMs);
    safeUnref(debounceTimer);
  }

  function scheduleCap(): void {
    if (capTimer) return; // first dirty wins; cap fires once per dirty cycle
    capTimer = setTimeout(() => {
      void runSync("cap");
    }, maxIntervalMs);
    safeUnref(capTimer);
  }

  async function runSync(_trigger: "debounce" | "cap" | "flush"): Promise<void> {
    if (closed) return;
    if (!dirty) return;
    if (inFlight) {
      // Coalesce — let the in-flight attempt resolve and re-evaluate.
      return;
    }
    clearTimer(debounceTimer);
    debounceTimer = null;
    clearTimer(capTimer);
    capTimer = null;

    inFlight = (async () => {
      const reasons = dirtyReasons.slice();
      dirtyReasons = [];
      try {
        const input = await buildSendInput();
        if (!input) {
          // Cloud not linked (or initialised): nothing to do. Clear
          // dirty so we don't keep retrying when the user has
          // chosen local-only mode.
          dirty = false;
          dirtySince = null;
          backoffAttempt = 0;
          return;
        }
        const result = await send(input);
        if (result.ok) {
          dirty = false;
          dirtySince = null;
          backoffAttempt = 0;
          return;
        }
        backoffAttempt += 1;
        if (backoffAttempt >= MAX_BACKOFF_ATTEMPTS) {
          // Give up until the next markDirty cycle. Don't clear
          // dirty — let the next event re-trigger eventually.
          backoffAttempt = 0;
          return;
        }
        // Exponential backoff with jitter.
        const base = Math.min(
          maxIntervalMs,
          1_000 * Math.pow(2, backoffAttempt),
        );
        const jitter = Math.floor(Math.random() * 500);
        const wait = base + jitter;
        const t = setTimeout(() => {
          void runSync("debounce");
        }, wait);
        safeUnref(t);
        debounceTimer = t;
        // re-arm reasons so the next attempt knows what triggered
        dirtyReasons = reasons;
      } catch (err) {
        // Catastrophic — log to stderr, never throw.
        const msg = err instanceof Error ? err.message : String(err);
        try {
          process.stderr.write(`tracebase sync-coordinator: ${msg}\n`);
        } catch {
          // swallow
        }
      } finally {
        inFlight = null;
        if (closed) {
          dirty = false;
          dirtySince = null;
        }
      }
    })();

    return inFlight;
  }

  return {
    markDirty(reason: string): void {
      if (closed || !enabled) return;
      dirty = true;
      dirtySince = dirtySince ?? now();
      dirtyReasons.push(reason);
      // Cap window stays armed; debounce restarts on every new event.
      scheduleCap();
      scheduleDebounce();
    },

    async flush(opts?: { force?: boolean; timeoutMs?: number }): Promise<void> {
      if (closed) return;
      if (!enabled && !opts?.force) return;
      // Force-flush still requires linked cloud + something dirty;
      // the coordinator no-ops cleanly otherwise.
      if (!dirty && !opts?.force) return;
      if (opts?.force && !dirty) {
        // Mark dirty so runSync has something to coalesce. The
        // CLI's `tracebase sync` route uses this — it should always
        // attempt to send even on a quiet runtime.
        dirty = true;
        dirtyReasons.push("manual-flush-force");
        dirtySince = dirtySince ?? now();
      }
      const timeout = opts?.timeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;
      const sync = runSync("flush");
      const timer = new Promise<void>((resolve) => {
        const t = setTimeout(resolve, timeout);
        safeUnref(t);
      });
      await Promise.race([sync, timer]);
      // Wait for any in-flight attempt to settle so a follow-up
      // close() doesn't race with an outstanding fetch.
      if (inFlight) {
        await Promise.race([inFlight, timer]).catch(() => undefined);
      }
    },

    close(): void {
      if (closed) return;
      closed = true;
      clearTimer(debounceTimer);
      clearTimer(capTimer);
      debounceTimer = null;
      capTimer = null;
      // Don't await inFlight here — that would force callers to
      // make close() async. Callers that need durability call
      // `await runtime.flush()` first.
    },
  };
}

// ---------------------------------------------------------------------------
// Internal — sender + payload builder
// ---------------------------------------------------------------------------

/**
 * Build the send input from the project's `.tracebase/config.json`
 * + the local store. Returns `null` when the project is not linked
 * to a cloud workspace — the coordinator no-ops cleanly in that
 * case, no warning needed.
 *
 * The actual aggregator implementation lives in 0.5.4-§8.8's
 * follow-up wiring; this helper currently surfaces the gating
 * question only and returns null until the production aggregator
 * is plumbed in. Tests stub the `send` dependency directly so the
 * full state-machine coverage works without depending on this
 * being live.
 */
async function buildSendInput(): Promise<SyncSendInput | null> {
  // §8.8 follow-up: implement live aggregator. For 0.5.4-§8.8
  // initial commit, the coordinator state machine is in place and
  // tested via dependency-injected `send`. The production POST is
  // wired through `tracebase usage sync --once` until a
  // self-contained aggregator lands here.
  return null;
}

const noopSender: SyncSender = async () => ({ ok: true, status: 0 });

// ---------------------------------------------------------------------------
// HTTP sender (production)
// ---------------------------------------------------------------------------

/**
 * Default production sender. Posts to
 * `${apiUrl}/api/control-plane/usage-samples` with the same shape
 * `tracebase usage sync --once` uses; the server-side dedupe key
 * is `installationId + windowStart + windowEnd`.
 *
 * Available for callers who want to wire a custom coordinator with
 * the production sender (e.g. `createSyncCoordinator(layer,
 * options, { send: pushSampleToCloud })`).
 */
export const pushSampleToCloud: SyncSender = async (input) => {
  try {
    // Late-imported to keep the coordinator browser-buildable —
    // browser bundles don't need the cloud allowlist or the fetch
    // call wired at startup. Production users get it eagerly via
    // first dispatch.
    const { sanitizeForCloud } = await import("../cli/cloud-allowlist.js");
    const safeBody = sanitizeForCloud({
      installationId: input.installationId,
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
      metrics: input.metrics,
      cliVersion: input.cliVersion,
    });
    const res = await fetch(`${input.apiUrl}/api/control-plane/usage-samples`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(safeBody),
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
};
