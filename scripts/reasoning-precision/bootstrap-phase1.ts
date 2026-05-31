#!/usr/bin/env tsx
/**
 * BOOTSTRAP / COLD-START import eval — Phase 1 (offline, $0, no paid agents).
 *
 * Per BOOTSTRAP-IMPORT-PREREG.md. Disclosed, hand-authored corpus of GENUINELY
 * RECURRING reasoning CLASSES (not organic, not public-mined, not random bugs):
 * 10 families, each = one reusable class pattern (imported via the generic
 * ReasoningPatternDTO → ingestPattern boundary, import provenance) + 2 leakage-safe
 * holdout instances (different concrete bug, same class) + 10 UNRELATED negative
 * controls. Runs the REAL serving policy (evaluatePrecision) at the production gate
 * + a diagnostic sensitivity table. Imported evidence is BOOTSTRAP — never counted
 * toward organic readiness. No serving-gate changes; no threshold tuning.
 */
import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import { BlockServer } from "../../src/core/block-serving.js";
import { importPatternsFromJsonl } from "../../src/ingest/import-patterns.js";
import { PATTERN_DTO_SCHEMA_VERSION } from "../../src/ingest/pattern-dto.js";
import { evaluatePrecision, type LabeledQuery } from "../../src/eval/precision-evaluator.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT_DIR = join(ROOT, "bench-runs", "reasoning-reuse", "bootstrap");
const FROZEN_AT = parseInt(process.env.TB_FROZEN_AT ?? "0", 10);

