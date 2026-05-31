#!/usr/bin/env tsx
/**
 * OPTIONAL public-PR bootstrap adapter (Phase 4 follow-up).
 *
 * Maps already-distilled public PR-resolution records into the GENERIC
 * ReasoningPatternDTO, then emits JSONL for `import-patterns.ts`. This adapter
 * is the ONLY place that knows about GitHub; it lives under scripts/adapters,
 * is replaceable, and is absent from runtime control flow. The GitHub URL / PR
 * number / SHA travel only in the DTO's opaque `metadata` + `sourceRef` and are
 * dropped at core ingestion — they never become core storage structure.
 *
 * It does NOT call the GitHub API, run a daemon, or sync. Input is a local JSON
 * array of pre-distilled records: { situation, mechanism, unlock, verification,
 * deadEnds?, language?, framework?, errorType?, prUrl?, sha?, prNumber? }.
 *
 *   npx tsx scripts/adapters/github-pr-import.ts --input prs.json > patterns.jsonl
 *   npx tsx scripts/adapters/import-patterns.ts --input patterns.jsonl --dry-run
 */
import { readFileSync } from "node:fs";
import {
  PATTERN_DTO_SCHEMA_VERSION,
  type ReasoningPatternDTO,
} from "../../src/ingest/pattern-dto.js";

interface PrRecord {
  situation: string;
  mechanism: string;
  unlock: string;
  verification: string;
  deadEnds?: string[];
  language?: string;
  framework?: string;
  errorType?: string;
  files?: string[];
  prUrl?: string;
  sha?: string;
  prNumber?: number;
  capturedAt?: number;
}

function toDto(r: PrRecord): ReasoningPatternDTO {
  return {
    schemaVersion: PATTERN_DTO_SCHEMA_VERSION,
    pattern: {
      situation: r.situation,
      mechanism: r.mechanism,
      ...(r.deadEnds ? { deadEnds: r.deadEnds } : {}),
      unlock: r.unlock,
      verification: r.verification,
    },
    scope: {
      ...(r.language ? { language: r.language } : {}),
      ...(r.framework ? { framework: r.framework } : {}),
    },
    signals: {
      ...(r.files ? { files: r.files } : {}),
      ...(r.errorType ? { errorType: r.errorType } : {}),
    },
    provenance: {
      sourceType: "import",
      // Opaque ref + metadata only — dropped at core ingestion.
      ...(r.prUrl ? { sourceRef: r.prUrl } : {}),
      capturedAt: r.capturedAt ?? 0,
      captureVersion: "github-pr-adapter-v1",
    },
    metadata: {
      ...(r.prNumber !== undefined ? { prNumber: r.prNumber } : {}),
      ...(r.sha ? { sha: r.sha } : {}),
    },
  };
}

const i = process.argv.indexOf("--input");
const input = i >= 0 ? process.argv[i + 1] : undefined;
if (!input) {
  console.error("usage: github-pr-import --input <prs.json>  (emits PatternImportDTO JSONL on stdout)");
  process.exit(1);
}
const records = JSON.parse(readFileSync(input, "utf-8")) as PrRecord[];
for (const r of records) {
  process.stdout.write(JSON.stringify(toDto(r)) + "\n");
}
