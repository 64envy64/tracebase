/**
 * Canonical reasoning-pattern ingestion contract (Phase 2).
 *
 * ONE runtime-facing DTO + ONE validator/normalizer that every pattern —
 * whether captured from a live agent run (`sourceType: "runtime"`) or imported
 * from an external corpus (`sourceType: "import"`) — passes through before it
 * reaches BlockStore. The store never learns where a pattern came from beyond
 * an opaque provenance tag; GitHub URLs / PR numbers / SHAs are optional opaque
 * metadata only and are NOT required, NOT first-class, and NOT stored as
 * structured fields in core. Raw trajectories are never persisted here.
 *
 * Pipeline: structural validation → injection-shape scan → normalize →
 * shared schema+leakage validation (`validateCandidate`) → fingerprint dedupe
 * → persist (or dry-run). Never throws on bad input; returns a typed result.
 */
import type { BlockStore } from "../core/block-store.js";
import type { StoreBlockInput, ValidationReport, BlockInvariants } from "../types.js";
import { createBlock } from "../core/block.js";
import { validateCandidate, failedChecks } from "../distillation/validator.js";

/** DTO schema version. Bump on any breaking field change. */
export const PATTERN_DTO_SCHEMA_VERSION = 1;

/**
 * Generic, source-agnostic reasoning pattern. The core product speaks this
 * shape; adapters (runtime capture, bootstrap importer) produce it.
 */
export interface ReasoningPatternDTO {
  schemaVersion: number;
  pattern: {
    /** Compressed trigger description (what a query must look like). */
    situation: string;
    /** Root-cause structure / why the naive path fails. */
    mechanism: string;
    /** Plausible-but-wrong approaches (optional). */
    deadEnds?: string[];
    /** The pivotal insight that solved it. */
    unlock: string;
    /** How to confirm the fix actually worked. */
    verification: string;
  };
  scope?: {
    /** Opaque repo identifier (audit only — never a control-flow input). */
    repo?: string;
    project?: string;
    language?: string;
    framework?: string;
  };
  signals?: {
    files?: string[];
    apiSurface?: string[];
    errorType?: string;
    tags?: string[];
  };
  provenance: {
    sourceType: "runtime" | "import";
    /** Opaque source reference (PR URL, run id, doc anchor — never parsed). */
    sourceRef?: string;
    runId?: string;
    sessionId?: string;
    capturedAt: number;
    captureVersion: string;
  };
  /** Opaque bag (e.g. github metadata). NOT persisted to core storage. */
  metadata?: Record<string, unknown>;
}

export interface IngestPatternResult {
  status: "accepted" | "rejected" | "duplicate";
  reason?: string;
  blockId?: string;
  fingerprint?: string;
  validation?: ValidationReport;
}

export interface IngestOptions {
  dryRun?: boolean;
  now?: number;
}

/**
 * Prompt-injection / role-hijack shapes that must never enter the reasoning
 * library — an imported or runtime-captured "pattern" that tries to steer the
 * future agent is rejected outright, before schema/leakage checks.
 */
const INJECTION_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "ignore-instructions", re: /ignore\s+(all\s+|any\s+)?(the\s+)?(previous|above|prior|earlier)\s+(instructions|prompts?|context)/i },
  { name: "disregard", re: /disregard\s+(the\s+)?(system|previous|above|all)/i },
  { name: "you-are-now", re: /\byou\s+are\s+now\s+(a|an|the)\b/i },
  { name: "system-prompt", re: /\b(system|developer)\s+prompt\b/i },
  { name: "role-tag", re: /<\/?(system|assistant|user)>/i },
  { name: "jailbreak", re: /\b(jailbreak|\bDAN\b|do\s+anything\s+now)\b/i },
  { name: "new-instructions", re: /\bnew\s+instructions\s*:/i },
];

// ---------------------------------------------------------------------------
// Structural validation
// ---------------------------------------------------------------------------

type DtoCheck = { ok: true; dto: ReasoningPatternDTO } | { ok: false; reason: string };

function isStr(x: unknown): x is string {
  return typeof x === "string";
}
function isStrArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every(isStr);
}

function validateDto(raw: unknown): DtoCheck {
  if (typeof raw !== "object" || raw === null) return { ok: false, reason: "malformed:not-an-object" };
  const d = raw as Record<string, unknown>;
  if (d.schemaVersion !== PATTERN_DTO_SCHEMA_VERSION) {
    return { ok: false, reason: `malformed:schemaVersion!=${PATTERN_DTO_SCHEMA_VERSION}` };
  }
  const p = d.pattern as Record<string, unknown> | undefined;
  if (!p || typeof p !== "object") return { ok: false, reason: "malformed:missing-pattern" };
  for (const f of ["situation", "mechanism", "unlock", "verification"] as const) {
    if (!isStr(p[f]) || (p[f] as string).trim().length === 0) {
      return { ok: false, reason: `malformed:pattern.${f}` };
    }
  }
  if (p.deadEnds !== undefined && !isStrArray(p.deadEnds)) return { ok: false, reason: "malformed:pattern.deadEnds" };

  const prov = d.provenance as Record<string, unknown> | undefined;
  if (!prov || typeof prov !== "object") return { ok: false, reason: "malformed:missing-provenance" };
  if (prov.sourceType !== "runtime" && prov.sourceType !== "import") {
    return { ok: false, reason: "malformed:provenance.sourceType" };
  }
  if (typeof prov.capturedAt !== "number" || !isStr(prov.captureVersion)) {
    return { ok: false, reason: "malformed:provenance.capturedAt/captureVersion" };
  }
  return { ok: true, dto: raw as ReasoningPatternDTO };
}

