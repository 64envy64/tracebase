/**
 * Junk-rate diagnostic for the local TraceBase pattern store.
 *
 * Walks every reasoning_blocks row and classifies it against a set of
 * heuristics that catch the most common extraction failures we've
 * observed in dogfood injection logs:
 *
 *   - junk-template: body_verification is the canned "Re-run the
 *     failing step…" string with no real verify content.
 *   - junk-release-noise: situation/mechanism/unlock contains release
 *     announcement noise (`tracebase-ai@N`, `git pushed`, `tests pass`)
 *     without a reusable fix narrative.
 *   - junk-self-ref: body_mechanism is essentially a restatement of
 *     trig_situation (Jaccard ≥ 0.8 on whitespace tokens).
 *   - junk-empty: trig_situation, body_mechanism, or body_unlock is
 *     missing real content (< 30 non-whitespace chars after stripping
 *     markdown headings).
 *
 * Output: per-block classification table + aggregate junk-rate by
 * category. Designed to be copy-pasted into the design-partner
 * technical brief; not a permanent CLI command (yet).
 *
 * Run: `tsx scripts/junk-rate-diagnostic.ts [path-to-memory.db]`
 * Default DB: ./.tracebase/memory.db relative to cwd.
 */

import Database from "better-sqlite3";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

interface BlockRow {
  id: string;
  status: string;
  kind: string;
  trig_situation: string;
  body_mechanism: string;
  body_unlock: string;
  body_verification: string;
  stats_times_retrieved: number;
  stats_times_helpful: number;
  stats_times_counterproductive: number;
  qual_wilson_lb: number;
  created_at: number;
}

type JunkCategory =
  | "reusable"
  | "junk-template"
  | "junk-release-noise"
  | "junk-self-ref"
  | "junk-empty";

interface Classification {
  category: JunkCategory;
  reasons: string[];
}

const TEMPLATE_VERIFY = /^\s*re-run the failing step or relevant tests/i;
const RELEASE_NOISE = [
  /tracebase-ai@\d/i,
  /git pushed\b/i,
  /\d+\s+tests?\s+pass/i,
  /pushed\s+`[a-f0-9]{6,}/i,
  /^\s*##?\s*summary\s*[—-]/im,
];

function stripMarkdown(s: string): string {
  return s
    .replace(/^\s*#+\s*/gm, "")
    .replace(/`+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s: string): Set<string> {
  return new Set(
    stripMarkdown(s)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function classify(row: BlockRow): Classification {
  const reasons: string[] = [];
  const sit = stripMarkdown(row.trig_situation);
  const mech = stripMarkdown(row.body_mechanism);
  const unlock = stripMarkdown(row.body_unlock);
  const verify = (row.body_verification ?? "").trim();

  // 1. Template verify with no real verify content
  if (TEMPLATE_VERIFY.test(verify)) reasons.push("template verify boilerplate");

  // 2. Release noise (announcement content stored as a pattern)
  const corpus = `${sit} ${mech} ${unlock}`.toLowerCase();
  for (const re of RELEASE_NOISE) {
    if (re.test(corpus)) {
      reasons.push(`release-noise ${re.source}`);
      break;
    }
  }

  // 3. Self-referential mechanism
  const sim = jaccard(tokens(row.trig_situation), tokens(row.body_mechanism));
  if (sim >= 0.8) reasons.push(`self-ref jaccard=${sim.toFixed(2)}`);

  // 4. Empty / heading-only
  if (sit.length < 30) reasons.push(`situation thin (${sit.length}c)`);
  if (mech.length < 30) reasons.push(`mechanism thin (${mech.length}c)`);
  if (unlock.length < 30) reasons.push(`unlock thin (${unlock.length}c)`);

  // Pick worst category for the headline label, but keep all reasons.
  let category: JunkCategory = "reusable";
  if (reasons.some((r) => r.startsWith("self-ref"))) category = "junk-self-ref";
  else if (reasons.some((r) => r.startsWith("release-noise"))) category = "junk-release-noise";
  else if (reasons.some((r) => r.includes("thin"))) category = "junk-empty";
  else if (reasons.includes("template verify boilerplate")) category = "junk-template";

  return { category, reasons };
}

function preview(s: string, n = 80): string {
  const flat = stripMarkdown(s);
  return flat.length <= n ? flat : flat.slice(0, n - 1) + "…";
}

function ageDays(created_at: number): string {
  const ms = Date.now() - created_at;
  return `${Math.round(ms / 86_400_000)}d`;
}

function main(): void {
  const argPath = process.argv[2];
  const dbPath = resolve(argPath ?? "./.tracebase/memory.db");
  if (!existsSync(dbPath)) {
    console.error(`No DB at ${dbPath}`);
    process.exit(1);
  }

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  // Read-only: don't mutate WAL state of a live store.

  const rows = db
    .prepare(
      `SELECT id, status, kind,
              trig_situation, body_mechanism, body_unlock, body_verification,
              stats_times_retrieved, stats_times_helpful, stats_times_counterproductive,
              qual_wilson_lb, created_at
       FROM reasoning_blocks
       ORDER BY created_at ASC`,
    )
    .all() as BlockRow[];

  const total = rows.length;
  const byCategory: Record<JunkCategory, number> = {
    reusable: 0,
    "junk-template": 0,
    "junk-release-noise": 0,
    "junk-self-ref": 0,
    "junk-empty": 0,
  };
  const byStatus: Record<string, number> = {};
  const byKind: Record<string, number> = {};

  console.log(`Junk-rate diagnostic — ${dbPath}`);
  console.log(`Total reasoning_blocks: ${total}\n`);

  console.log("Per-block:");
  console.log(
    "id".padEnd(10) +
      " | " +
      "status".padEnd(9) +
      " | " +
      "kind".padEnd(8) +
      " | " +
      "age".padEnd(5) +
      " | " +
      "wlb".padEnd(5) +
      " | " +
      "category".padEnd(20) +
      " | " +
      "situation",
  );
  console.log("-".repeat(150));

  for (const row of rows) {
    const cls = classify(row);
    byCategory[cls.category] = (byCategory[cls.category] ?? 0) + 1;
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;

    const idShort = row.id.slice(0, 8);
    console.log(
      idShort.padEnd(10) +
        " | " +
        row.status.padEnd(9) +
        " | " +
        row.kind.padEnd(8) +
        " | " +
        ageDays(row.created_at).padEnd(5) +
        " | " +
        row.qual_wilson_lb.toFixed(2).padEnd(5) +
        " | " +
        cls.category.padEnd(20) +
        " | " +
        preview(row.trig_situation, 60),
    );
    if (cls.reasons.length > 0) {
      console.log(`           reasons: ${cls.reasons.join("; ")}`);
    }
  }

  console.log("\n=== Aggregates ===");
  console.log(`By status: ${JSON.stringify(byStatus)}`);
  console.log(`By kind: ${JSON.stringify(byKind)}`);
  console.log("By category:");
  for (const [cat, n] of Object.entries(byCategory)) {
    const pct = total > 0 ? ((n / total) * 100).toFixed(1) : "0.0";
    console.log(`  ${cat.padEnd(22)} ${String(n).padStart(3)}  (${pct}%)`);
  }

  const junk =
    byCategory["junk-template"] +
    byCategory["junk-release-noise"] +
    byCategory["junk-self-ref"] +
    byCategory["junk-empty"];
  const junkPct = total > 0 ? ((junk / total) * 100).toFixed(1) : "0.0";
  console.log(`\nOverall junk-rate: ${junk}/${total} = ${junkPct}%`);

  db.close();
}

main();
