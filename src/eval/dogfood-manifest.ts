/**
 * Dogfood capture manifest + progress report (Phase 5, Step 2).
 *
 * Reads a runtime BlockStore (the one the Stop hook captures into during normal
 * sessions) and produces:
 *   - a privacy-safe JSONL manifest: one entry per captured block with its
 *     provenance + retrieval/attribution counts. NO raw prompts or secrets — the
 *     situation is the already-distilled, leakage-scanned trigger; correlation
 *     uses queryHash from serving telemetry, never the prompt text.
 *   - a compact progress summary: captured / runtime-captured / imported / fired
 *     / attributed / rejected / duplicates / precision-ready.
 *
 * "precision-ready" = runtime-captured blocks that have both fired (>=1
 * injection) and been attributed to a resolved outcome — i.e. usable organic
 * evidence for the Phase 5 gate.
 */
import type { BlockStore } from "../core/block-store.js";
import type { ReasoningBlock, RetrievalEvent } from "../types.js";
import { detectLeakage } from "../core/block.js";
import { queryHash } from "../core/serving-tokenizer.js";

export interface DogfoodManifestEntry {
  blockId: string;
  fingerprint: string;
  extractedFrom: ReasoningBlock["provenance"]["extractedFrom"];
  distilledBy: ReasoningBlock["provenance"]["distilledBy"];
  captureVersion?: string;
  distillerVersion?: string;
  createdAt: number;
  /**
   * Non-reversible hash of the trigger. The raw situation is the user's first
   * sentence and can carry incidental secrets the pattern-based scanner misses,
   * so the EXPORTED manifest never contains it — only a correlation hash.
   */
  situationHash: string;
  /** queryHashes (from serving telemetry) this block was injected under. */
  queryHashes: string[];
  injections: number;
  attributedResolved: number;
  /** Final leakage re-check — true when the entry is safe to share. */
  leakClean: boolean;
}

export interface DogfoodSummary {
  captured: number;
  runtimeCaptured: number;
  imported: number;
  fired: number;
  attributed: number;
  rejected: number;
  duplicates: number;
  precisionReady: number;
}

export interface DogfoodManifest {
  summary: DogfoodSummary;
  entries: DogfoodManifestEntry[];
}

export function buildDogfoodManifest(store: BlockStore): DogfoodManifest {
  const rows = store.rawDb
    .prepare("SELECT id FROM reasoning_blocks WHERE status = 'active'")
    .all() as Array<{ id: string }>;

  const events = store.readEvents({ limit: 5_000_000 });

  // Index attribution by block + query.
  const injQueriesByBlock = new Map<string, Set<string>>();
  const queryHashByQuery = new Map<string, string>();
  const agentUsedByBlock = new Map<string, Set<string>>();
  const resolvedQueries = new Set<string>();
  let rejected = 0;

  for (const ev of events) {
    switch (ev.event) {
      case "injection": {
        let s = injQueriesByBlock.get(ev.blockId);
        if (!s) injQueriesByBlock.set(ev.blockId, (s = new Set()));
        s.add(ev.queryId);
        break;
      }
      case "retrieval": {
        const serving = (ev as RetrievalEvent).serving;
        if (serving) queryHashByQuery.set(serving.retrievalId, serving.queryHash);
        break;
      }
      case "agent_used": {
        let s = agentUsedByBlock.get(ev.blockId);
        if (!s) agentUsedByBlock.set(ev.blockId, (s = new Set()));
        s.add(ev.queryId);
        break;
      }
      case "outcome":
        if (ev.resolved) resolvedQueries.add(ev.queryId);
        break;
      case "capture.error":
        rejected += 1;
        break;
      default:
        break;
    }
  }

  const entries: DogfoodManifestEntry[] = [];
  let runtimeCaptured = 0, imported = 0, fired = 0, attributed = 0, duplicates = 0, precisionReady = 0;

  for (const { id } of rows) {
    const block = store.getBlock(id);
    if (!block) continue;
    const injQueries = injQueriesByBlock.get(id) ?? new Set<string>();
    const usedQueries = agentUsedByBlock.get(id) ?? new Set<string>();
    const attributedResolved = [...usedQueries].filter((q) => resolvedQueries.has(q)).length;
    const isRuntime = block.provenance.extractedFrom === "trajectory";
    const refs = store.listCaseRefs(id);

    if (isRuntime) runtimeCaptured++;
    else if (block.provenance.extractedFrom === "imported") imported++;
    if (injQueries.size > 0) fired++;
    if (attributedResolved > 0) attributed++;
    if (refs.length > 1) duplicates++;
    if (isRuntime && injQueries.size > 0 && attributedResolved > 0) precisionReady++;

    const leak = detectLeakage(block);
    entries.push({
      blockId: id,
      fingerprint: block.trigger.fingerprint,
      extractedFrom: block.provenance.extractedFrom,
      distilledBy: block.provenance.distilledBy,
      ...(block.provenance.captureVersion ? { captureVersion: block.provenance.captureVersion } : {}),
      ...(block.provenance.distillerVersion ? { distillerVersion: block.provenance.distillerVersion } : {}),
      createdAt: block.createdAt,
      situationHash: queryHash(block.trigger.situation),
      queryHashes: [...injQueries].map((q) => queryHashByQuery.get(q)).filter((h): h is string => !!h),
      injections: injQueries.size,
      attributedResolved,
      leakClean: leak === null,
    });
  }

  return {
    summary: {
      captured: entries.length,
      runtimeCaptured,
      imported,
      fired,
      attributed,
      rejected,
      duplicates,
      precisionReady,
    },
    entries,
  };
}

/** Manifest as newline-delimited JSON (privacy-safe entries only). */
export function manifestToJsonl(m: DogfoodManifest): string {
  return m.entries.map((e) => JSON.stringify(e)).join("\n");
}

/** Compact one-block progress report for CLI output. */
export function formatDogfoodSummary(s: DogfoodSummary): string {
  return (
    `dogfood capture: ${s.captured} captured (${s.runtimeCaptured} runtime, ${s.imported} imported)\n` +
    `  fired ${s.fired} · attributed ${s.attributed} · duplicates ${s.duplicates} · rejected ${s.rejected}\n` +
    `  precision-ready (organic, fired+attributed): ${s.precisionReady}`
  );
}
