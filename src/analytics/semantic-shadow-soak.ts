/**
 * E.2.8 semantic shadow soak gate.
 *
 * Combines local shadow-comparison telemetry with the explicit sidecar doctor
 * into one conservative, privacy-scanned readiness verdict. This module is pure:
 * it never calls the sidecar, reads no payload cache, and cannot promote semantic
 * verdicts into serving.
 */
import { detectLeakageExtended } from "../core/guard.js";
import type { HealthDTO } from "../experiments/semantic-bakeoff/service/protocol.js";
import type { SemanticShadowDoctorReport } from "../experiments/semantic-bakeoff/service/doctor.js";
import type { SemanticShadowReport } from "./semantic-shadow-report.js";

export interface SemanticShadowSoakThresholds {
  minTraffic: number;
  minV4Abstain: number;
  minSemanticResidualRecovery: number;
  minWarmCompletions: number;
  maxLatencyP95Ms: number;
  maxWarmLatencyP95Ms: number;
  maxWarmQueuePending: number;
  maxProviderTimeouts: number;
  maxProviderErrors: number;
  maxClientScannerBlocked: number;
  maxClientAttestationRejected: number;
  maxClientWarmErrors: number;
  maxClientWarmAborted: number;
  maxClientWarmingSuppressed: number;
  maxSidecarRejectedAuth: number;
  maxSidecarRejectedLeak: number;
  maxSidecarRejectedMalformed: number;
  maxSidecarRejectedTooLarge: number;
  maxSidecarRejectedExpired: number;
  maxSidecarQuotaExceeded: number;
  maxSidecarTimeouts: number;
  maxSidecarOverloads: number;
  maxSidecarBackendErrors: number;
  allowUnpinnedDevMode: boolean;
}

export const DEFAULT_SEMANTIC_SHADOW_SOAK_THRESHOLDS: SemanticShadowSoakThresholds = {
  minTraffic: 100,
  minV4Abstain: 20,
  minSemanticResidualRecovery: 1,
  minWarmCompletions: 1,
  maxLatencyP95Ms: 50,
  maxWarmLatencyP95Ms: 2_000,
  maxWarmQueuePending: 0,
  maxProviderTimeouts: 0,
  maxProviderErrors: 0,
  maxClientScannerBlocked: 0,
  maxClientAttestationRejected: 0,
  maxClientWarmErrors: 0,
  maxClientWarmAborted: 0,
  maxClientWarmingSuppressed: 0,
  maxSidecarRejectedAuth: 0,
  maxSidecarRejectedLeak: 0,
  maxSidecarRejectedMalformed: 0,
  maxSidecarRejectedTooLarge: 0,
  maxSidecarRejectedExpired: 0,
  maxSidecarQuotaExceeded: 0,
  maxSidecarTimeouts: 0,
  maxSidecarOverloads: 0,
  maxSidecarBackendErrors: 0,
  allowUnpinnedDevMode: false,
};

export type SemanticShadowSoakVerdict = "ready" | "not-ready";

export interface SemanticShadowSoakCheck {
  name: string;
  status: "pass" | "fail";
  observed: unknown;
  threshold?: unknown;
  blocker?: string;
}

export interface SemanticShadowSoakReport {
  verdict: SemanticShadowSoakVerdict;
  generatedAt: string;
  shadowOnly: true;
  servingPromoted: false;
  thresholds: SemanticShadowSoakThresholds;
  doctor: SemanticShadowDoctorReport;
  shadow: SemanticShadowReport;
  checks: SemanticShadowSoakCheck[];
  blockers: string[];
  privacyTelemetrySafe: boolean;
}

interface EvaluateOptions {
  thresholds?: Partial<SemanticShadowSoakThresholds>;
  now?: () => Date;
}

function mergeThresholds(
  thresholds?: Partial<SemanticShadowSoakThresholds>,
): SemanticShadowSoakThresholds {
  return { ...DEFAULT_SEMANTIC_SHADOW_SOAK_THRESHOLDS, ...(thresholds ?? {}) };
}

function readyDoctor(
  doctor: SemanticShadowDoctorReport,
): Extract<SemanticShadowDoctorReport, { status: "ready" }> | null {
  return doctor.status === "ready" ? doctor : null;
}

function telemetryOf(doctor: SemanticShadowDoctorReport): HealthDTO["telemetry"] | null {
  return readyDoctor(doctor)?.telemetry ?? null;
}

