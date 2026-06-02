/**
 * Generic JSONL pattern importer (Phase 4) — an OPTIONAL bootstrap boundary,
 * not a product. It reads newline-delimited `ReasoningPatternDTO` records and
 * feeds each through the SAME `ingestPattern` validator the runtime capture
 * path uses — so an imported pattern and a runtime-captured pattern are
 * indistinguishable to retrieval. No webhooks, no daemon, no sync service, no
 * UI; just parse → validate → (dry-run or persist) → summarize.
 */
import type { BlockStore } from "../core/block-store.js";
import { ingestPattern, type IngestPatternResult } from "./pattern-dto.js";

export interface ImportLineResult extends IngestPatternResult {
  /** 1-based line number in the JSONL input. */
  line: number;
}

export interface ImportSummary {
  total: number;
  accepted: number;
  rejected: number;
  duplicate: number;
  dryRun: boolean;
  results: ImportLineResult[];
}

/**
 * Import every JSON object on its own line. Blank lines are skipped. A line
 * that does not parse as JSON is reported as a rejected result (reason
 * `malformed:json`) — one bad line never aborts the batch.
 */
export function importPatternsFromJsonl(
  store: BlockStore,
  jsonl: string,
  opts: { dryRun?: boolean; now?: number } = {},
): ImportSummary {
  const dryRun = opts.dryRun ?? false;
  const results: ImportLineResult[] = [];
  const lines = jsonl.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.trim();
    if (raw.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      results.push({ line: i + 1, status: "rejected", reason: "malformed:json" });
      continue;
    }
    const r = ingestPattern(store, parsed, {
      dryRun,
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    });
    results.push({ line: i + 1, ...r });
  }

  return {
    total: results.length,
    accepted: results.filter((r) => r.status === "accepted").length,
    rejected: results.filter((r) => r.status === "rejected").length,
    duplicate: results.filter((r) => r.status === "duplicate").length,
    dryRun,
    results,
  };
}

/** One-line-per-record human summary for CLI output. */
export function formatImportSummary(s: ImportSummary): string {
  const head = `${s.dryRun ? "[dry-run] " : ""}imported ${s.total}: ${s.accepted} accepted, ${s.duplicate} duplicate, ${s.rejected} rejected`;
  const rejects = s.results
    .filter((r) => r.status === "rejected")
    .map((r) => `  line ${r.line}: rejected (${r.reason})`)
    .join("\n");
  return rejects ? `${head}\n${rejects}` : head;
}
