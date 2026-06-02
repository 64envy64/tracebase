/**
 * Canary circuit breaker (Phase D.4.2) — crash-safe, latched, locally persisted.
 *
 * Once any frozen kill condition (canary-health.ts) fires, the breaker LATCHES
 * tripped and stays tripped until an explicit reviewed `reset` — effective
 * serving is OFF in the meantime. The env / global kill switches still win
 * independently (resolveCanaryServingState), so a tripped breaker is one of
 * three orthogonal OFF gates.
 *
 * Two paths, deliberately split:
 *   • HOT (serving): `readBreakerSnapshot` reads a tiny JSON (tripped + reasons).
 *     Never a full event scan. A malformed/corrupt state FAILS OFF (tripped).
 *   • INGESTION (on canary exposure/outcome): `refreshBreaker` re-derives the
 *     health counters from a BOUNDED, canary-only ledger window, re-evaluates the
 *     frozen rules, and latches. Triggered incrementally by canary activity; never
 *     on the hot path. Persistence is atomic (temp + rename) so a crash mid-write
 *     can't tear the latched state.
 *
 * `reset` stamps a `resetAtMs` watermark so a post-reset refresh ignores the
 * pre-reset events that tripped it — a reviewed reset truly starts fresh rather
 * than instantly re-tripping on the same historical rows.
 */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { BlockStore } from "../core/block-store.js";
import type { AnalyticsEvent } from "../types.js";
import { joinApplicabilityTrials } from "../analytics/applicability-ledger.js";
import { detectLeakageExtended } from "../core/guard.js";
import { APPLICABILITY_FEATURE_VERSION } from "../core/applicability-reranker.js";
import { readApplicabilityCanaryConfig, resolveCanaryServingState } from "../core/config.js";
import {
  emptyHealthCounters,
  evaluateCanaryHealth,
  pushLatencySample,
  type CanaryHealthCounters,
  type CanaryHealthVerdict,
  type CanaryHealthTripReason,
} from "./canary-health.js";

export const CANARY_BREAKER_VERSION = 1 as const;
export const CANARY_BREAKER_FILE = "canary-breaker.json";
/** Explicit acknowledgement token required by `canary reset-breaker --ack`. */
export const BREAKER_RESET_ACK = "reset-breaker.v1";
/** Bounded recompute window. The pre-reg max run is 14 days; +1 day margin. NOT the hot path. */
export const BREAKER_WINDOW_MS = 15 * 24 * 60 * 60 * 1000;
/** Hard cap on events pulled per recompute — bounds the (cold) ingestion read. */
export const BREAKER_EVENT_LIMIT = 200_000;

/**
 * The runtime SERVING receipt (E.2.3) — distinct from the breaker HEALTH state and
 * from the preflight receipt. Stamped ONLY on a confirmed, durably-admitted
 * treatment exposure, so its freshness is an HONEST "the runtime is serving now"
 * heartbeat. The breaker state file is NOT such a heartbeat: it also advances on
 * outcome ingestion and can be arbitrarily old, so its mere presence must not be
 * read as "live".
 */
export const CANARY_RUNTIME_RECEIPT_FILE = "canary-runtime.json";
export const CANARY_RUNTIME_RECEIPT_VERSION = 1 as const;
/**
 * Bounded freshness window. A runtime receipt older than this is NOT "live" — the
 * serving runtime has not confirmed an exposure recently — so the effective status
 * falls back to ARMED (configured, but serving unconfirmed NOW).
 */
export const LIVE_HEARTBEAT_FRESHNESS_MS = 24 * 60 * 60 * 1000; // 24h

/** The canary-relevant event types the ledger join needs — the read is filtered to these. */
const CANARY_EVENT_TYPES: AnalyticsEvent["event"][] = [
  "reasoning.applicability_comparison",
  "injection",
  "agent_used",
  "outcome",
  "reasoning.applicability_canary_exposure",
];

export interface CanaryBreakerState {
  version: typeof CANARY_BREAKER_VERSION;
  /** Latched: once true, stays true until an explicit reviewed reset. */
  tripped: boolean;
  /** The reasons captured AT the first trip (preserved across later refreshes). */
  reasons: CanaryHealthTripReason[];
  /** When the breaker first tripped (ms), or null. */
  trippedAtMs: number | null;
  /** Watermark from the last reset — refresh ignores events at/before it. */
  resetAtMs: number | null;
  counters: CanaryHealthCounters;
  /** The most recent evaluation (current view; `reasons` above is the first-trip cause). */
  lastVerdict: CanaryHealthVerdict;
  updatedAtMs: number;
}