function numericHealth(
  health: SemanticShadowReport["latestHealth"],
  field: keyof NonNullable<SemanticShadowReport["latestHealth"]>,
): number {
  const value = health?.[field];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function addCheck(
  checks: SemanticShadowSoakCheck[],
  name: string,
  pass: boolean,
  observed: unknown,
  threshold: unknown,
  blocker: string,
): void {
  checks.push({
    name,
    status: pass ? "pass" : "fail",
    observed,
    threshold,
    ...(pass ? {} : { blocker }),
  });
}

function addStatusCheck(
  checks: SemanticShadowSoakCheck[],
  name: string,
  pass: boolean,
  observed: unknown,
  blocker: string,
): void {
  checks.push({
    name,
    status: pass ? "pass" : "fail",
    observed,
    ...(pass ? {} : { blocker }),
  });
}

function collectBlockers(checks: readonly SemanticShadowSoakCheck[]): string[] {
  return checks
    .filter((check) => check.status === "fail" && check.blocker)
    .map((check) => check.blocker!)
    .sort();
}

export function evaluateSemanticShadowSoak(
  input: { doctor: SemanticShadowDoctorReport; shadow: SemanticShadowReport },
  opts: EvaluateOptions = {},
): SemanticShadowSoakReport {
  const thresholds = mergeThresholds(opts.thresholds);
  const checks: SemanticShadowSoakCheck[] = [];
  const doctor = input.doctor;
  const shadow = input.shadow;
  const ready = readyDoctor(doctor);
  const sidecarTelemetry = telemetryOf(doctor);

  addStatusCheck(
    checks,
    "sidecar-ready",
    doctor.status === "ready",
    doctor.status,
    `semantic sidecar doctor is ${doctor.status}`,
  );
  if (ready) {
    addStatusCheck(
      checks,
      "sidecar-pinned-attestation",
      thresholds.allowUnpinnedDevMode || ready.unpinnedDevMode === false,
      { unpinnedDevMode: ready.unpinnedDevMode, attestationId: ready.attestationId },
      "semantic sidecar is running without pinned attestation",
    );
    addCheck(
      checks,
      "sidecar-in-flight",
      ready.inFlight === 0,
      ready.inFlight,
      0,
      "semantic sidecar still has in-flight work at sample time",
    );
  }

  addCheck(checks, "traffic", shadow.traffic >= thresholds.minTraffic, shadow.traffic, thresholds.minTraffic, "semantic shadow traffic below soak floor");
  addCheck(checks, "v4-abstain-coverage", shadow.baseline.abstain >= thresholds.minV4Abstain, shadow.baseline.abstain, thresholds.minV4Abstain, "not enough V4-abstain residual coverage");
  addCheck(checks, "residual-recovery", shadow.residual.semanticApplicable >= thresholds.minSemanticResidualRecovery, shadow.residual.semanticApplicable, thresholds.minSemanticResidualRecovery, "no semantic residual recovery observed");
  addCheck(checks, "latency-p95", shadow.latencyMs.p95 <= thresholds.maxLatencyP95Ms, shadow.latencyMs.p95, thresholds.maxLatencyP95Ms, "semantic shadow p95 latency above budget");

  addCheck(checks, "fallback-timeouts", shadow.fallback.timeout <= thresholds.maxProviderTimeouts, shadow.fallback.timeout, thresholds.maxProviderTimeouts, "semantic provider timeout observed");
  addCheck(checks, "fallback-errors", shadow.fallback.error <= thresholds.maxProviderErrors, shadow.fallback.error, thresholds.maxProviderErrors, "semantic provider error observed");

  addCheck(checks, "client-scanner-blocked", shadow.observedHealthMax.scannerBlocked <= thresholds.maxClientScannerBlocked, shadow.observedHealthMax.scannerBlocked, thresholds.maxClientScannerBlocked, "client-side semantic scanner blocked a payload");
  addCheck(checks, "client-attestation-rejected", shadow.observedHealthMax.attestationRejected <= thresholds.maxClientAttestationRejected, shadow.observedHealthMax.attestationRejected, thresholds.maxClientAttestationRejected, "client-side semantic attestation rejection observed");

  const health = shadow.latestHealth;
  addCheck(checks, "warm-completions", numericHealth(health, "warmsCompleted") >= thresholds.minWarmCompletions, numericHealth(health, "warmsCompleted"), thresholds.minWarmCompletions, "semantic warm cache has not completed a warm");
  addCheck(checks, "warm-errors", numericHealth(health, "warmErrors") <= thresholds.maxClientWarmErrors, numericHealth(health, "warmErrors"), thresholds.maxClientWarmErrors, "semantic warm errors observed");
  addCheck(checks, "warm-aborted", numericHealth(health, "warmAborted") <= thresholds.maxClientWarmAborted, numericHealth(health, "warmAborted"), thresholds.maxClientWarmAborted, "semantic warm aborts observed");
  addCheck(checks, "warming-suppressed", numericHealth(health, "warmingSuppressed") <= thresholds.maxClientWarmingSuppressed, numericHealth(health, "warmingSuppressed"), thresholds.maxClientWarmingSuppressed, "semantic warming was suppressed during soak");
  addCheck(checks, "warm-latency-p95", numericHealth(health, "warmLatencyP95Ms") <= thresholds.maxWarmLatencyP95Ms, numericHealth(health, "warmLatencyP95Ms"), thresholds.maxWarmLatencyP95Ms, "semantic warm p95 latency above budget");

  const warmQueue = shadow.latestWarmQueue;
  addCheck(checks, "warm-queue-pending", (warmQueue?.pending ?? 0) <= thresholds.maxWarmQueuePending, warmQueue?.pending ?? 0, thresholds.maxWarmQueuePending, "semantic warm queue has pending work");
  addStatusCheck(checks, "warm-queue-accepting", warmQueue?.accepting !== false, warmQueue ? { accepting: warmQueue.accepting } : null, "semantic warm queue stopped accepting work");

  const attestationIds = shadow.attestationIds;
  addStatusCheck(checks, "single-attestation", attestationIds.length === 1, attestationIds, "semantic shadow observed zero or multiple attestations");
  if (ready && attestationIds.length > 0) {
    addStatusCheck(
      checks,
      "attestation-matches-doctor",
      attestationIds.length === 1 && attestationIds[0] === ready.attestationId,
      { observed: attestationIds, doctor: ready.attestationId },
      "semantic shadow attestation differs from sidecar doctor",
    );
  }

  if (sidecarTelemetry) {
    addCheck(checks, "sidecar-rejected-auth", sidecarTelemetry.rejectedAuth <= thresholds.maxSidecarRejectedAuth, sidecarTelemetry.rejectedAuth, thresholds.maxSidecarRejectedAuth, "sidecar auth rejection observed");
    addCheck(checks, "sidecar-rejected-leak", sidecarTelemetry.rejectedLeak <= thresholds.maxSidecarRejectedLeak, sidecarTelemetry.rejectedLeak, thresholds.maxSidecarRejectedLeak, "sidecar leakage rejection observed");
    addCheck(checks, "sidecar-rejected-malformed", sidecarTelemetry.rejectedMalformed <= thresholds.maxSidecarRejectedMalformed, sidecarTelemetry.rejectedMalformed, thresholds.maxSidecarRejectedMalformed, "sidecar malformed request observed");
    addCheck(checks, "sidecar-rejected-too-large", sidecarTelemetry.rejectedTooLarge <= thresholds.maxSidecarRejectedTooLarge, sidecarTelemetry.rejectedTooLarge, thresholds.maxSidecarRejectedTooLarge, "sidecar payload-too-large rejection observed");
    addCheck(checks, "sidecar-rejected-expired", sidecarTelemetry.rejectedExpired <= thresholds.maxSidecarRejectedExpired, sidecarTelemetry.rejectedExpired, thresholds.maxSidecarRejectedExpired, "sidecar expired request observed");
    addCheck(checks, "sidecar-quota", sidecarTelemetry.quotaExceeded <= thresholds.maxSidecarQuotaExceeded, sidecarTelemetry.quotaExceeded, thresholds.maxSidecarQuotaExceeded, "sidecar quota rejection observed");
    addCheck(checks, "sidecar-timeouts", sidecarTelemetry.timeouts <= thresholds.maxSidecarTimeouts, sidecarTelemetry.timeouts, thresholds.maxSidecarTimeouts, "sidecar backend timeout observed");
    addCheck(checks, "sidecar-overloads", sidecarTelemetry.overloads <= thresholds.maxSidecarOverloads, sidecarTelemetry.overloads, thresholds.maxSidecarOverloads, "sidecar overload observed");
    addCheck(checks, "sidecar-backend-errors", sidecarTelemetry.backendErrors <= thresholds.maxSidecarBackendErrors, sidecarTelemetry.backendErrors, thresholds.maxSidecarBackendErrors, "sidecar backend error observed");
  }

  addStatusCheck(checks, "shadow-only-serving", true, { shadowOnly: true, servingPromoted: false }, "semantic verdicts were promoted to serving");

  const reportWithoutPrivacy: Omit<SemanticShadowSoakReport, "privacyTelemetrySafe" | "verdict" | "blockers"> = {
    generatedAt: (opts.now ?? (() => new Date()))().toISOString(),
    shadowOnly: true,
    servingPromoted: false,
    thresholds,
    doctor,
    shadow,
    checks,
  };
  const privacyTelemetrySafe = detectLeakageExtended(JSON.stringify(reportWithoutPrivacy)) === null;
  checks.push({
    name: "telemetry-privacy-scan",
    status: privacyTelemetrySafe ? "pass" : "fail",
    observed: privacyTelemetrySafe ? "pass" : "blocked",
    ...(privacyTelemetrySafe ? {} : { blocker: "semantic soak report failed privacy scan" }),
  });

  const blockers = collectBlockers(checks);
  return {
    verdict: blockers.length === 0 ? "ready" : "not-ready",
    ...reportWithoutPrivacy,
    checks,
    blockers,
    privacyTelemetrySafe,
  };
}
