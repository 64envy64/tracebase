/**
 * Regression: the 10+10 health checkpoint must sample a STRATIFIED, representative
 * slice of the corpus — never a family-sorted single-repo prefix.
 *
 * v1/v2 took the first 10 family-sorted capture + 10 recall, which were ALL axios
 * (the manifest is family-sorted) → the checkpoint corpus was single-repo and the
 * recall fire-rate was confounded. orderForRun round-robins across repos/families.
 */
import { describe, it, expect } from "vitest";
import { orderForRun, stratifiedPrefix, type ManifestRow } from "../../scripts/reasoning-precision/capture-orchestrator.js";

const row = (repo: string, fam: string, sha: string, arm: "capture" | "recall"): ManifestRow => ({
  taskId: `${repo}-${sha}`, repo, baseSHA: `b-${sha}`, fixSHA: sha, sourceFamily: fam,
  expectedFailingTest: "t", testFilesTouched: ["t"], sourceFilesTouched: ["s"],
  verificationCommand: "c", arm, relatedFamilyIds: [fam], leakageExclusions: [], provenance: "p",
});

// Family-sorted input (all of one repo, then the next) — the shape that produced
// the all-axios checkpoint. 3 repos × 8 capture + 8 recall each.
const tasks: ManifestRow[] = [];
for (const [repo, k] of [["a/axios", 8], ["b/mathjs", 8], ["c/zod", 8]] as const) {
  for (let i = 0; i < k; i++) {
    tasks.push(row(repo, `${repo}:f${i}`, `${repo}-c${i}`, "capture"));
    tasks.push(row(repo, `${repo}:f${i}`, `${repo}-r${i}`, "recall"));
  }
}

describe("orderForRun — stratified checkpoint", () => {
  it("the first C capture span ALL repos (not a single-repo prefix)", () => {
    const firstCap = orderForRun(tasks, 6, 6).filter((t) => t.arm === "capture").slice(0, 6);
    expect(new Set(firstCap.map((t) => t.repo)).size).toBe(3);
  });

  it("the first R recall span ALL repos", () => {
    const firstRec = orderForRun(tasks, 6, 6).slice(6, 12);
    expect(firstRec.every((t) => t.arm === "recall")).toBe(true);
    expect(new Set(firstRec.map((t) => t.repo)).size).toBe(3);
  });

  it("checkpoint prefix is C capture THEN R recall (capture before recall)", () => {
    const ordered = orderForRun(tasks, 6, 6);
    expect(ordered.slice(0, 6).every((t) => t.arm === "capture")).toBe(true);
    expect(ordered.slice(6, 12).every((t) => t.arm === "recall")).toBe(true);
  });

  it("is deterministic and lossless (every task exactly once)", () => {
    const a = orderForRun(tasks, 6, 6).map((t) => t.taskId);
    const b = orderForRun(tasks, 6, 6).map((t) => t.taskId);
    expect(a).toEqual(b);
    expect(a.length).toBe(tasks.length);
    expect(new Set(a).size).toBe(tasks.length);
  });

  it("stratifiedPrefix round-robins across repos", () => {
    const pre = stratifiedPrefix(tasks.filter((t) => t.arm === "capture"), 3);
    expect(pre.map((t) => t.repo)).toEqual(["a/axios", "b/mathjs", "c/zod"]);
  });
});
