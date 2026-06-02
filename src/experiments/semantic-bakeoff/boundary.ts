/**
 * The bakeoff boundary: run a probe through a provider with a STRICT deadline and
 * a fail-open fallback to the deterministic baseline. Pure orchestration — the
 * only effects are the providers' own (which are local + deterministic here).
 *
 * Fail-open is total: a timeout, a `null`, a throw, or a blocked remote provider
 * all fall back to the deterministic baseline, with a closed reason recorded.
 */
import {
  DeterministicApplicabilityReranker,
  type ApplicabilityProvider,
  type ApplicabilityContext,
  type ApplicabilityResult,
} from "../../core/applicability-reranker.js";
import { detectLeakageExtended } from "../../core/guard.js";
import type { BakeoffProvider, BakeoffProbeDTO, BakeoffOutcome, BakeoffFallbackReason, RunBakeoffOptions, BakeoffRun } from "./types.js";

/** Mirrors the frozen pre-reg rail-latency budget (§7.4: p95 ≤ 50ms). */
export const DEFAULT_BAKEOFF_DEADLINE_MS = 50;

const TIMEOUT = Symbol("bakeoff-timeout");

/** Race a promise against a hard wall-clock deadline. Never leaks the timer. */
async function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Scan a probe DTO for leakage with the SHARED scanner (abs-paths + secrets +
 * env-lines). Returns the matched pattern name, or null when clean. The harness
 * drops any DTO that matches BEFORE a provider sees it — scanned DTOs only.
 */
export function scanProbeDTO(dto: BakeoffProbeDTO): string | null {
  const blob = JSON.stringify({
    q: [dto.query.literalText, dto.query.causalText ?? ""],
    c: dto.candidates.map((c) => [c.tokens.situation, c.tokens.mechanism, c.tokens.unlock, c.tokens.invariants]),
  });
  return detectLeakageExtended(blob);
}

async function fallbackOutcome(
  base: { probeId: string; manifestId: string },
  dto: BakeoffProbeDTO,
  fallback: ApplicabilityProvider,
  now: () => number,
  t0: number,
  reason: BakeoffFallbackReason,
): Promise<BakeoffOutcome> {
  let results: ApplicabilityResult[] | null = null;
  try {
    results = await fallback.rank(dto.query, dto.candidates, { deadlineMs: DEFAULT_BAKEOFF_DEADLINE_MS, now });
  } catch {
    results = null; // even the fallback failed → results null (totally fail-open).
  }
  return { ...base, providerName: fallback.name, featureVersion: fallback.featureVersion, results, latencyMs: now() - t0, usedFallback: true, fallbackReason: reason };
}

/** Run ONE probe through ONE provider, with a strict deadline + fail-open fallback. */
export async function runProbe(
  bp: BakeoffProvider,
  dto: BakeoffProbeDTO,
  fallback: ApplicabilityProvider,
  opts: RunBakeoffOptions = {},
): Promise<BakeoffOutcome> {
  const deadlineMs = opts.deadlineMs ?? DEFAULT_BAKEOFF_DEADLINE_MS;
  const now = opts.now ?? Date.now;
  const t0 = now();
  const base = { probeId: dto.probeId, manifestId: bp.manifestId };

  // No implicit network: a remote provider runs ONLY with explicit opt-in.
  if (bp.network === "remote-explicit" && !opts.allowRemote) {
    return fallbackOutcome(base, dto, fallback, now, t0, "network-blocked");
  }
  const ctx: ApplicabilityContext = { deadlineMs, now };
  try {
    const raced = await withDeadline(bp.provider.rank(dto.query, dto.candidates, ctx), deadlineMs);
    if (raced === TIMEOUT) return fallbackOutcome(base, dto, fallback, now, t0, "timeout");
    if (raced === null) return fallbackOutcome(base, dto, fallback, now, t0, "null");
    return { ...base, providerName: bp.provider.name, featureVersion: bp.provider.featureVersion, results: raced, latencyMs: now() - t0, usedFallback: false };
  } catch {
    return fallbackOutcome(base, dto, fallback, now, t0, "threw");
  }
}

/**
 * Run every provider over every scanned fixture. Deterministic given deterministic
 * providers + an injected clock. Leaky fixtures are dropped (recorded in
 * `rejected`) before any provider runs.
 */
export async function runBakeoff(
  providers: readonly BakeoffProvider[],
  dtos: readonly BakeoffProbeDTO[],
  opts: RunBakeoffOptions = {},
): Promise<BakeoffRun> {
  const fallback = opts.fallback ?? new DeterministicApplicabilityReranker();
  const outcomes: BakeoffOutcome[] = [];
  const rejected: { probeId: string; pattern: string }[] = [];
  for (const dto of dtos) {
    const leak = scanProbeDTO(dto);
    if (leak) {
      rejected.push({ probeId: dto.probeId, pattern: leak });
      continue;
    }
    for (const bp of providers) outcomes.push(await runProbe(bp, dto, fallback, opts));
  }
  return { outcomes, scanned: dtos.length - rejected.length, rejected };
}
