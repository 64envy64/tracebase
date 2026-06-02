/**
 * Auditable semantic-calibration dataset registry.
 *
 * Rows are frozen BEFORE scoring. The registry is content-addressed, privacy
 * scanned, family-keyed and intentionally provider-neutral. A calibration model
 * sees bounded query views + bounded candidate tokens only; labels/provenance stay
 * local in the evaluator.
 */
import { createHash } from "node:crypto";
import { detectLeakageExtended } from "../../../core/guard.js";
import type { ApplicabilityCandidate, ApplicabilityQueryViews } from "../../../core/applicability-reranker.js";

export const CALIBRATION_DATASET_VERSION = 1 as const;
export type CalibrationDatasetKind = "organic-calibration" | "fixture-smoke";
export type CalibrationLabel = "applicable" | "inapplicable";

export interface CalibrationProvenance {
  sourceType: "runtime" | "import" | "fixture";
  sourceRef: string;
  capturedAt?: number;
}

export interface CalibrationDatasetRow {
  rowId: string;
  familyKey: string;
  query: ApplicabilityQueryViews;
  candidate: ApplicabilityCandidate;
  label: CalibrationLabel;
  /** Near-miss negative: vocabulary overlaps, mechanism does not apply. */
  hardNegative: boolean;
  /** Viability regression only. These rows are never eligible for fitting. */
  adversarialFixture?: boolean;
  provenance: CalibrationProvenance;
}

export interface CalibrationDatasetRegistry {
  datasetVersion: typeof CALIBRATION_DATASET_VERSION;
  kind: CalibrationDatasetKind;
  frozenAt: string;
  rows: CalibrationDatasetRow[];
}

const MAX_TOKEN_COUNT = 64;
const MAX_TOKEN_CHARS = 256;
const TOKEN_FIELDS = ["situation", "mechanism", "unlock", "invariants"] as const;
const SIGNAL_FIELDS = ["helpful", "harmful", "unresolved", "familySupport", "sourceDiversity"] as const;

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxChars: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxChars;
}

function validateCandidate(rowRef: string, candidate: unknown, violations: string[]): void {
  if (!isRecord(candidate)) {
    violations.push(`row ${rowRef}: candidate must be an object`);
    return;
  }
  if (!isBoundedString(candidate.blockId, 256)) violations.push(`row ${rowRef}: blockId must be 1..256 chars`);
  if (!isRecord(candidate.tokens)) {
    violations.push(`row ${rowRef}: candidate.tokens must be an object`);
  } else {
    for (const field of TOKEN_FIELDS) {
      const tokens = candidate.tokens[field];
      if (!Array.isArray(tokens) || tokens.length > MAX_TOKEN_COUNT) {
        violations.push(`row ${rowRef}: candidate.tokens.${field} must be an array with <=${MAX_TOKEN_COUNT} entries`);
        continue;
      }
      if (tokens.some((token) => !isBoundedString(token, MAX_TOKEN_CHARS))) {
        violations.push(`row ${rowRef}: candidate.tokens.${field} entries must be 1..${MAX_TOKEN_CHARS} chars`);
      }
    }
  }
  if (!isRecord(candidate.signals)) {
    violations.push(`row ${rowRef}: candidate.signals must be an object`);
  } else {
    if (typeof candidate.signals.isPitfall !== "boolean") {
      violations.push(`row ${rowRef}: candidate.signals.isPitfall must be boolean`);
    }
    for (const field of SIGNAL_FIELDS) {
      const signal = candidate.signals[field];
      if (!Number.isInteger(signal) || (signal as number) < 0) {
        violations.push(`row ${rowRef}: candidate.signals.${field} must be a non-negative integer`);
      }
    }
  }
}

function validateQuery(rowRef: string, query: unknown, violations: string[]): void {
  if (!isRecord(query)) {
    violations.push(`row ${rowRef}: query must be an object`);
    return;
  }
  if (!isBoundedString(query.literalText, 8_000)) violations.push(`row ${rowRef}: query.literalText must be 1..8000 chars`);
  if (query.causalText !== undefined && (typeof query.causalText !== "string" || query.causalText.length > 8_000)) {
    violations.push(`row ${rowRef}: query.causalText must be <=8000 chars`);
  }
}

