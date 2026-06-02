/**
 * Privacy-safe semantic-shadow observation skeletons for operator labeling.
 *
 * These are navigation aids, not inferred labels and not calibration rows. Raw
 * prompt text, candidate tokens, bodies, paths, credentials, and cache content
 * are intentionally absent. Operators curate the bounded DTO separately before
 * `semantic export-registry` accepts it.
 */
import type { AnalyticsEvent, ReasoningSemanticComparisonEvent } from "../types.js";
import { detectLeakageExtended } from "../core/guard.js";

export interface SemanticShadowObservationSkeleton {
  queryId: string;
  queryHash: string;
  observedAt: number;
  v4Action: ReasoningSemanticComparisonEvent["v4Action"];
  semanticProvider: string;
  semanticFeatureVersion: number;
  semanticAttestationId?: string;
  semanticVerdict: ReasoningSemanticComparisonEvent["semanticVerdict"];
  semanticTopBlockId?: string;
  semanticConfidence?: number;
  changedDecision: ReasoningSemanticComparisonEvent["changedDecision"];
  fallback: ReasoningSemanticComparisonEvent["fallback"];
}

function assertOpaque(value: string, field: string): void {
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(value)) {
    throw new Error(`unsafe semantic observation identifier: ${field}`);
  }
}

export function collectSemanticShadowObservations(
  events: readonly AnalyticsEvent[],
): SemanticShadowObservationSkeleton[] {
  return events
    .filter((event): event is ReasoningSemanticComparisonEvent => event.event === "reasoning.semantic_comparison")
    .sort((a, b) => a.ts - b.ts || a.queryId.localeCompare(b.queryId))
    .map((event) => {
      assertOpaque(event.queryId, "queryId");
      assertOpaque(event.queryHash, "queryHash");
      assertOpaque(event.semanticProvider, "semanticProvider");
      if (event.semanticAttestationId) assertOpaque(event.semanticAttestationId, "semanticAttestationId");
      if (event.semanticTopBlockId) assertOpaque(event.semanticTopBlockId, "semanticTopBlockId");
      const observation = {
        queryId: event.queryId,
        queryHash: event.queryHash,
        observedAt: event.ts,
        v4Action: event.v4Action,
        semanticProvider: event.semanticProvider,
        semanticFeatureVersion: event.semanticFeatureVersion,
        ...(event.semanticAttestationId ? { semanticAttestationId: event.semanticAttestationId } : {}),
        semanticVerdict: event.semanticVerdict,
        ...(event.semanticTopBlockId ? { semanticTopBlockId: event.semanticTopBlockId } : {}),
        ...(event.semanticConfidence !== undefined ? { semanticConfidence: event.semanticConfidence } : {}),
        changedDecision: event.changedDecision,
        fallback: event.fallback,
      };
      if (detectLeakageExtended(JSON.stringify(observation))) {
        throw new Error("semantic observation export blocked by privacy scan");
      }
      return observation;
    });
}