/** The CHEAP hot-path snapshot — tripped + reasons only. */
export interface CanaryBreakerSnapshot {
  tripped: boolean;
  reasons: string[];
}

function breakerPath(basePath: string): string {
  return join(basePath, ".tracebase", CANARY_BREAKER_FILE);
}

/** Crash-safe atomic write: temp + rename (atomic on the same filesystem). */
function writeStateAtomic(basePath: string, state: CanaryBreakerState): void {
  const p = breakerPath(basePath);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  renameSync(tmp, p);
}

function isValidState(raw: unknown): raw is CanaryBreakerState {
  if (!raw || typeof raw !== "object") return false;
  const r = raw as Partial<CanaryBreakerState>;
  return r.version === CANARY_BREAKER_VERSION && typeof r.tripped === "boolean" && typeof r.counters === "object" && r.counters !== null;
}

/**
 * Full state for `canary health` / CLI. `null` = never created (canary never
 * exposed); `"malformed"` = present but corrupt (the caller treats this as OFF).
 */
export function readBreakerState(basePath: string): CanaryBreakerState | "malformed" | null {
  const p = breakerPath(basePath);
  if (!existsSync(p)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(p, "utf8"));
    return isValidState(raw) ? raw : "malformed";
  } catch {
    return "malformed";
  }
}

/**
 * The hot-path snapshot. Cheap (one small file read), fail-safe:
 *   • absent      → not tripped (canary never exposed; the config gate decides).
 *   • malformed   → TRIPPED (fail off — never serve over a corrupt breaker).
 *   • present     → its latched tripped + reasons.
 */
export function readBreakerSnapshot(basePath: string): CanaryBreakerSnapshot {
  const state = readBreakerState(basePath);
  if (state === null) return { tripped: false, reasons: [] };
  if (state === "malformed") return { tripped: true, reasons: ["malformed_state"] };
  return { tripped: state.tripped, reasons: state.reasons };
}

/** Derive bounded health counters from a canary-relevant event window. Pure over `events`. */
export function deriveCountersFromEvents(events: readonly AnalyticsEvent[]): CanaryHealthCounters {
  const { trials, diagnostics } = joinApplicabilityTrials(events, { featureVersion: APPLICABILITY_FEATURE_VERSION });
  const c = emptyHealthCounters();
  c.trials = trials.length;
  c.crossRun = diagnostics.crossRun;
  c.ambiguous = diagnostics.ambiguous;
  for (const t of trials) {
    if (Number.isFinite(t.latencyMs)) pushLatencySample(c.railLatencyMs, t.latencyMs);
    if (t.canary?.arm === "treatment") {
      c.treatmentExposed++;
      if (t.observability === "observed_exposed") {
        c.treatmentObservedOutcomes++;
        if (t.label === "helpful") c.treatmentHelpful++;
        else if (t.label === "harmful") c.treatmentHarmful++;
      }
    } else if (t.canary?.arm === "control") {
      c.controlExposed++;
    }
  }
  // Privacy tripwire — reuse the shared leakage scanner over the canary stream.
  const serialized = JSON.stringify(events.filter((e) => e.event.startsWith("reasoning.applicability") || e.event === "injection"));
  if (detectLeakageExtended(serialized) !== null) c.privacyViolations++;
  return c;
}

/**
 * Re-derive health from a BOUNDED canary-only ledger window, re-evaluate the
 * frozen rules, and latch. Monotonic: a tripped breaker never un-trips here
 * (only `resetBreaker` clears it). Honors the reset watermark so a reviewed reset
 * doesn't instantly re-trip on the pre-reset rows. Atomic write. Best-effort:
 * callers wrap in try/catch — a breaker refresh must never break serving.
 */
export function refreshBreaker(basePath: string, store: BlockStore, nowMs: number = Date.now()): CanaryBreakerState {
  const existing = readBreakerState(basePath);
  const prev = existing === "malformed" ? null : existing;
  const resetAtMs = prev?.resetAtMs ?? null;
  const afterTs = Math.max(nowMs - BREAKER_WINDOW_MS, resetAtMs ?? 0);

  const events = store.readEvents({ afterTs, eventType: CANARY_EVENT_TYPES, limit: BREAKER_EVENT_LIMIT });
  const counters = deriveCountersFromEvents(events);
  const verdict = evaluateCanaryHealth(counters);

  const wasTripped = prev?.tripped ?? false;
  const tripped = wasTripped || verdict.tripped;
  const state: CanaryBreakerState = {
    version: CANARY_BREAKER_VERSION,
    tripped,
    reasons: wasTripped ? prev!.reasons : verdict.tripped ? verdict.reasons : [],
    trippedAtMs: wasTripped ? prev!.trippedAtMs : verdict.tripped ? nowMs : null,
    resetAtMs,
    counters,
    lastVerdict: verdict,
    updatedAtMs: nowMs,
  };
  writeStateAtomic(basePath, state);
  return state;
}

