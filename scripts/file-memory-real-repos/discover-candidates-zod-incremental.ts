#!/usr/bin/env tsx
/**
 * Incremental Box 4b candidate discovery — zod only.
 *
 * Why a separate script:
 *   The original `discover-candidates.ts` hardcodes the v2 VERIFIED set
 *   (6 repos: axios, mathjs, black, rich, prettier, pytest) and runs
 *   full discovery across all of them. v3 of repo-pool.json (commit
 *   eb48ec5) excludes axios/prettier/pytest (setup or runtime failures
 *   on WSL Phase 2A) and adds colinhacks/zod. Per operator directive
 *   ("run candidate discovery only for newly VERIFIED repos not yet in
 *   candidate-pool: zod definitely"), we run discovery for zod ONLY and
 *   merge into the existing candidate-pool.json — we do NOT re-run
 *   discovery for mathjs/black/rich (their pool entries are stable;
 *   their clones haven't moved).
 *
 * What this script does:
 *   1. Loads existing candidate-pool.json (v2-aligned, 111 candidates
 *      across 6 repos including the now-excluded axios/prettier/pytest).
 *   2. Runs zod discovery using the same deterministic git-metadata
 *      filter as discover-candidates.ts (first-parent log; fix/bug-shape
 *      titles; per-commit git diff --numstat; classify test vs source;
 *      keep candidates with ≥1 test file touched AND 0 < source LOC ≤ 20).
 *   3. MARKS the v3-excluded repo entries (axios/prettier/pytest) with
 *      `selectable_after_v3_amendment: false` and an `excluded_in_v3_reason`
 *      so their data is preserved as audit trail but they are clearly
 *      ineligible for box 5 task selection.
 *   4. ADDS zod candidates/exclusions/stats with selectable: true.
 *   5. Updates source_pool reference to eb48ec5 and adds a
 *      v3_transition_note explaining what changed.
 *
 * NO installs, NO test runs, NO API. Pure local git-metadata.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..", "..");
const REPOS_DIR = join(ROOT, "bench-runs", "file-memory-real-repos", "repos");
const POOL_PATH = join(ROOT, "bench-runs", "file-memory-real-repos", "candidate-pool.json");

const ZOD_CFG = {
  name: "colinhacks/zod",
  dir: "colinhacks-zod",
  sourceExts: ["ts"],
  // zod monorepo: tests are in `packages/zod/src/**/tests/` and `.test.ts` files
  // throughout `packages/{docs,resolution,integration}/`. `__tests__/` covers
  // jest-style layouts if any package adopts them.
  testPatterns: [/\.test\./, /\/tests\//, /\.spec\./, /\/__tests__\//],
};

const V3_EXCLUDED = {
  "axios/axios": {
    exclusion_reason: "EXCLUDED_SETUP_FAILED on WSL Phase 2A (vitest 4 internal failure during run)",
    repo_pool_amendment: "v3 — commit eb48ec5",
  },
  "prettier/prettier": {
    exclusion_reason: "EXCLUDED_TEST_TIMEOUT on WSL Phase 2A (jest suite exceeded ≤5min pre-reg cap at 307s)",
    repo_pool_amendment: "v3 — commit eb48ec5",
  },
  "pytest-dev/pytest": {
    exclusion_reason: "EXCLUDED_SETUP_FAILED on WSL Phase 2A (pip ResolutionImpossible: editable dev pytest 0.1.dev label doesn't satisfy pytest-mock pins)",
    repo_pool_amendment: "v3 — commit eb48ec5",
  },
} as const;

let DEBUG_FIRST = true;
function git(cwd: string, args: string[]): string {
  try {
    const out = execSync(`git ${args.join(" ")}`, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
    }).trim();
    if (DEBUG_FIRST && args[0] === "diff") {
      DEBUG_FIRST = false;
      console.error(`[DEBUG diff] cwd=${cwd}`);
      console.error(`[DEBUG diff] args=${JSON.stringify(args)}`);
      console.error(`[DEBUG diff] out.length=${out.length}, first 120: ${JSON.stringify(out.slice(0, 120))}`);
    }
    return out;
  } catch (e: any) {
    if (args[0] === "diff") {
      console.error(`[git diff THREW] cwd=${cwd} args=${JSON.stringify(args)}`);
      console.error(`  status=${e.status} stderr=${(e.stderr?.toString?.() ?? "").slice(0, 300)}`);
    }
    return "";
  }
}

function classifyFiles(paths: string[]) {
  const test: string[] = [];
  const source: string[] = [];
  const other: string[] = [];
  for (const p of paths) {
    const ext = (p.split(".").pop() ?? "").toLowerCase();
    const isTest = ZOD_CFG.testPatterns.some((re) => re.test(p));
    const isSourceExt = ZOD_CFG.sourceExts.includes(ext);
    if (isTest) test.push(p);
    else if (isSourceExt) source.push(p);
    else other.push(p);
  }
  return { test, source, other };
}

function discoverZod(): {
  candidates: any[];
  exclusions: any[];
  raw_total: number;
} {
  const dir = join(REPOS_DIR, ZOD_CFG.dir);
  if (!existsSync(dir)) {
    console.error(`MISSING ${dir} — clone zod first`);
    process.exit(1);
  }

  const twoYearsAgo = new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);

  const raw = git(dir, [
    "log",
    "--first-parent",
    `--since=${twoYearsAgo}`,
    "--grep=fix",
    "--grep=bug",
    "-i",
    "--format=%H%x09%s",
  ]);
  const lines = raw.split("\n").filter((l) => l.includes("\t"));
  const all = lines.map((l) => {
    const idx = l.indexOf("\t");
    return { sha: l.slice(0, idx), title: l.slice(idx + 1) };
  });

  // Same 60-cap as discover-candidates.ts to stay symmetric.
  const head = all.slice(0, 60);
  const candidates: any[] = [];
  const exclusions: any[] = [];

  for (const c of head) {
    // ~1 not ^ — Windows cmd.exe consumes the caret as escape char.
    const parent = git(dir, ["rev-parse", `${c.sha}~1`]);
    if (!parent) {
      exclusions.push({
        repo: ZOD_CFG.name,
        pr_commit: c.sha,
        title: c.title,
        reason: "no_parent_commit",
        metadata: {},
      });
      continue;
    }

    const numstat = git(dir, ["diff", "--numstat", parent, c.sha]);
    if (!numstat) {
      exclusions.push({
        repo: ZOD_CFG.name,
        pr_commit: c.sha,
        title: c.title,
        reason: "empty_or_no_diff",
        metadata: { parent },
      });
      continue;
    }

    const fileEntries = numstat
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => {
        const parts = l.split("\t");
        if (parts.length < 3) return null;
        return {
          added: parts[0] === "-" ? 0 : parseInt(parts[0]!, 10) || 0,
          removed: parts[1] === "-" ? 0 : parseInt(parts[1]!, 10) || 0,
          path: parts.slice(2).join("\t"),
        };
      })
      .filter((x): x is { added: number; removed: number; path: string } => x !== null);

    const paths = fileEntries.map((f) => f.path);
    const { test, source, other } = classifyFiles(paths);

    let srcAdded = 0, srcRemoved = 0;
    for (const f of fileEntries) {
      if (source.includes(f.path)) {
        srcAdded += f.added;
        srcRemoved += f.removed;
      }
    }
    const srcNet = srcAdded + srcRemoved;
    const hasTest = test.length > 0;
    const sourceLeqTwenty = srcNet > 0 && srcNet <= 20;

    if (!hasTest || !sourceLeqTwenty) {
      exclusions.push({
        repo: ZOD_CFG.name,
        pr_commit: c.sha,
        title: c.title,
        reason: !hasTest
          ? "no_test_files_touched"
          : srcNet === 0
            ? "no_source_files_touched"
            : "source_loc_gt_20",
        metadata: {
          changed_files_total: fileEntries.length,
          test_files_touched_count: test.length,
          source_files_touched_count: source.length,
          source_loc_added: srcAdded,
          source_loc_removed: srcRemoved,
          source_loc_net: srcNet,
        },
      });
      continue;
    }

    candidates.push({
      repo: ZOD_CFG.name,
      pr_commit: c.sha,
      parent_commit: parent,
      title: c.title,
      changed_files_total: fileEntries.length,
      test_files_touched: test,
      source_files_touched: source,
      other_files_touched_count: other.length,
      other_files_touched_sample: other.slice(0, 5),
      source_loc_added: srcAdded,
      source_loc_removed: srcRemoved,
      source_loc_net: srcNet,
      passes_pre_reg_task_criteria: {
        real_merged_bug_fix_pr: true,
        has_test_file_changes: true,
        source_diff_le_20_lines: true,
        no_external_infra: "unknown — deferred to box 4c",
        parent_passes_with_test_diff: "unknown — deferred to box 4c",
      },
      candidate_reason:
        `fix/bug-shape title; touches ${test.length} test file(s); ${srcNet} source LOC (≤20); ${source.length} source file(s) touched`,
      discovered_status: "DISCOVERED",
    });
  }

  return { candidates, exclusions, raw_total: all.length };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log("Incremental zod candidate discovery (box 4b, v3 amendment)");
console.log("");

if (!existsSync(POOL_PATH)) {
  console.error(`MISSING ${POOL_PATH} — expected existing v2 pool to merge into`);
  process.exit(1);
}

const existing = JSON.parse(readFileSync(POOL_PATH, "utf-8"));

console.log("==== colinhacks/zod ====");
const { candidates: zodCandidates, exclusions: zodExclusions, raw_total: zodRaw } = discoverZod();
const zodExclusionBreakdown: Record<string, number> = {};
for (const e of zodExclusions) {
  zodExclusionBreakdown[e.reason] = (zodExclusionBreakdown[e.reason] ?? 0) + 1;
}
console.log(`  raw bug-fix titles in 24mo: ${zodRaw}`);
console.log(`  → candidates passing filter: ${zodCandidates.length}`);
console.log(`  → exclusions during discovery: ${zodExclusions.length}`);
console.log(`  exclusion breakdown:`, zodExclusionBreakdown);
if (zodCandidates.length > 0) {
  console.log(`  sample candidates (first 3):`);
  for (const c of zodCandidates.slice(0, 3)) {
    console.log(
      `    - ${c.pr_commit.slice(0, 8)} [+${c.source_loc_added}/-${c.source_loc_removed} src LOC, ${c.test_files_touched.length} tests] ${c.title.slice(0, 80)}`,
    );
  }
}
console.log("");

// Merge: per_repo_stats gets the new zod entry; candidates/exclusions
// get appended; existing repos keep their data; v3-excluded repos get
// marked ineligible.
const mergedPerRepo = { ...(existing.per_repo_stats ?? {}) };
mergedPerRepo[ZOD_CFG.name] = {
  raw_bug_fix_titles_in_24mo: zodRaw,
  candidates: zodCandidates.length,
  excluded: zodExclusions.length,
  sample_titles: zodCandidates.slice(0, 5).map(
    (c) => `${c.pr_commit.slice(0, 8)} [src +${c.source_loc_added}/-${c.source_loc_removed}] ${c.title.slice(0, 100)}`,
  ),
  exclusion_reason_breakdown: zodExclusionBreakdown,
  selectable_after_v3_amendment: true,
  added_in_amendment: "v3 — commit eb48ec5",
};

// Mark v3-excluded repos as ineligible (preserve their data for audit).
for (const [repoName, info] of Object.entries(V3_EXCLUDED)) {
  if (mergedPerRepo[repoName]) {
    mergedPerRepo[repoName] = {
      ...mergedPerRepo[repoName],
      selectable_after_v3_amendment: false,
      excluded_in_v3_reason: info.exclusion_reason,
      repo_pool_amendment: info.repo_pool_amendment,
    };
  }
}

// Mark the still-selectable v2-survivors explicitly.
for (const repoName of ["josdejong/mathjs", "psf/black", "Textualize/rich"]) {
  if (mergedPerRepo[repoName]) {
    mergedPerRepo[repoName] = {
      ...mergedPerRepo[repoName],
      selectable_after_v3_amendment: true,
    };
  }
}

const mergedCandidates = [...(existing.candidates ?? []), ...zodCandidates];
const mergedExclusions = [...(existing.exclusions_during_discovery ?? []), ...zodExclusions];

const selectableCandidates = mergedCandidates.filter(
  (c) => mergedPerRepo[c.repo]?.selectable_after_v3_amendment !== false,
);

const merged = {
  ...existing,
  source_pool: "bench-runs/file-memory-real-repos/repo-pool.json (v3 amendment, eb48ec5)",
  discovered_at: existing.discovered_at, // keep original date for mathjs/black/rich/etc.
  zod_discovered_at: new Date().toISOString().slice(0, 10),
  v3_transition_note:
    "Original discovery on 2026-05-27 covered the v2 VERIFIED set (axios, mathjs, black, rich, prettier, pytest). After WSL Phase 2A (commit eb48ec5), axios/prettier/pytest are EXCLUDED from the v3 VERIFIED set — their candidates remain in this file for audit but are marked `selectable_after_v3_amendment: false` and MUST be skipped by box 5 task selection. zod was added in v3 and discovered incrementally (see scripts/file-memory-real-repos/discover-candidates-zod-incremental.ts).",
  per_repo_stats: mergedPerRepo,
  totals: {
    ...existing.totals,
    total_candidates_all: mergedCandidates.length,
    total_candidates_selectable_after_v3: selectableCandidates.length,
    total_exclusions_during_discovery: mergedExclusions.length,
    raw_bug_fix_titles_in_24mo_summed_selectable: Object.entries(mergedPerRepo)
      .filter(([_, v]: [string, any]) => v.selectable_after_v3_amendment !== false)
      .reduce((a, [_, v]: [string, any]) => a + (v.raw_bug_fix_titles_in_24mo ?? 0), 0),
    target_n_total_pre_reg: "15-25 task pairs",
    target_pool_minimum_2x: 30,
    pool_meets_2x_target_with_selectable_only: selectableCandidates.length >= 30,
    target_per_repo_minimum: 10,
    per_repo_meets_10_minimum_selectable_only: Object.fromEntries(
      Object.entries(mergedPerRepo)
        .filter(([_, v]: [string, any]) => v.selectable_after_v3_amendment !== false)
        .map(([k, v]: [string, any]) => [k, v.candidates >= 10]),
    ),
  },
  candidates: mergedCandidates,
  exclusions_during_discovery: mergedExclusions,
};

writeFileSync(POOL_PATH, JSON.stringify(merged, null, 2) + "\n");

console.log("=== SUMMARY ===");
console.log(`Existing candidates carried over: ${existing.candidates?.length ?? 0}`);
console.log(`zod candidates added: ${zodCandidates.length}`);
console.log(`zod exclusions added: ${zodExclusions.length}`);
console.log(`Total candidates in pool (all): ${mergedCandidates.length}`);
console.log(`Total candidates SELECTABLE after v3 amendment: ${selectableCandidates.length}`);
console.log(`Pool meets ≥30 selectable target: ${selectableCandidates.length >= 30 ? "YES" : "NO"}`);
console.log(`Wrote ${POOL_PATH}`);