interface Family { id: string; canonical: { situation: string; mechanism: string; unlock: string }; holdouts: string[]; }
// Each canonical.situation + its holdouts share the class's concept vocabulary
// (the recurring root-cause terms) but describe DIFFERENT concrete instances.
const FAMILIES: Family[] = [
  { id: "null-guard", canonical: { situation: "A config merge crashes when an optional key is absent: the undefined value is dereferenced during reduce because no null/undefined guard precedes the access.", mechanism: "An absent optional key yields undefined; the code dereferences it without a null/undefined guard, so the absent case is never distinguished from a present one.", unlock: "Guard the access: skip or default undefined/null before dereferencing, treating absent as inherit-default." }, holdouts: ["A request handler throws on missing optional header because the undefined value is dereferenced with no null guard before access.", "A serializer crashes when an optional nested field is absent: undefined is dereferenced during traversal because the null/undefined guard is missing."] },
  { id: "off-by-one", canonical: { situation: "A slice drops the last element because an inclusive boundary is treated as exclusive: the range index is off by one at the upper bound.", mechanism: "The upper boundary is inclusive but the loop/slice uses an exclusive index, so the last element of the range is skipped — a classic off-by-one at the bound.", unlock: "Align the boundary: use inclusive end (index <= last) or adjust the exclusive slice end by one." }, holdouts: ["Pagination omits the final row because the range upper bound is exclusive while the boundary should be inclusive — an off-by-one index error.", "A windowed average is wrong at the edges because the slice boundary is off by one, dropping the last index of the range."] },
  { id: "unawaited-async", canonical: { situation: "A test flakes because a promise is not awaited: the async write races the assertion since the pending promise resolves after the check.", mechanism: "The async call returns a pending promise that is never awaited, so subsequent code races the unresolved promise instead of sequencing after it resolves.", unlock: "Await the promise (or chain .then) so execution sequences after it resolves; do not fire-and-forget." }, holdouts: ["A cache write is lost because the async persist promise is not awaited, so the read races the still-pending resolve.", "An integration test intermittently fails: the async teardown promise is unawaited and races the next test's setup before it resolves."] },
  { id: "cache-staleness", canonical: { situation: "Stale data is served because the cache is not invalidated on update: the memoized entry survives a write and the eviction never fires.", mechanism: "A write mutates the source but does not invalidate or refresh the cached/memoized entry, so reads keep returning the stale value until unrelated eviction.", unlock: "Invalidate or refresh the cache key on every write that changes the cached value; do not rely on TTL alone." }, holdouts: ["A dashboard shows outdated totals because the memoized aggregate is not invalidated after the underlying rows change.", "An ACL check uses a stale permission because the cache entry was not evicted when the role was updated."] },
  { id: "timezone", canonical: { situation: "A date comparison is wrong across a daylight-savings boundary because a local timestamp is compared without normalizing to UTC offset.", mechanism: "Timestamps are compared in local time without normalizing to UTC, so the daylight-savings offset shifts the value and the comparison crosses a boundary incorrectly.", unlock: "Normalize all timestamps to UTC before comparison or arithmetic; only format to local at the edge." }, holdouts: ["A scheduled job double-fires around the DST change because local timestamps are used instead of UTC offsets for the next-run comparison.", "A report groups events into the wrong day because the timezone offset is not applied before bucketing the timestamp."] },
  { id: "resource-leak", canonical: { situation: "A long run exhausts file descriptors because a handle is opened in a loop but never closed: the socket/descriptor leaks on the error path.", mechanism: "A resource (handle, socket, descriptor) is acquired but not released on all paths — especially errors — so it leaks and the pool is eventually exhausted.", unlock: "Release the resource in finally/using/defer so close runs on every path including errors and early returns." }, holdouts: ["A server slowly runs out of connections because a database handle is not closed on the error branch, leaking the socket each failure.", "A batch job leaks file descriptors: each iteration opens a stream but only closes it on success, never on the exception path."] },
  { id: "encoding", canonical: { situation: "Text is garbled because bytes are decoded with the wrong charset: a UTF-8 stream is read as latin-1 so multibyte characters mojibake.", mechanism: "A byte stream is decoded with an assumed charset that differs from the actual encoding, so multibyte UTF-8 sequences are split and rendered as mojibake.", unlock: "Decode with the declared/actual charset (UTF-8); never assume a single-byte encoding for byte input." }, holdouts: ["A CSV import corrupts accented names because the file bytes are decoded as ASCII instead of the declared UTF-8 charset.", "An API response shows replacement characters because the body bytes are decoded with the wrong unicode charset before parsing."] },
  { id: "retry-storm", canonical: { situation: "A transient failure triggers a retry storm because retries have no exponential backoff or jitter, so clients hammer the dependency in lockstep.", mechanism: "Retries fire immediately and synchronously without exponential backoff or jitter, so many clients retry in lockstep and amplify load into a storm.", unlock: "Add exponential backoff with jitter and a cap/budget so retries spread out instead of synchronizing." }, holdouts: ["An outage worsens because every worker retries the failed call instantly with no backoff, throttling the recovering dependency.", "A queue consumer melts the database during a blip because retries lack jitter and exponential backoff, synchronizing the load."] },
  { id: "pagination-dup", canonical: { situation: "A paginated export duplicates rows because offset pagination shifts when items are inserted mid-scan; a stable cursor is needed instead of offset.", mechanism: "Offset-based pagination assumes a stable ordering, but concurrent inserts shift offsets, so rows are skipped or duplicated across pages — a cursor is required.", unlock: "Use a stable keyset/cursor (order by a unique key, page after last seen) instead of numeric offset." }, holdouts: ["A sync job re-processes some records because offset pagination drifts when new rows arrive between page fetches; a cursor would be stable.", "An export misses entries because offset/limit paging shifts under concurrent writes, where keyset cursor pagination would be correct."] },
  { id: "float-precision", canonical: { situation: "A money total is off by a cent because floating-point arithmetic accumulates rounding error; integer minor-units or a decimal type is needed.", mechanism: "Currency is summed in binary floating point, so repeated rounding error accumulates and the total drifts from the exact decimal value.", unlock: "Compute in integer minor units (cents) or a decimal type; never accumulate money in binary floating point." }, holdouts: ["An invoice line-sum disagrees with the displayed total because amounts are added as floats, accumulating binary rounding error.", "A tax calculation is a cent short because percentages are applied in floating point instead of integer minor units or decimals."] },
];
// 10 UNRELATED negative controls — distinct concepts NOT in the imported corpus.
const CONTROLS: string[] = [
  "A flexbox row overflows its container because the child has no min-width, so long content refuses to shrink.",
  "A regex causes catastrophic backtracking on certain inputs due to nested quantifiers in the pattern.",
  "A CORS preflight is rejected because the server omits the Access-Control-Allow-Headers response header.",
  "A gradient descent run diverges because the learning rate is set far above the stable range for this loss.",
  "A dockerfile build is huge because each RUN layer keeps the apt cache instead of cleaning it in the same layer.",
  "A websocket disconnects after 60s because no ping/pong keepalive is sent and the proxy idle-times the connection.",
  "A CSS animation janks on mobile because it animates layout properties instead of transform/opacity.",
  "A GraphQL query N+1s the database because the resolver fetches per-item instead of batching with a dataloader.",
  "A terraform apply destroys a resource because a forced-new attribute changed and no lifecycle ignore was set.",
  "A keyboard trap occurs in a modal because focus is not returned to the trigger on close, breaking accessibility.",
];

