#!/usr/bin/env tsx
/**
 * Box 4b candidate discovery for file-memory real-repos bench
 * (PRE-REGISTRATION-REAL-REPOS.md).
 *
 * For each VERIFIED repo in repo-pool.json:
 *   - Walk mainline (first-parent) for `fix`/`bug`-shape commits in the
 *     last 24 months (git --grep, case-insensitive).
 *   - For each candidate, compute the diff vs first-parent.
 *   - Classify changed files (test vs source vs other) using per-repo
 *     path heuristics.
 *   - Keep candidates where: ≥1 test file touched AND 0 < source LOC ≤ 20.
 *   - Record all other candidates in exclusions_during_discovery with reason.
 *
 * NO installs, NO patch application, NO test runs. Pure git-metadata.
 *
 * Output: bench-runs/file-memory-real-repos/candidate-pool.json
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..", "..");
const REPOS_DIR = join(ROOT, "bench-runs", "file-memory-real-repos", "repos");
const OUTPUT = join(ROOT, "bench-runs", "file-memory-real-repos", "candidate-pool.json");

interface RepoCfg {
  name: string;
  dir: string;
  sourceExts: string[];
  testPatterns: RegExp[];
  notes?: string;
}

// 6 VERIFIED entries from repo-pool.json (98dfae1).
const VERIFIED_REPOS: RepoCfg[] = [
  {
    name: "axios/axios",
    dir: "axios-axios",
    sourceExts: ["js", "mjs", "cjs"],
    testPatterns: [/^test\//, /\.test\./, /\.spec\./],
  },
  {
    name: "josdejong/mathjs",
    dir: "josdejong-mathjs",
    sourceExts: ["js", "mjs"],
    testPatterns: [/^test\//, /\.test\./],
  },
  {
    name: "psf/black",
    dir: "psf-black",
    sourceExts: ["py"],
    testPatterns: [/^tests\//, /\/test_/, /^test_/, /\/conftest\.py$/, /^conftest\.py$/],
  },
  {
    name: "Textualize/rich",
    dir: "Textualize-rich",
    sourceExts: ["py"],
    testPatterns: [/^tests\//, /\/test_/, /^test_/, /\/conftest\.py$/, /^conftest\.py$/],
  },
  {
    name: "prettier/prettier",
    dir: "prettier-prettier",
    sourceExts: ["js", "mjs", "cjs"],
    testPatterns: [/^tests\//, /\.test\./, /\.spec\./, /\/__tests__\//],
  },
  {
    name: "pytest-dev/pytest",
    dir: "pytest-dev-pytest",
    sourceExts: ["py"],
    testPatterns: [/^testing\//, /^tests\//, /\/test_/, /^test_/, /\/conftest\.py$/, /^conftest\.py$/],
    notes: "pytest tests itself — source is src/_pytest/ and tests are in testing/",
  },
];

interface Candidate {
  repo: string;
  pr_commit: string;
  parent_commit: string;
  title: string;
  changed_files_total: number;
  test_files_touched: string[];
  source_files_touched: string[];
  other_files_touched_count: number;
  other_files_touched_sample: string[];
  source_loc_added: number;
  source_loc_removed: number;
  source_loc_net: number;
  passes_pre_reg_task_criteria: {
    real_merged_bug_fix_pr: boolean;
    has_test_file_changes: boolean;
    source_diff_le_20_lines: boolean;
    no_external_infra: "unknown — deferred to box 4c";
    parent_passes_with_test_diff: "unknown — deferred to box 4c";
  };
  candidate_reason: string;
  discovered_status: "DISCOVERED";
}

interface Exclusion {
  repo: string;
  pr_commit: string;
  title: string;
  reason: string;
  metadata: Record<string, unknown>;
}

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

function classifyFiles(paths: string[], cfg: RepoCfg) {
  const test: string[] = [];
  const source: string[] = [];
  const other: string[] = [];
  for (const p of paths) {
    const ext = (p.split(".").pop() ?? "").toLowerCase();
    const isTest = cfg.testPatterns.some((re) => re.test(p));
    const isSourceExt = cfg.sourceExts.includes(ext);
    if (isTest) test.push(p);
    else if (isSourceExt) source.push(p);
    else other.push(p);
  }
  return { test, source, other };
}

function discoverFromRepo(cfg: RepoCfg): { candidates: Candidate[]; exclusions: Exclusion[]; raw_total: number } {
  const dir = join(REPOS_DIR, cfg.dir);
  if (!existsSync(dir)) {
    console.error(`MISSING ${dir}`);
    return { candidates: [], exclusions: [], raw_total: 0 };
  }

  const twoYearsAgo = new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);

  // Use newline as field sep to handle quotes/pipes in commit titles.
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

  // Cap exploration: take top 60 candidates, then filter.
  const head = all.slice(0, 60);
  const candidates: Candidate[] = [];
  const exclusions: Exclusion[] = [];

  for (const c of head) {
    // ~1 not ^ — Windows cmd.exe consumes the caret as escape char,
    // making `git rev-parse <sha>^` resolve to <sha> itself rather
    // than the parent.
    const parent = git(dir, ["rev-parse", `${c.sha}~1`]);
    if (!parent) {
      exclusions.push({
        repo: cfg.name,
        pr_commit: c.sha,
        title: c.title,
        reason: "no_parent_commit",
        metadata: {},
      });
      continue;
    }

    // Use `git diff` to handle both squash + merge commits uniformly.
    const numstat = git(dir, ["diff", "--numstat", parent, c.sha]);
    if (!numstat) {
      exclusions.push({
        repo: cfg.name,
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
          path: parts.slice(2).join("\t"), // handle rename ' => ' edge cases
        };
      })
      .filter((x): x is { added: number; removed: number; path: string } => x !== null);

    const paths = fileEntries.map((f) => f.path);
    const { test, source, other } = classifyFiles(paths, cfg);

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
        repo: cfg.name,
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
      repo: cfg.name,
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

console.log("Discovering candidates for box 4b of PRE-REGISTRATION-REAL-REPOS.md");
console.log("");

const allCandidates: Candidate[] = [];
const allExclusions: Exclusion[] = [];
const perRepoStats: Record<
  string,
  {
    raw_bug_fix_titles_in_24mo: number;
    candidates: number;
    excluded: number;
    sample_titles: string[];
    exclusion_reason_breakdown: Record<string, number>;
  }
> = {};

for (const cfg of VERIFIED_REPOS) {
  console.log(`==== ${cfg.name} ====`);
  const { candidates, exclusions, raw_total } = discoverFromRepo(cfg);
  const exclusionBreakdown: Record<string, number> = {};
  for (const e of exclusions) {
    exclusionBreakdown[e.reason] = (exclusionBreakdown[e.reason] ?? 0) + 1;
  }
  console.log(`  raw bug-fix titles in 24mo: ${raw_total}`);
  console.log(`  → candidates passing filter: ${candidates.length}`);
  console.log(`  → exclusions during discovery: ${exclusions.length}`);
  console.log(`  exclusion breakdown:`, exclusionBreakdown);
  if (candidates.length > 0) {
    console.log(`  sample candidates (first 3):`);
    for (const c of candidates.slice(0, 3)) {
      console.log(
        `    - ${c.pr_commit.slice(0, 8)} [+${c.source_loc_added}/-${c.source_loc_removed} src LOC, ${c.test_files_touched.length} tests] ${c.title.slice(0, 80)}`,
      );
    }
  }
  console.log("");
  allCandidates.push(...candidates);
  allExclusions.push(...exclusions);
  perRepoStats[cfg.name] = {
    raw_bug_fix_titles_in_24mo: raw_total,
    candidates: candidates.length,
    excluded: exclusions.length,
    sample_titles: candidates.slice(0, 5).map(
      (c) => `${c.pr_commit.slice(0, 8)} [src +${c.source_loc_added}/-${c.source_loc_removed}] ${c.title.slice(0, 100)}`,
    ),
    exclusion_reason_breakdown: exclusionBreakdown,
  };
}

const output = {
  version: "tracebase 0.9.x",
  pre_registration: "bench-runs/file-memory/PRE-REGISTRATION-REAL-REPOS.md",
  source_pool: "bench-runs/file-memory-real-repos/repo-pool.json (post-amendment, 98dfae1)",
  discovered_at: new Date().toISOString().slice(0, 10),
  validation_status:
    "DISCOVERY ONLY — candidates were filtered by deterministic git-metadata criteria (title fix/bug-shape; touches test files; source-LOC > 0 and ≤ 20). NONE has been reproducibility-checked yet (box 4c). Per pre-reg §'Selection process' steps 2 + 4, box 4c MUST run the three-part reproducibility-only baseline check (parent + test-diff fails as expected; source fix passes; install + test command exits cleanly — NO agent run) per candidate before any can become a selected task.",
  discovery_method:
    "git log --first-parent --since='<date>' --grep='fix' --grep='bug' -i on each VERIFIED repo's mainline; per-commit `git diff --numstat <parent> <commit>`; deterministic file classification (test vs source vs other) by per-repo path patterns; filter to has_test_file_changes AND 0 < source_loc_net ≤ 20.",
  filter_criteria_applied: {
    real_merged_bug_fix_pr: "title matches /fix|bug/ (case-insensitive) via --grep",
    has_test_file_changes: "≥1 changed file matches per-repo test patterns",
    source_diff_le_20_lines: "Σ(added + removed) over source-classified files in (0, 20]",
  },
  pre_reg_criteria_NOT_yet_checked: {
    no_external_infra: "deferred to box 4c (test execution inspects for Docker / network / DB needs)",
    parent_passes_with_test_diff_applied: "deferred to box 4c (run-tests on parent + test-diff state)",
    repro_clean_install: "deferred to box 4c (npm/pip install + test runner exits cleanly)",
  },
  per_repo_stats: perRepoStats,
  totals: {
    total_candidates: allCandidates.length,
    total_exclusions_during_discovery: allExclusions.length,
    raw_bug_fix_titles_in_24mo_summed: Object.values(perRepoStats).reduce((a, b) => a + b.raw_bug_fix_titles_in_24mo, 0),
    target_n_total_pre_reg: "15-25 task pairs",
    target_pool_minimum_2x: 30,
    pool_meets_2x_target: allCandidates.length >= 30,
    target_per_repo_minimum: 10,
    per_repo_meets_10_minimum: Object.fromEntries(
      Object.entries(perRepoStats).map(([k, v]) => [k, v.candidates >= 10]),
    ),
  },
  candidates: allCandidates,
  exclusions_during_discovery: allExclusions,
};

mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, JSON.stringify(output, null, 2) + "\n");

console.log("=== SUMMARY ===");
console.log(`Total candidates DISCOVERED: ${allCandidates.length}`);
console.log(`Total exclusions during discovery: ${allExclusions.length}`);
console.log(`Pool meets ≥30 target: ${allCandidates.length >= 30 ? "YES" : "NO"}`);
console.log(`Wrote ${OUTPUT}`);