function detectInjectionShape(dto: ReasoningPatternDTO): string | null {
  const corpus = [
    dto.pattern.situation,
    dto.pattern.mechanism,
    dto.pattern.unlock,
    dto.pattern.verification,
    ...(dto.pattern.deadEnds ?? []),
  ].join("\n");
  for (const { name, re } of INJECTION_PATTERNS) {
    if (re.test(corpus)) return name;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Normalization → StoreBlockInput
// ---------------------------------------------------------------------------

/**
 * Map a validated DTO onto the core block shape. The source type collapses to
 * an opaque `extractedFrom` tag; `captureVersion` is retained for audit; the
 * opaque `metadata` bag and parsed-out GitHub fields are intentionally dropped
 * so core storage never carries source-specific structure.
 */
export function toStoreBlockInput(dto: ReasoningPatternDTO): StoreBlockInput {
  const invariants: BlockInvariants = {
    ...(dto.scope?.language ? { language: dto.scope.language } : {}),
    ...(dto.scope?.framework ? { framework: dto.scope.framework } : {}),
    ...(dto.signals?.errorType ? { errorType: dto.signals.errorType } : {}),
    ...(dto.signals?.apiSurface && dto.signals.apiSurface.length > 0
      ? { apiSurface: dto.signals.apiSurface }
      : {}),
  };
  const runtime = dto.provenance.sourceType === "runtime";
  return {
    kind: "success",
    trigger: { situation: dto.pattern.situation, invariants },
    body: {
      mechanism: dto.pattern.mechanism,
      deadEnds: dto.pattern.deadEnds ?? [],
      unlock: dto.pattern.unlock,
      verification: dto.pattern.verification,
    },
    provenance: {
      // Synthetic, source-agnostic id. The opaque `sourceRef` (e.g. a GitHub
      // URL) is NOT copied into core — it stays metadata; the importer logs it
      // in its summary for audit. Core never carries source-specific content.
      sourceTaskId: dto.provenance.runId ?? `${dto.provenance.sourceType}-${dto.provenance.capturedAt}`,
      extractedFrom: runtime ? "trajectory" : "imported",
      distilledBy: runtime ? "rule" : "manual",
      // captureVersion retained for audit; sessionId links to the trace WITHOUT
      // persisting the raw trajectory.
      sourceAgent: dto.provenance.captureVersion,
      ...(dto.provenance.sessionId ? { parentTraceId: dto.provenance.sessionId } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

/**
 * Validate, privacy-scan, dedupe, and (unless dry-run) persist one pattern.
 * The single entry point for BOTH runtime capture and external import — they
 * differ only in the DTO's `provenance.sourceType`. Never throws.
 */
export function ingestPattern(store: BlockStore, raw: unknown, opts: IngestOptions = {}): IngestPatternResult {
  const v = validateDto(raw);
  if (!v.ok) return { status: "rejected", reason: v.reason };
  const dto = v.dto;

  const inj = detectInjectionShape(dto);
  if (inj) return { status: "rejected", reason: `injection_shaped:${inj}` };

  const input = toStoreBlockInput(dto);
  // Build the full block first (computes keywords + fingerprint), then run the
  // SAME schema + leakage validation the distiller uses on a complete block.
  const block = createBlock(input, { ...(opts.now !== undefined ? { now: opts.now } : {}) });
  const fingerprint = block.trigger.fingerprint;

  const report = validateCandidate(block, { ...(opts.now !== undefined ? { now: opts.now } : {}) });
  if (!report.passed) {
    return { status: "rejected", reason: `validation:${failedChecks(report).join(",")}`, validation: report };
  }

  const existing = store.findBlockByFingerprint(fingerprint);
  if (existing) {
    return { status: "duplicate", reason: "fingerprint_exists", blockId: existing.id, fingerprint };
  }

  if (opts.dryRun) {
    return { status: "accepted", blockId: block.id, fingerprint, validation: report };
  }

  // Persist as candidate, then activate with an origin case ref (activation
  // requires it). Evidence quality reflects the source: a real runtime trace
  // is stronger evidence than an unverified import.
  block.status = "candidate";
  store.storeBlock(block);
  store.attachCaseRef({
    blockId: block.id,
    traceId: input.provenance.parentTraceId ?? `trace-${input.provenance.sourceTaskId}`,
    role: "origin",
    evidenceQuality: dto.provenance.sourceType === "runtime" ? "moderate" : "weak",
  });
  store.updateBlockStatus(block.id, "active");

  return { status: "accepted", blockId: block.id, fingerprint, validation: report };
}
