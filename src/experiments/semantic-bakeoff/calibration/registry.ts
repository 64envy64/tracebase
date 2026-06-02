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

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
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

/** Conservative local validator. Returns every violation and never throws. */
export function validateCalibrationRegistry(registry: CalibrationDatasetRegistry): { ok: boolean; violations: string[] } {
  const v: string[] = [];
  if (registry.datasetVersion !== CALIBRATION_DATASET_VERSION) v.push(`datasetVersion must be ${CALIBRATION_DATASET_VERSION}`);
  if (!["organic-calibration", "fixture-smoke"].includes(registry.kind)) v.push("kind must be organic-calibration or fixture-smoke");
  if (!registry.frozenAt || Number.isNaN(Date.parse(registry.frozenAt))) v.push("frozenAt must be an ISO timestamp");
  if (registry.rows.length === 0) v.push("rows is empty");
  const ids = new Set<string>();
  for (const row of registry.rows) {
    if (!row.rowId || row.rowId.length > 128) v.push("rowId must be non-empty and <=128 chars");
    if (ids.has(row.rowId)) v.push(`duplicate rowId: ${row.rowId}`);
    ids.add(row.rowId);
    if (!row.familyKey || row.familyKey.length > 128) v.push(`row ${row.rowId}: familyKey must be non-empty and <=128 chars`);
    if (!row.query.literalText || row.query.literalText.length > 8_000) v.push(`row ${row.rowId}: query.literalText must be 1..8000 chars`);
    if (row.query.causalText && row.query.causalText.length > 8_000) v.push(`row ${row.rowId}: query.causalText exceeds 8000 chars`);
    if (!row.candidate.blockId || row.candidate.blockId.length > 256) v.push(`row ${row.rowId}: blockId must be 1..256 chars`);
    if (!["applicable", "inapplicable"].includes(row.label)) v.push(`row ${row.rowId}: invalid label`);
    if (typeof row.hardNegative !== "boolean") v.push(`row ${row.rowId}: hardNegative must be boolean`);
    if (row.hardNegative && row.label !== "inapplicable") v.push(`row ${row.rowId}: hardNegative must be labeled inapplicable`);
    if (row.adversarialFixture && row.provenance.sourceType !== "fixture") v.push(`row ${row.rowId}: adversarialFixture must use fixture provenance`);
    if (!["runtime", "import", "fixture"].includes(row.provenance.sourceType) || !row.provenance.sourceRef) v.push(`row ${row.rowId}: invalid provenance`);
    if (row.provenance.capturedAt !== undefined && (!Number.isFinite(row.provenance.capturedAt) || row.provenance.capturedAt < 0)) v.push(`row ${row.rowId}: provenance.capturedAt must be >= 0`);
    const leak = detectLeakageExtended(JSON.stringify(row));
    if (leak) v.push(`row ${row.rowId}: leakage detected (${leak})`);
  }
  return { ok: v.length === 0, violations: v };
}
