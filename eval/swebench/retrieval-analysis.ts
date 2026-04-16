/**
 * Phase 1: Retrieval Quality Analysis
 *
 * For each holdout task, run TraceBase recall against the KB
 * built from successful train patterns. Show top-1/top-3 matches
 * with confidence scores for manual classification.
 *
 * Output used to answer: is the bottleneck retrieval (weak matches)
 * or downstream (good matches but no resolved uplift)?
 */
import { readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReasoningLayer } from "../../src/core/engine.js";

const trainTasks = JSON.parse(readFileSync("eval/swebench/tasks-train.json", "utf-8"));
const holdoutTasks = JSON.parse(readFileSync("eval/swebench/tasks-holdout.json", "utf-8"));

// Load successful train patterns
import { globSync } from "node:fs";
import { readdirSync } from "node:fs";

interface KBEntry {
  instance_id: string;
  problem: string;
  repo: string;
  files: string[];
  fix_approach: string;
}

const kb: KBEntry[] = [];
const trainDir = "eval/swebench/results/train-sonnet";
const trainDirs = readdirSync(trainDir, { withFileTypes: true });
for (const entry of trainDirs) {
  if (!entry.isDirectory()) continue;
  const trajPath = join(trainDir, entry.name, `${entry.name}.traj.json`);
  try {
    const traj = JSON.parse(readFileSync(trajPath, "utf-8"));
    const submission = traj?.info?.submission ?? "";
    if (!submission) continue;

    const task = trainTasks.find((t: { instance_id: string }) => t.instance_id === entry.name);
    if (!task) continue;

    const files = submission.split("\n")
      .filter((l: string) => l.startsWith("+++ b/"))
      .map((l: string) => l.slice(6));
    const added = submission.split("\n")
      .filter((l: string) => l.startsWith("+") && !l.startsWith("+++") && l.slice(1).trim())
      .map((l: string) => l.slice(1).trim())
      .slice(0, 5);

    kb.push({
      instance_id: entry.name,
      problem: task.problem_statement.slice(0, 300),
      repo: task.repo,
      files: files.slice(0, 5),
      fix_approach: added.join("; ").slice(0, 200),
    });
  } catch { /* skip */ }
}

console.log(`KB size: ${kb.length} traces\n`);

// Load into TraceBase ReasoningLayer
const tmp = mkdtempSync(join(tmpdir(), "tb-retrieval-"));
const layer = new ReasoningLayer({ storagePath: join(tmp, "kb.db") });

for (const entry of kb) {
  layer.storeTrace({
    problem: {
      description: entry.problem,
      language: "python",
      framework: entry.repo,
      tags: ["swebench", entry.repo],
    },
    solution: {
      summary: entry.fix_approach,
      explanation: `Files: ${entry.files.join(", ")}`,
      steps: [],
      outcome: "success",
    },
    metadata: { agent: "seed", source: "train" },
  });
}

// Run recall for each holdout
console.log("RETRIEVAL ANALYSIS (TraceBase 6-signal recall engine)\n");
console.log("═".repeat(80));

for (const h of holdoutTasks) {
  console.log(`\n▶ HOLDOUT: ${h.instance_id}`);
  console.log(`  Problem: ${h.problem_statement.slice(0, 120)}...`);
  const goldFiles = h.patch.split("\n")
    .filter((l: string) => l.startsWith("+++ b/"))
    .map((l: string) => l.slice(6));
  console.log(`  Gold files: ${goldFiles.join(", ")}`);

  const results = layer.recall({
    problem: h.problem_statement.slice(0, 500),
    limit: 3,
    minScore: 0.0,
    context: { language: "python", framework: h.repo },
  });

  console.log(`\n  Top-${results.length} matches:`);
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const kbEntry = kb.find(k => k.problem.startsWith(r.trace.problem.description.slice(0, 100)));
    const matchFiles = kbEntry?.files ?? [];

    // Check file overlap with gold
    const dirOverlap = matchFiles.some(mf =>
      goldFiles.some((gf: string) => {
        const mfDir = mf.split("/").slice(0, -1).join("/");
        const gfDir = gf.split("/").slice(0, -1).join("/");
        return mfDir && gfDir && (mfDir === gfDir || mfDir.startsWith(gfDir) || gfDir.startsWith(mfDir));
      })
    );
    const exactOverlap = matchFiles.some(mf => goldFiles.includes(mf));

    const rating = exactOverlap ? "RELEVANT (same file)"
                 : dirOverlap ? "WEAK (same dir)"
                 : "IRRELEVANT";

    console.log(`    ${i + 1}. score=${r.score.toFixed(3)} type=${r.matchType}`);
    console.log(`       files: ${matchFiles.join(", ")}`);
    console.log(`       signals: fp=${r.signals.fingerprint.toFixed(2)} bm25=${r.signals.bm25.toFixed(2)} jaccard=${r.signals.jaccard.toFixed(2)} struct=${r.signals.structural.toFixed(2)} fresh=${r.signals.freshness.toFixed(2)}`);
    console.log(`       → ${rating}`);
  }
}

console.log("\n" + "═".repeat(80));
layer.close();
