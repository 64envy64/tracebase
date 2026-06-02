/**
 * FROZEN offline bakeoff fixtures (R&D): recurring reasoning-lesson families with
 * positive holdouts (the lesson's mechanism genuinely applies to the query) and
 * negatives (a query paired with an unrelated family's lesson). Labels are the
 * ground truth for precision@fire / recall@useful. Hand-authored + frozen — NOT
 * organic traffic and never counted as such.
 */
import type { ApplicabilityCandidate, ApplicabilityQueryViews } from "../../src/core/applicability-reranker.js";

export interface BakeoffFixture {
  probeId: string;
  family: string;
  query: ApplicabilityQueryViews;
  candidate: ApplicabilityCandidate;
  /** Ground truth: does this candidate lesson's mechanism apply to this query? */
  label: "useful" | "not-useful";
}

const LESSON = (blockId: string, situation: string[], mechanism: string[], unlock: string[], helpful = 3): ApplicabilityCandidate => ({
  blockId,
  tokens: { situation, mechanism, unlock, invariants: [] },
  signals: { isPitfall: false, helpful, harmful: 0, unresolved: 0, familySupport: helpful, sourceDiversity: 2 },
});

// Family lesson prototypes.
const FLOAT = LESSON("L-float", ["running", "balance", "off", "fraction"], ["summing", "floating", "point", "accumulates", "rounding", "error", "low", "order", "bits", "order", "operations"], ["kahan", "compensated", "summation", "integer", "cents"]);
const RACE = LESSON("L-race", ["intermittent", "test", "failure", "flaky"], ["two", "async", "tasks", "share", "mutable", "state", "without", "synchronization", "interleaving", "order"], ["await", "lock", "mutex", "serialize", "atomic"]);
const OBO = LESSON("L-obo", ["last", "element", "missing", "or", "crash"], ["loop", "bound", "uses", "less", "than", "equal", "index", "exceeds", "array", "length", "by", "one"], ["use", "less", "than", "length", "fix", "boundary"]);
const SQL = LESSON("L-sql", ["query", "breaks", "on", "apostrophe"], ["string", "concatenation", "builds", "sql", "unescaped", "user", "input", "injection"], ["parameterized", "query", "prepared", "statement", "bind"]);
const CACHE = LESSON("L-cache", ["stale", "value", "served", "after", "update"], ["cache", "not", "invalidated", "after", "write", "reads", "old", "snapshot", "ttl"], ["invalidate", "on", "write", "version", "key", "shorten", "ttl"]);

const Q = (literalText: string, causalText?: string): ApplicabilityQueryViews => (causalText ? { literalText, causalText } : { literalText });

export const BAKEOFF_FIXTURES: readonly BakeoffFixture[] = [
  // ── positives (mechanism applies) ──
  { probeId: "float+", family: "float", label: "useful", candidate: FLOAT, query: Q("running total is off by a tiny fraction after many adds", "each addition discards low order bits so summation order changes the result") },
  { probeId: "float+2", family: "float", label: "useful", candidate: FLOAT, query: Q("currency sum drifts by a cent over thousands of rows", "floating point rounding accumulates across additions") },
  { probeId: "race+", family: "race", label: "useful", candidate: RACE, query: Q("test passes alone but fails under the full suite intermittently", "two async tasks mutate shared state with no synchronization") },
  { probeId: "race+2", family: "race", label: "useful", candidate: RACE, query: Q("counter is sometimes one short under load", "concurrent increments interleave without a lock") },
  { probeId: "obo+", family: "obo", label: "useful", candidate: OBO, query: Q("crash reading past the end of the array", "loop condition uses <= so the index reaches length") },
  { probeId: "sql+", family: "sql", label: "useful", candidate: SQL, query: Q("query errors when a name contains an apostrophe", "user input concatenated into sql unescaped") },
  { probeId: "cache+", family: "cache", label: "useful", candidate: CACHE, query: Q("UI shows the old value right after saving", "cache not invalidated on write so reads see a stale snapshot") },
  // ── negatives (unrelated family) ──
  { probeId: "float-neg", family: "float", label: "not-useful", candidate: FLOAT, query: Q("query errors when a name contains an apostrophe", "sql escaping of user input") },
  { probeId: "race-neg", family: "race", label: "not-useful", candidate: RACE, query: Q("running total off by a tiny fraction", "floating point rounding accumulates") },
  { probeId: "obo-neg", family: "obo", label: "not-useful", candidate: OBO, query: Q("UI shows a stale value after update", "cache invalidation on write") },
  { probeId: "sql-neg", family: "sql", label: "not-useful", candidate: SQL, query: Q("test is flaky under concurrency", "two async tasks race on shared state") },
  { probeId: "cache-neg", family: "cache", label: "not-useful", candidate: CACHE, query: Q("crash reading past the array end", "off by one in the loop bound") },
  // ── hard negatives (related vocabulary, different mechanism) ──
  { probeId: "float-hard", family: "float", label: "not-useful", candidate: FLOAT, query: Q("integer overflow wraps the running total to a negative number", "fixed width integer exceeds max value and wraps") },
  { probeId: "race-hard", family: "race", label: "not-useful", candidate: RACE, query: Q("test fails because a fixture file is missing on CI", "environment setup did not create the fixture path") },
  // ── adversarial negatives: STRONG lexical overlap with the family, WRONG mechanism ──
  { probeId: "sql-adv", family: "sql", label: "not-useful", candidate: SQL, query: Q("the sql query is slow and times out on large tables", "missing index causes a full table scan, not escaping") },
  { probeId: "cache-adv", family: "cache", label: "not-useful", candidate: CACHE, query: Q("cache hit rate is low and memory pressure evicts entries", "working set exceeds cache capacity, not invalidation") },
  { probeId: "obo-adv", family: "obo", label: "not-useful", candidate: OBO, query: Q("the array loop never runs because the array is empty", "empty input, not an off-by-one boundary") },
  { probeId: "float-adv", family: "float", label: "not-useful", candidate: FLOAT, query: Q("floating point result prints with too many decimal places", "display formatting, not accumulation of rounding error") },
];
