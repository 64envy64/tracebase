#!/usr/bin/env tsx
/**
 * Sanctioned capture-run driver (Phase 5) — enforces the locked pre-registration
 * (bench-runs/reasoning-reuse/CAPTURE-RUN-PRE-REGISTRATION.md) and the operator's
 * 7 load-bearing rules. Haiku-only, hard cap $30, runtime capture path only.
 *
 * It owns ONLY the orchestration + safety envelope; the actual agent trajectory
 * execution is delegated to the existing WSL run-trajectory harness (the same
 * one the file-memory pilot used), and capture happens via the runtime Stop-hook
 * path into the dogfood BlockStore. This file deliberately does NOT itself spawn
 * paid agents — it is the control plane that a thin per-trajectory runner calls,
 * so the rules are encoded once and tested.
 *
 * Rules encoded here (see runState()):
 *  1. Manifest frozen + hashed before the first paid trajectory.
 *  2. Capture/recall task sets disjoint (asserted on load).
 *  3. Only runtime-captured organic patterns with attributed outcomes count.
 *  4. Crash-safe progress persisted after every trajectory; resume on restart.
 *  5. Early health checkpoint after 10 capture + 10 recall trajectories.
 *  6. Halt on: privacy regression | repeated pipeline failure | 3 consecutive
 *     empties | manifest-fix-leak evidence | hard cap $30 | organic target.
 *  7. On end: run evaluatePrecision + emit the full report.
 */
import { createHash } from "node:crypto";

export const HARD_CAP_USD = 30;
export const ORGANIC_TARGET = { capturedRuntime: 50, precisionReady: 30 };
export const HEALTH_CHECKPOINT = { capture: 10, recall: 10 };
export const MAX_CONSECUTIVE_EMPTY = 3;

export interface CaptureTask {
  id: string;
  phase: "capture" | "recall";
  /** Opaque task reference (repo+commit / prompt id) — never a raw secret. */
  ref: string;
  /** Problem class, used to pair capture↔recall without sharing the fix. */
  problemClass: string;
}

export interface CaptureManifest {
  frozenAt: number;
  manifestHash: string;
  model: "claude-haiku-4-5";
  tasks: CaptureTask[];
}

export interface TrajRecord {
  taskId: string;
  phase: "capture" | "recall";
  costUsd: number;
  tokens: number;
  exitCode: number;
  /** capture: blockId|null; recall: injected blockId|null. */
  blockId: string | null;
  attributedResolved: boolean;
  empty: boolean; // tokens==0 && cost==0 && exit!=0
}

export type HaltReason =
  | "organic-target"
  | "hard-cap"
  | "consecutive-empty"
  | "privacy-regression"
  | "pipeline-failure"
  | "manifest-leak"
  | null;

/** Freeze + hash a manifest. Disjointness (rule 2) is asserted here. */
export function freezeManifest(tasks: CaptureTask[], frozenAt: number): CaptureManifest {
  const capture = new Set(tasks.filter((t) => t.phase === "capture").map((t) => t.ref));
  const recall = tasks.filter((t) => t.phase === "recall");
  for (const r of recall) {
    if (capture.has(r.ref)) {
      throw new Error(`manifest not disjoint: recall task ${r.id} reuses capture ref ${r.ref}`);
    }
  }
  const canonical = JSON.stringify(tasks.map((t) => [t.id, t.phase, t.ref, t.problemClass]));
  const manifestHash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  return { frozenAt, manifestHash, model: "claude-haiku-4-5", tasks };
}

/**
 * Pure decision function over accumulated records — what the driver loop checks
 * after every trajectory. Returns the halt reason (or null to continue) plus the
 * health-checkpoint verdict. No I/O; fully testable.
 */
export function runState(
  records: TrajRecord[],
  signals: { privacyRegression?: boolean; manifestLeak?: boolean; pipelineFailures?: number },
): { halt: HaltReason; spendUsd: number; organic: { capturedRuntime: number; precisionReady: number }; healthDue: boolean; consecutiveEmpty: number } {
  const spendUsd = records.reduce((a, r) => a + (r.costUsd || 0), 0);
  const capturedRuntime = records.filter((r) => r.phase === "capture" && r.blockId && !r.empty).length;
  const precisionReady = records.filter((r) => r.phase === "recall" && r.blockId && r.attributedResolved).length;

  let consecutiveEmpty = 0;
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i]!.empty) consecutiveEmpty++;
    else break;
  }

  const captureDone = records.filter((r) => r.phase === "capture" && !r.empty).length;
  const recallDone = records.filter((r) => r.phase === "recall" && !r.empty).length;
  const healthDue = captureDone === HEALTH_CHECKPOINT.capture && recallDone === HEALTH_CHECKPOINT.recall;

  let halt: HaltReason = null;
  if (signals.privacyRegression) halt = "privacy-regression";
  else if (signals.manifestLeak) halt = "manifest-leak";
  else if ((signals.pipelineFailures ?? 0) >= 3) halt = "pipeline-failure";
  else if (consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY) halt = "consecutive-empty";
  else if (spendUsd >= HARD_CAP_USD) halt = "hard-cap";
  else if (capturedRuntime >= ORGANIC_TARGET.capturedRuntime && precisionReady >= ORGANIC_TARGET.precisionReady) {
    halt = "organic-target";
  }

  return { halt, spendUsd, organic: { capturedRuntime, precisionReady }, healthDue, consecutiveEmpty };
}
