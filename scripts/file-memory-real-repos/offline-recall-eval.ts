#!/usr/bin/env tsx
/**
 * $0 OFFLINE recall eval for file_memory — NO agents, NO API, NO test deps.
 *
 * For each of the 25 selected tasks:
 *   1. git-archive the repo at the task's parent_commit into a temp dir
 *      (the exact tree the agent would see — indexing needs no test deps);
 *   2. indexWorkspace() into an in-memory store (heuristic summarizer,
 *      shipped default budget);
 *   3. query = buildRetrievalQuery(task) (the field-derived focused query);
 *   4. recallFiles(query, k=5);
 *   5. record the rank of the first recalled file that is one of the PR's
 *      source_files_touched (the ground-truth fix location).
 *
 * Reports recall@1/@3/@5 for SOURCE files and for SOURCE-or-TEST-adjacent,
 * per repo and overall, plus how often a doc/README was recalled. This is
 * the honest, deterministic measurement we iterate retrieval quality
 * against before spending on any agent run.
 *
 * Usage: tsx scripts/file-memory-real-repos/offline-recall-eval.ts [--k 5] [--tag baseline]
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import { indexWorkspace, recallFiles, isDocClassPath } from "../../src/core/file-indexer.js";
import { REPO_DIR_MAP, buildRetrievalQuery } from "./smoke.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..", "..");
const BENCH = join(ROOT, "bench-runs", "file-memory-real-repos");
const REPOS = join(BENCH, "repos");
const RESULTS = join(BENCH, "results");

const toPosix = (p: string) => p.replace(/\\/g, "/");
const K = (() => { const i = process.argv.indexOf("--k"); return i >= 0 ? parseInt(process.argv[i + 1]!, 10) : 5; })();
const TAG = (() => { const i = process.argv.indexOf("--tag"); return i >= 0 ? process.argv[i + 1]! : "run"; })();

interface TaskEval {
  task_id: string; repo: string; query: string;
  source_files: string[]; test_files: string[];
  recalled: string[];
  source_rank: number | null;       // 1-based rank of first source hit, else null
  adjacent_rank: number | null;     // first source-or-test hit
  any_doc_recalled: boolean;
  indexed_count: number;
  source_indexed: boolean;          // were the source files even indexed?
}

function archiveParent(clone: string, parent: string, dest: string): boolean {
  // tar exits non-zero on Windows when the archive contains symlinks it
  // cannot create (e.g. zod's README.md/.cursorrules symlinks) — but it
  // still extracts every regular file. Those symlinks are docs/config,
  // irrelevant to source recall. So judge success by files-extracted, not
  // by tar's exit status.
  spawnSync(
    "bash", ["-lc", `git -C '${toPosix(clone)}' archive ${parent} | tar -x -C '${toPosix(dest)}'`],
    { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
  );
  const count = spawnSync("bash", ["-lc", `find '${toPosix(dest)}' -type f | wc -l`], { encoding: "utf-8" });
  return parseInt((count.stdout ?? "0").trim(), 10) >= 50;
}

function evalTask(task: any): TaskEval | null {
  const repoDir = REPO_DIR_MAP[task.repo];
  const clone = join(REPOS, repoDir);
  const taskId = `${repoDir}-${task.pr_commit.slice(0, 8)}`;
  if (!existsSync(clone)) { console.error(`  MISSING clone ${clone}`); return null; }

  const tmp = mkdtempSync(join(tmpdir(), "tb-recall-"));
  try {
    if (!archiveParent(clone, task.parent_commit, tmp)) {
      console.error(`  archive failed ${taskId}`); return null;
    }
    const db = new Database(":memory:");
    const store = new BlockStore(db);
    let indexedCount = 0;
    try {
      const outcome = indexWorkspace(store, { root: tmp }); // default budget, heuristic
      indexedCount = outcome.indexedCount;
      const query = buildRetrievalQuery(task);
      const hits = recallFiles(store, { prompt: query, k: K });
      const recalled = hits.map((h) => h.relPath);
      const srcSet = new Set<string>(task.source_files_touched ?? []);
      const testSet = new Set<string>(task.test_files_touched ?? []);
      const srcRank = recalled.findIndex((p) => srcSet.has(p));
      const adjRank = recalled.findIndex((p) => srcSet.has(p) || testSet.has(p));
      // Was the source even indexed (coverage check independent of recall)?
      const srcIndexed = [...srcSet].some((p) =>
        (db.prepare("SELECT 1 FROM indexed_files WHERE rel_path = ?").get(p)) != null);
      return {
        task_id: taskId, repo: task.repo, query,
        source_files: [...srcSet], test_files: [...testSet],
        recalled,
        source_rank: srcRank >= 0 ? srcRank + 1 : null,
        adjacent_rank: adjRank >= 0 ? adjRank + 1 : null,
        any_doc_recalled: recalled.some((p) => isDocClassPath(p)),
        indexed_count: indexedCount,
        source_indexed: srcIndexed,
      };
    } finally { store.close(); }
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 });
  }
}

function main() {
  mkdirSync(RESULTS, { recursive: true });
  const sel = JSON.parse(readFileSync(join(BENCH, "selected-tasks.json"), "utf-8"));
  const tasks: any[] = sel.tasks;
  console.log(`Offline recall eval — ${tasks.length} tasks, k=${K}, tag=${TAG}\n`);

  const evals: TaskEval[] = [];
  for (const task of tasks) {
    const e = evalTask(task);
    if (!e) continue;
    evals.push(e);
    const sr = e.source_rank ?? "—";
    const flag = e.source_rank && e.source_rank <= K ? "HIT" : (e.source_indexed ? "miss" : "NOT-INDEXED");
    console.log(`  ${e.task_id.padEnd(26)} q="${e.query.slice(0, 22).padEnd(22)}" srcRank=${String(sr).padStart(3)} adjRank=${String(e.adjacent_rank ?? "—").padStart(3)} doc=${e.any_doc_recalled ? "Y" : "n"} [${flag}]`);
  }

  function recallAt(n: number, key: "source_rank" | "adjacent_rank"): number {
    const hit = evals.filter((e) => e[key] != null && e[key]! <= n).length;
    return evals.length ? Math.round((hit / evals.length) * 1000) / 10 : 0;
  }
  const byRepo: Record<string, TaskEval[]> = {};
  for (const e of evals) (byRepo[e.repo] ??= []).push(e);

  const summary = {
    tag: TAG, k: K, tasks_evaluated: evals.length,
    overall: {
      "recall@1_source": recallAt(1, "source_rank"),
      "recall@3_source": recallAt(3, "source_rank"),
      "recall@5_source": recallAt(5, "source_rank"),
      "recall@3_adjacent": recallAt(3, "adjacent_rank"),
      "recall@5_adjacent": recallAt(5, "adjacent_rank"),
      "tasks_with_doc_recalled": evals.filter((e) => e.any_doc_recalled).length,
      "tasks_source_not_indexed": evals.filter((e) => !e.source_indexed).length,
    },
    per_repo: Object.fromEntries(Object.entries(byRepo).map(([repo, es]) => {
      const r = (n: number, k: "source_rank" | "adjacent_rank") => {
        const hit = es.filter((e) => e[k] != null && e[k]! <= n).length;
        return `${hit}/${es.length}`;
      };
      return [repo, { "recall@5_source": r(5, "source_rank"), "recall@5_adjacent": r(5, "adjacent_rank"), "recall@3_source": r(3, "source_rank") }];
    })),
    evals,
  };
  const outPath = join(RESULTS, `offline-recall-${TAG}.json`);
  writeFileSync(outPath, JSON.stringify(summary, null, 2) + "\n");

  console.log(`\n=== RECALL (n=${evals.length}) ===`);
  console.log(`  source    @1=${summary.overall["recall@1_source"]}%  @3=${summary.overall["recall@3_source"]}%  @5=${summary.overall["recall@5_source"]}%`);
  console.log(`  adjacent  @3=${summary.overall["recall@3_adjacent"]}%  @5=${summary.overall["recall@5_adjacent"]}%`);
  console.log(`  tasks recalling a doc/README: ${summary.overall.tasks_with_doc_recalled}`);
  console.log(`  tasks whose source was NOT indexed: ${summary.overall.tasks_source_not_indexed}`);
  console.log(`  per-repo recall@5 source:`, Object.fromEntries(Object.entries(summary.per_repo).map(([k, v]: any) => [k, v["recall@5_source"]])));
  console.log(`\nWrote ${outPath}`);
}

main();