function validateProvenance(rowRef: string, provenance: unknown, violations: string[]): void {
  if (!isRecord(provenance)) {
    violations.push(`row ${rowRef}: provenance must be an object`);
    return;
  }
  if (!["runtime", "import", "fixture"].includes(String(provenance.sourceType)) || !isBoundedString(provenance.sourceRef, 512)) {
    violations.push(`row ${rowRef}: invalid provenance`);
  }
  if (provenance.capturedAt !== undefined && (!Number.isFinite(provenance.capturedAt) || (provenance.capturedAt as number) < 0)) {
    violations.push(`row ${rowRef}: provenance.capturedAt must be >= 0`);
  }
}

function canonicalRows(rows: readonly CalibrationDatasetRow[]): CalibrationDatasetRow[] {
  return [...rows].sort((a, b) => a.rowId.localeCompare(b.rowId));
}

/** Full row-content hash: examples, labels, family assignments and provenance. */
export function datasetHashOf(registry: CalibrationDatasetRegistry): string {
  return hashJson([registry.datasetVersion, registry.kind, registry.frozenAt, canonicalRows(registry.rows)]);
}

/** Separate provenance hash for audit diffs without inspecting example text. */
export function provenanceHashOf(registry: CalibrationDatasetRegistry): string {
  return hashJson(canonicalRows(registry.rows).map((r) => [r.rowId, r.familyKey, r.provenance]));
}

/** Conservative local validator. Returns every detectable violation and never throws. */
export function validateCalibrationRegistry(registry: unknown): { ok: boolean; violations: string[] } {
  const v: string[] = [];
  if (!isRecord(registry)) return { ok: false, violations: ["registry must be an object"] };
  if (registry.datasetVersion !== CALIBRATION_DATASET_VERSION) v.push(`datasetVersion must be ${CALIBRATION_DATASET_VERSION}`);
  if (!["organic-calibration", "fixture-smoke"].includes(String(registry.kind))) v.push("kind must be organic-calibration or fixture-smoke");
  if (typeof registry.frozenAt !== "string" || !registry.frozenAt || Number.isNaN(Date.parse(registry.frozenAt))) v.push("frozenAt must be an ISO timestamp");
  if (!Array.isArray(registry.rows)) {
    v.push("rows must be an array");
    return { ok: false, violations: v };
  }
  if (registry.rows.length === 0) v.push("rows is empty");
  const ids = new Set<string>();
  for (const [index, row] of registry.rows.entries()) {
    if (!isRecord(row)) {
      v.push(`row ${index}: must be an object`);
      continue;
    }
    const rowRef = isBoundedString(row.rowId, 128) ? row.rowId : `#${index}`;
    if (!isBoundedString(row.rowId, 128)) v.push("rowId must be non-empty and <=128 chars");
    else if (ids.has(row.rowId)) v.push(`duplicate rowId: ${row.rowId}`);
    else ids.add(row.rowId);
    if (!isBoundedString(row.familyKey, 128)) v.push(`row ${rowRef}: familyKey must be non-empty and <=128 chars`);
    validateQuery(rowRef, row.query, v);
    validateCandidate(rowRef, row.candidate, v);
    if (!["applicable", "inapplicable"].includes(String(row.label))) v.push(`row ${rowRef}: invalid label`);
    if (typeof row.hardNegative !== "boolean") v.push(`row ${rowRef}: hardNegative must be boolean`);
    if (row.hardNegative === true && row.label !== "inapplicable") v.push(`row ${rowRef}: hardNegative must be labeled inapplicable`);
    if (row.adversarialFixture !== undefined && typeof row.adversarialFixture !== "boolean") {
      v.push(`row ${rowRef}: adversarialFixture must be boolean`);
    }
    validateProvenance(rowRef, row.provenance, v);
    if (row.adversarialFixture === true && (!isRecord(row.provenance) || row.provenance.sourceType !== "fixture")) {
      v.push(`row ${rowRef}: adversarialFixture must use fixture provenance`);
    }
    try {
      const leak = detectLeakageExtended(JSON.stringify(row));
      if (leak) v.push(`row ${rowRef}: leakage detected (${leak})`);
    } catch {
      v.push(`row ${rowRef}: must be JSON-serializable`);
    }
  }
  return { ok: v.length === 0, violations: v };
}