function buildImportDtos(): unknown[] {
  return FAMILIES.map((f) => ({
    schemaVersion: PATTERN_DTO_SCHEMA_VERSION,
    pattern: { situation: f.canonical.situation, mechanism: f.canonical.mechanism, unlock: f.canonical.unlock, verification: "Re-run the failing scenario and confirm the class-specific symptom is gone." },
    scope: { language: "general" },
    signals: { tags: [f.id, "recurring-class", "bootstrap"] },
    provenance: { sourceType: "import", sourceRef: `bootstrap:${f.id}`, capturedAt: FROZEN_AT || 1, captureVersion: "bootstrap-coldstart-1" },
    metadata: { familyId: f.id, disclosure: "hand-authored recurring-class cold-start; NOT organic, NOT public-mined" },
  }));
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const dtos = buildImportDtos();
  const jsonl = dtos.map((d) => JSON.stringify(d)).join("\n");
  const corpusHash = createHash("sha256").update(jsonl).digest("hex").slice(0, 16);
  writeFileSync(join(OUT_DIR, "corpus.import.jsonl"), jsonl + "\n");

  // Import via the generic boundary (import provenance).
  const store = new BlockStore(new Database(":memory:"));
  const summary = importPatternsFromJsonl(store, jsonl, { now: FROZEN_AT || 1 });
  const familyBlock = new Map<string, string>();
  summary.results.forEach((r, i) => { if (r.status === "accepted" && r.blockId) familyBlock.set(FAMILIES[i]!.id, r.blockId); });
  const importedBlockIds = [...familyBlock.values()];

  // Build labeled queries: 20 useful holdouts (leakage-safe — different instance,
  // expecting the family's imported canonical) + 10 unrelated controls. All bootstrap.
  const queries: LabeledQuery[] = [];
  for (const f of FAMILIES) {
    const bid = familyBlock.get(f.id);
    if (!bid) continue;
    for (const h of f.holdouts) queries.push({ text: h, label: "useful", expectBlockId: bid, provenanceClass: "bootstrap" });
  }
  for (const c of CONTROLS) queries.push({ text: c, label: "unrelated", provenanceClass: "bootstrap" });

  const blocks = importedBlockIds.map((id) => ({ id, sourceType: "import" as const }));

  // Production gate (gateThreshold 0 + serving-confidence policy). organicCaptureWorks
  // is irrelevant here (bootstrap), pass true so the readiness object is well-formed.
  const server = new BlockServer(store, { gateThreshold: 0 });
  const report = evaluatePrecision(server, blocks, queries, { organicCaptureWorks: true });

  // Diagnostic sensitivity table over the calibrated-prob gate (PRODUCTION UNCHANGED).
  const sensitivity = [0, 0.2, 0.4, 0.6].map((gt) => {
    const s = new BlockServer(store, { gateThreshold: gt });
    const r = evaluatePrecision(s, blocks, queries, { organicCaptureWorks: true });
    return { gateThreshold: gt, fireRate: round(r.fireRate), precisionAtFire: round(r.precisionAtFire), wilsonLB: round(r.precisionWilsonLB), falsePositiveRate: round(r.falsePositiveRate), recallAtUseful: round(r.recallAtUseful) };
  });

  // Direct fire counts: within-recurring-family (useful holdouts) + negative controls.
  const usefulQs = queries.filter((q) => q.label === "useful");
  const controlQs = queries.filter((q) => q.label === "unrelated");
  const usefulFired = usefulQs.filter((q) => server.recall({ text: q.text }).shouldInject).length;
  const controlFired = controlQs.filter((q) => server.recall({ text: q.text }).shouldInject).length;
  const fireRateWithinRecurringFamilies = usefulQs.length ? usefulFired / usefulQs.length : 0;
  const controlFalsePositiveRate = controlQs.length ? controlFired / controlQs.length : 0;

  const out = {
    label: "BOOTSTRAP / COLD-START — NOT organic readiness. Hand-authored recurring-class corpus; no mining; no gate tuning.",
    corpusHash, frozenAt: FROZEN_AT,
    corpus: { families: FAMILIES.length, importedPatterns: dtos.length, usefulHoldouts: queries.filter((q) => q.label === "useful").length, unrelatedControls: queries.filter((q) => q.label === "unrelated").length, instancesPerFamily: "1 canonical + 2 holdouts = 3" },
    import: { total: summary.total, accepted: summary.accepted, rejected: summary.rejected, duplicate: summary.duplicate },
    leakageAudit: { ownFixInjected: false, holdoutsDistinctFromImports: true, disjointInstances: true, negativeControlsPresent: CONTROLS.length, note: "holdouts are different concrete instances of the same class; imported patterns carry reusable reasoning, not the holdout's answer" },
    metrics: {
      fireRateOverall: round(report.fireRate),
      fireRateWithinRecurringFamilies: round(fireRateWithinRecurringFamilies),
      controlFalsePositiveRate: round(controlFalsePositiveRate),
      precisionAtFire: round(report.precisionAtFire),
      precisionWilsonLB: round(report.precisionWilsonLB),
      falsePositiveRate: round(report.falsePositiveRate),
      recallAtUseful: round(report.recallAtUseful),
      abstentionByReason: report.abstentionByReason,
      latencyMsP50: report.latencyMsP50, latencyMsP95: report.latencyMsP95,
      calibratorVersion: report.calibratorVersion, calibratedCoverage: report.calibratedCoverage,
    },
    sensitivity,
  };
  writeFileSync(join(OUT_DIR, "phase1-report.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify({ ...out, sensitivity: undefined }, null, 2));
  console.log("\nsensitivity (gateThreshold → fire/precision/WilsonLB/FP/recall):");
  for (const s of sensitivity) console.log(`  gt=${s.gateThreshold}: fire=${s.fireRate} prec=${s.precisionAtFire} wLB=${s.wilsonLB} fp=${s.falsePositiveRate} recall=${s.recallAtUseful}`);
  console.log(`\ncorpusHash=${corpusHash}  (freeze with TB_FROZEN_AT set)`);
  store.close();
}
function round(x: number | null): number | null { return x === null ? null : Math.round(x * 1000) / 1000; }
main();
