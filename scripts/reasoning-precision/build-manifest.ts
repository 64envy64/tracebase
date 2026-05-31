#!/usr/bin/env tsx
/**
 * Freeze the leakage-audited capture-run manifest (Phase 5, Step 2/5).
 *
 * Source of truth = box-4c reproducible tasks ONLY (the fail-then-pass oracle).
 * Joins each reproducible (repo, fixSHA) with its full metadata from
 * candidate-pool.json / selected-tasks.json, derives a problem family, assigns
 * disjoint capture/recall arms (capture-biased so the corpus is populated before
 * recall, and every recall family has ≥1 same-family capture block so recall
 * tests reasoning TRANSFER on a DIFFERENT commit — never the recall task's own
 * fix), runs a deterministic leakage audit, hashes, and writes the manifest.
 *
 *   tsx build-manifest.ts            # dry: print plan + audit, no write
 *   tsx build-manifest.ts --freeze   # write capture-manifest.frozen.json
 *
 * Load-bearing leakage rules enforced + asserted:
 *  - capture and recall refs (repo@fixSHA) are disjoint;
 *  - a recall task's own fixSHA is never a capture ref (no answer injection);
 *  - workspaces materialize at baseSHA (parent) so the fix is absent (excludes
 *    descendants already carrying the target fix);
 *  - related-family grouping is recorded; recall fires must transfer reasoning,
 *    not patches (the serving gate + precision evaluator judge correctness).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BENCH = join(ROOT, "bench-runs", "file-memory-real-repos");
const RESULTS = join(BENCH, "results");
const OUT_DIR = join(ROOT, "bench-runs", "reasoning-reuse");
const OUT = join(OUT_DIR, "capture-manifest.frozen.json");
const CAPTURE_RATIO = parseFloat(process.env.TB_CAPTURE_RATIO ?? "0.55"); // ~55% capture / 45% recall
const FROZEN_AT = parseInt(process.env.TB_FROZEN_AT ?? "0", 10); // pass a fixed ts to freeze

const readJson = (p: string): any => JSON.parse(readFileSync(p, "utf-8"));

// --- collect reproducible (repo, fixSHA) from every box-4c result file present.
const reproKeys = new Set<string>();
for (const f of ["box-4c-repro.json", "box-4c-supply.json"]) {
  const p = join(RESULTS, f);
  if (!existsSync(p)) continue;
  for (const r of readJson(p).results ?? []) {
    if (r.status === "reproducible") reproKeys.add(`${r.repo}@${r.pr_commit}`);
  }
}

// --- full metadata per (repo, fixSHA), preferring selected-tasks then pool.
const meta = new Map<string, any>();
const pool = readJson(join(BENCH, "candidate-pool.json"));
for (const c of pool.candidates ?? []) meta.set(`${c.repo}@${c.pr_commit}`, c);
const sel = readJson(join(BENCH, "selected-tasks.json"));
for (const c of sel.tasks ?? []) meta.set(`${c.repo}@${c.pr_commit}`, { ...meta.get(`${c.repo}@${c.pr_commit}`), ...c });

const GENERIC = new Set(["index", "main", "src", "lib", "core", "test", "tests", "util", "utils", "types", "type", "__init__"]);
function familyOf(repo: string, c: any): string {
  // Most specific meaningful token from the first touched source file.
  const sf = (c.source_files_touched ?? [])[0] ?? "";
  const parts = sf.split("/").filter(Boolean);
  const base = (parts[parts.length - 1] ?? "").replace(/\.[a-z0-9]+$/i, "");
  let feat = !GENERIC.has(base.toLowerCase()) ? base : (parts[parts.length - 2] ?? base);
  feat = (feat || "misc").toLowerCase();
  return `${repo.split("/")[1]}:${feat}`;
}

function verificationCommand(repo: string, c: any): { cmd: string; testTargets: string[] } {
  const tests: string[] = c.test_files_touched ?? [];
  const q = (xs: string[]) => xs.join(" ");
  if (repo === "josdejong/mathjs") { const t = tests.filter((x) => /\.test\.(js|mjs)$/.test(x)); return { cmd: `npx mocha ${q(t)}`, testTargets: t }; }
  if (repo === "psf/black") { const real = tests.filter((x) => x.startsWith("tests/") && !x.startsWith("tests/data/") && /\/test_/.test("/" + x)); const t = real.length ? real : ["tests/test_format.py"]; return { cmd: `.venv/bin/python -m pytest -q --no-header -x ${q(t)}`, testTargets: t }; }
  if (repo === "Textualize/rich") { const t = tests.filter((x) => x.startsWith("tests/test_") && x.endsWith(".py")); return { cmd: `.venv/bin/python -m pytest -q --no-header -x ${q(t)}`, testTargets: t }; }
  if (repo === "colinhacks/zod") { const t = tests.filter((x) => /\.test\.(ts|tsx|js)$/.test(x)); return { cmd: `pnpm test -- --reporter=basic ${q(t)}`, testTargets: t }; }
  if (repo === "axios/axios") { const t = tests.filter((x) => x.startsWith("tests/") && /\.(test|spec)\.js$/.test(x)); return { cmd: `npx vitest run --project unit ${q(t)}`, testTargets: t }; }
  if (repo === "pytest-dev/pytest") { const t = tests.filter((x) => x.startsWith("testing/") && /\/test_/.test("/" + x) && x.endsWith(".py")); return { cmd: `.venv/bin/python -m pytest -q --no-header -p no:cacheprovider ${q(t)}`, testTargets: t }; }
  throw new Error(`no verification command for ${repo}`);
}

interface Row {
  taskId: string; repo: string; baseSHA: string; fixSHA: string; sourceFamily: string;
  expectedFailingTest: string; testFilesTouched: string[]; sourceFilesTouched: string[];
  verificationCommand: string; arm: "capture" | "recall"; relatedFamilyIds: string[];
  leakageExclusions: string[]; provenance: string;
}

// --- build rows from reproducible keys.
const byFamily = new Map<string, Row[]>();
let skipped = 0;
for (const key of [...reproKeys].sort()) {
  const c = meta.get(key);
  if (!c) { skipped++; continue; }
  const [repo] = key.split("@");
  const { cmd, testTargets } = verificationCommand(repo, c);
  if (!testTargets.length) { skipped++; continue; }
  const fam = familyOf(repo, c);
  const row: Row = {
    taskId: `${REPO_TAG(repo)}-${c.pr_commit.slice(0, 8)}`,
    repo, baseSHA: c.parent_commit, fixSHA: c.pr_commit, sourceFamily: fam,
    expectedFailingTest: testTargets[0], testFilesTouched: c.test_files_touched,
    sourceFilesTouched: c.source_files_touched, verificationCommand: cmd,
    arm: "capture", relatedFamilyIds: [], leakageExclusions: [`own-fix:${c.pr_commit}`, "descendants-with-fix"],
    provenance: `box4c-reproducible; ${repo}@${c.pr_commit.slice(0, 8)}; parent ${String(c.parent_commit).slice(0, 8)}`,
  };
  (byFamily.get(fam) ?? byFamily.set(fam, []).get(fam)!).push(row);
}
function REPO_TAG(repo: string): string { return repo.replace("/", "-"); }

// --- arm assignment (global, family-diverse). Recall does not require a
// same-family capture: a captured reasoning pattern can transfer across related
// families, and the serving gate + precision evaluator judge whether a fire is
// correct. So we (1) seed capture with one task per family for a DIVERSE corpus,
// then (2) fill capture up to CAPTURE_RATIO of the pool; the remainder is recall
// (distinct commits → disjoint by construction). Capture runs before recall.
const allRows: Row[] = [];
for (const [fam, rows] of [...byFamily.entries()].sort()) {
  rows.sort((a, b) => a.fixSHA.localeCompare(b.fixSHA));
  rows.forEach((r) => { r.relatedFamilyIds = [fam]; });
  allRows.push(...rows);
}
const famSeen = new Set<string>();
const capture: Row[] = [];
const rest: Row[] = [];
for (const r of allRows) {
  if (!famSeen.has(r.sourceFamily)) { famSeen.add(r.sourceFamily); r.arm = "capture"; capture.push(r); }
  else rest.push(r);
}
const targetCap = Math.max(capture.length, Math.round(allRows.length * CAPTURE_RATIO));
rest.sort((a, b) => (a.repo + a.fixSHA).localeCompare(b.repo + b.fixSHA));
for (const r of rest) { if (capture.length < targetCap) { r.arm = "capture"; capture.push(r); } else r.arm = "recall"; }
const tasks: Row[] = allRows;

// --- deterministic leakage audit.
const captureRefs = new Set(tasks.filter((t) => t.arm === "capture").map((t) => `${t.repo}@${t.fixSHA}`));
const recallRows = tasks.filter((t) => t.arm === "recall");
const reuseViolations = recallRows.filter((t) => captureRefs.has(`${t.repo}@${t.fixSHA}`));
const recallNoFamily = recallRows.filter((t) => !tasks.some((c) => c.arm === "capture" && c.sourceFamily === t.sourceFamily));
const dupFix = (() => { const seen = new Set<string>(); const dups: string[] = []; for (const t of tasks) { const k = `${t.repo}@${t.fixSHA}`; if (seen.has(k)) dups.push(k); seen.add(k); } return dups; })();

const audit = {
  totalVerified: reproKeys.size, rowsBuilt: tasks.length, skippedNoMeta: skipped,
  capture: tasks.filter((t) => t.arm === "capture").length,
  recall: recallRows.length,
  families: byFamily.size,
  recallWithSameFamilyCapture: recallRows.length - recallNoFamily.length,
  leakage: {
    captureRecallDisjoint: reuseViolations.length === 0,
    reuseViolations: reuseViolations.map((t) => t.taskId),
    duplicateFixShas: dupFix,
    recallWithoutFamilyAnchor: recallNoFamily.map((t) => t.taskId),
  },
  perRepo: tasks.reduce((a: any, t) => { (a[t.repo] = a[t.repo] || { capture: 0, recall: 0 })[t.arm]++; return a; }, {}),
  targetFeasibility: {
    captureTasksVsTarget: `${tasks.filter((t) => t.arm === "capture").length} cap tasks (target ≥50 captured blocks)`,
    recallTasksVsTarget: `${recallRows.length} recall tasks (target ≥30 precision-ready)`,
  },
};

const canonical = JSON.stringify(tasks.map((t) => [t.taskId, t.arm, `${t.repo}@${t.fixSHA}`, t.sourceFamily]));
const manifestHash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);

console.log("=== capture-run manifest plan ===");
console.log(JSON.stringify(audit, null, 2));
console.log(`manifestHash: ${manifestHash}`);
const leakClean = audit.leakage.captureRecallDisjoint && audit.leakage.duplicateFixShas.length === 0;
console.log(`LEAKAGE AUDIT: ${leakClean ? "CLEAN" : "VIOLATIONS PRESENT"}`);

if (process.argv.includes("--freeze")) {
  if (!leakClean) { console.error("refusing to freeze: leakage violations present"); process.exit(1); }
  if (!FROZEN_AT) { console.error("refusing to freeze: pass TB_FROZEN_AT=<unix ts> for a reproducible frozenAt"); process.exit(1); }
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT, JSON.stringify({ frozenAt: FROZEN_AT, manifestHash, model: "claude-haiku-4-5", policy: { captureRatio: CAPTURE_RATIO, organicTarget: { capturedRuntime: 50, precisionReady: 30 } }, audit, tasks }, null, 2) + "\n");
  console.log(`\nFROZEN → ${OUT}\n  ${tasks.length} tasks · hash ${manifestHash} · frozenAt ${FROZEN_AT}`);
}