/**
 * Explicit reviewed reset — clears the latch and stamps a watermark so a
 * subsequent refresh ignores the pre-reset events that tripped it. The ONLY way
 * a tripped breaker returns to service. (The CLI guards this behind an --ack.)
 */
export function resetBreaker(basePath: string, nowMs: number = Date.now()): CanaryBreakerState {
  const verdict = evaluateCanaryHealth(emptyHealthCounters());
  const state: CanaryBreakerState = {
    version: CANARY_BREAKER_VERSION,
    tripped: false,
    reasons: [],
    trippedAtMs: null,
    resetAtMs: nowMs,
    counters: emptyHealthCounters(),
    lastVerdict: verdict,
    updatedAtMs: nowMs,
  };
  writeStateAtomic(basePath, state);
  return state;
}

/**
 * Ingestion trigger gated to the canary-active case: refresh only when a breaker
 * state file already exists (i.e. the canary has exposed at least once). When the
 * canary is OFF the file is absent, so an outcome on an unrelated task is a single
 * cheap `existsSync` and no write. Best-effort; never throws.
 */
export function noteCanaryActivityIfActive(basePath: string, store: BlockStore, nowMs: number = Date.now()): void {
  try {
    if (!existsSync(breakerPath(basePath))) return;
    refreshBreaker(basePath, store, nowMs);
  } catch {
    // A breaker refresh must never break the outcome-recording surface.
  }
}

/**
 * EXPOSURE-side ingestion (E.2.1 safety fix). A canary EXPOSURE ALWAYS refreshes —
 * unconditionally — so the FIRST exposure atomically initialises the breaker state
 * and monitoring begins from exposure #1. Load-bearing: previously EVERY ingestion
 * path was gated by `existsSync`, so the first exposure never created state and the
 * breaker could never trip — the canary served unguarded. Outcome-side ingestion
 * stays gated (cheap no-op until a state exists). Best-effort; never throws.
 */
export function noteCanaryExposure(basePath: string, store: BlockStore, nowMs: number = Date.now()): void {
  try {
    refreshBreaker(basePath, store, nowMs);
  } catch {
    // A breaker refresh must never break serving.
  }
}

/** The runtime serving heartbeat — `lastExposureMs` advances ONLY on a confirmed,
 *  durably-admitted treatment exposure (see admitCanaryExposure). */
export interface CanaryRuntimeReceipt {
  version: typeof CANARY_RUNTIME_RECEIPT_VERSION;
  /** Wall-clock (ms) of the most recent confirmed, durably-admitted treatment exposure. */
  lastExposureMs: number;
  applicabilityFeatureVersion: number;
}

function runtimeReceiptPath(basePath: string): string {
  return join(basePath, ".tracebase", CANARY_RUNTIME_RECEIPT_FILE);
}

/**
 * Stamp the runtime serving heartbeat atomically (temp + rename). BEST-EFFORT and
 * observability-only: a failed receipt write must NEVER gate serving — it only makes
 * the effective status UNDER-report (ARMED instead of LIVE_CONFIRMED), never over-report.
 */
function writeRuntimeReceipt(basePath: string, nowMs: number, featureVersion: number): void {
  const p = runtimeReceiptPath(basePath);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  const receipt: CanaryRuntimeReceipt = { version: CANARY_RUNTIME_RECEIPT_VERSION, lastExposureMs: nowMs, applicabilityFeatureVersion: featureVersion };
  writeFileSync(tmp, JSON.stringify(receipt, null, 2) + "\n");
  renameSync(tmp, p);
}

/** Read the runtime receipt; null if absent OR malformed (either way → not live). */
export function readRuntimeReceipt(basePath: string): CanaryRuntimeReceipt | null {
  const p = runtimeReceiptPath(basePath);
  if (!existsSync(p)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(p, "utf8"));
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Partial<CanaryRuntimeReceipt>;
    if (r.version !== CANARY_RUNTIME_RECEIPT_VERSION || typeof r.lastExposureMs !== "number" || !Number.isFinite(r.lastExposureMs)) return null;
    return r as CanaryRuntimeReceipt;
  } catch {
    return null;
  }
}

