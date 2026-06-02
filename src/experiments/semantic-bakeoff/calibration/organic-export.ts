/**
 * Freeze explicitly-labeled organic semantic-shadow observations into an
 * auditable calibration registry.
 *
 * This module never infers labels. Operators curate bounded query/candidate
 * views after reviewing a real shadow observation; the exporter verifies that
 * the label refers to the observed semantic winner and rejects unsafe payloads.
 */
import type { AnalyticsEvent, ReasoningSemanticComparisonEvent } from "../../../types.js";
import type {
  ApplicabilityCandidate,
  ApplicabilityQueryViews,
} from "../../../core/applicability-reranker.js";
import {
  CALIBRATION_DATASET_VERSION,
  datasetHashOf,
  provenanceHashOf,
  validateCalibrationRegistry,
  type CalibrationDatasetRegistry,
  type CalibrationLabel,
} from "./registry.js";

export interface SemanticOrganicLabel {
  rowId: string;
  queryId: string;
  familyKey: string;
  query: ApplicabilityQueryViews;
  candidate: ApplicabilityCandidate;
  label: CalibrationLabel;
  hardNegative: boolean;
}

export interface FreezeOrganicCalibrationOptions {
  frozenAt?: string;
}

export interface FrozenOrganicCalibrationExport {
  registry: CalibrationDatasetRegistry;
  datasetHash: string;
  provenanceHash: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Fail closed at the operator boundary. The shared registry validator performs
 * the deep DTO validation after provenance is attached; this first pass keeps a
 * malformed JSON file from failing later as an opaque property-access error.
 */
export function parseSemanticOrganicLabels(value: unknown): SemanticOrganicLabel[] {
  const labels = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.labels)
      ? value.labels
      : null;
  if (!labels) throw new Error("labels file must be a JSON array or an object with a labels array");
  return labels.map((label, index) => {
    if (!isRecord(label)) throw new Error(`label #${index} must be an object`);
    const rowRef = typeof label.rowId === "string" && label.rowId ? label.rowId : `#${index}`;
    if (typeof label.rowId !== "string" || !label.rowId) throw new Error(`label ${rowRef} rowId must be non-empty`);
    if (typeof label.queryId !== "string" || !label.queryId) throw new Error(`label ${rowRef} queryId must be non-empty`);
    if (!isRecord(label.query)) throw new Error(`label ${rowRef} query must be an object`);
    if (!isRecord(label.candidate)) throw new Error(`label ${rowRef} candidate must be an object`);
    if (typeof label.candidate.blockId !== "string" || !label.candidate.blockId) {
      throw new Error(`label ${rowRef} candidate.blockId must be non-empty`);
    }
    return label as unknown as SemanticOrganicLabel;
  });
}

function semanticObservations(
  events: readonly AnalyticsEvent[],
): Map<string, ReasoningSemanticComparisonEvent> {
  const observations = new Map<string, ReasoningSemanticComparisonEvent>();
  for (const event of events) {
    if (event.event !== "reasoning.semantic_comparison") continue;
    if (observations.has(event.queryId)) {
      throw new Error(`duplicate semantic shadow observation for queryId ${event.queryId}`);
    }
    observations.set(event.queryId, event);
  }
  return observations;
}

export function freezeOrganicCalibrationRegistry(
  events: readonly AnalyticsEvent[],
  labels: unknown,
  options: FreezeOrganicCalibrationOptions = {},
): FrozenOrganicCalibrationExport {
  const observations = semanticObservations(events);
  const rows = parseSemanticOrganicLabels(labels).map((label) => {
    const observation = observations.get(label.queryId);
    if (!observation) {
      throw new Error(`label ${label.rowId} has no observed semantic shadow event`);
    }
    if (!observation.semanticTopBlockId) {
      throw new Error(`label ${label.rowId} refers to an observation without a semantic winner`);
    }
    if (label.candidate.blockId !== observation.semanticTopBlockId) {
      throw new Error(
        `label ${label.rowId} blockId does not match observed semantic winner ${observation.semanticTopBlockId}`,
      );
    }
    return {
      rowId: label.rowId,
      familyKey: label.familyKey,
      query: label.query,
      candidate: label.candidate,
      label: label.label,
      hardNegative: label.hardNegative,
      provenance: {
        sourceType: "runtime" as const,
        sourceRef: `semantic:${observation.queryHash}:${observation.semanticTopBlockId}`,
        capturedAt: observation.ts,
      },
    };
  });

  const registry: CalibrationDatasetRegistry = {
    datasetVersion: CALIBRATION_DATASET_VERSION,
    kind: "organic-calibration",
    frozenAt: options.frozenAt ?? new Date().toISOString(),
    rows,
  };
  const validation = validateCalibrationRegistry(registry);
  if (!validation.ok) {
    throw new Error(`organic calibration export rejected: ${validation.violations.join("; ")}`);
  }
  return {
    registry,
    datasetHash: datasetHashOf(registry),
    provenanceHash: provenanceHashOf(registry),
  };
}