/**
 * ADMISSION (E.2.2 fail-off + E.2.3 heartbeat). Durably init/refresh the breaker
 * state and report whether persistence SUCCEEDED. The caller serves a TREATMENT
 * only when this returns true — if the breaker state cannot be written durably
 * (FS / SQLite failure) it returns FALSE and the caller fails OFF (downgrades to
 * control, never injects). The failure is NOT silently swallowed — it is surfaced
 * as a false return the admission gate acts on. On durable success it also stamps
 * the runtime serving receipt (best-effort), which is the bounded-freshness
 * heartbeat the effective status reads as LIVE_CONFIRMED.
 */
export function admitCanaryExposure(basePath: string, store: BlockStore, nowMs: number = Date.now()): boolean {
  try {
    const state = refreshBreaker(basePath, store, nowMs); // atomic write; throws on FS/SQLite failure
    // Durability proof: the state file must be present + parseable after the write.
    const durable = readBreakerState(basePath) !== "malformed" && state.version === CANARY_BREAKER_VERSION;
    if (!durable) return false;
    // Confirmed admission → stamp the runtime heartbeat. Best-effort: never gates serving.
    try {
      writeRuntimeReceipt(basePath, nowMs, APPLICABILITY_FEATURE_VERSION);
    } catch {
      /* observability under-reports (ARMED) but serving proceeds — safe direction. */
    }
    return true;
  } catch {
    return false;
  }
}

/** The distinct canary states the CLI/doctor surface (E.2.2: ARMED vs LIVE_CONFIRMED). */
export type CanaryEffectiveStatus = "ARMED" | "LIVE_CONFIRMED" | "INERT" | "TRIPPED";

/**
 * Combine persisted config + env kills + breaker snapshot + the bounded-freshness
 * runtime receipt into ONE effective status, shared by `canary status|health` and
 * `doctor` so they never disagree. HONEST observability (E.2.3): "enabled config"
 * alone is NOT "live", and a HISTORICAL breaker file is NOT a live heartbeat. Only a
 * runtime receipt whose `lastExposureMs` is within LIVE_HEARTBEAT_FRESHNESS_MS counts
 * as LIVE_CONFIRMED.
 *   • TRIPPED        — breaker latched (or malformed state → fail-off).
 *   • INERT          — configured-off / env-killed.
 *   • LIVE_CONFIRMED — enabled + clear + a FRESH runtime receipt (the serving runtime
 *                      admitted an exposure within the freshness window → serving NOW).
 *   • ARMED          — enabled + clear but NO fresh receipt (never exposed, OR the last
 *                      confirmed exposure is stale → configured but serving unconfirmed).
 * `heartbeatMs` is the receipt's lastExposureMs when present (fresh or stale), so a
 * caller can report the age; `stale` is true when a receipt exists but is past the window.
 */
export function canaryEffectiveStatus(
  basePath: string,
  env: NodeJS.ProcessEnv = process.env,
  nowMs: number = Date.now(),
): { status: CanaryEffectiveStatus; snapshot: CanaryBreakerSnapshot; killReason?: string; heartbeatMs?: number; stale?: boolean } {
  const snapshot = readBreakerSnapshot(basePath);
  if (snapshot.tripped) return { status: "TRIPPED", snapshot, killReason: `breaker_tripped:${snapshot.reasons.join(",") || "latched"}` };
  const serving = resolveCanaryServingState(readApplicabilityCanaryConfig(basePath), env);
  if (serving.killReason) return { status: "INERT", snapshot, killReason: serving.killReason };
  if (!serving.enabled) return { status: "INERT", snapshot };
  // enabled + not killed + not tripped → LIVE_CONFIRMED only with a FRESH runtime
  // receipt. A historical/stale receipt — or none — is ARMED (serving unconfirmed now).
  const receipt = readRuntimeReceipt(basePath);
  if (receipt) {
    const fresh = nowMs - receipt.lastExposureMs <= LIVE_HEARTBEAT_FRESHNESS_MS;
    if (fresh) return { status: "LIVE_CONFIRMED", snapshot, heartbeatMs: receipt.lastExposureMs };
    return { status: "ARMED", snapshot, heartbeatMs: receipt.lastExposureMs, stale: true };
  }
  return { status: "ARMED", snapshot };
}
