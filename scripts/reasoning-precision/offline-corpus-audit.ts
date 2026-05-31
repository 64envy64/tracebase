#!/usr/bin/env tsx
/**
 * $0 offline corpus + gate-fit audit (NO paid agents). Answers the operator's
 * evaluation-design questions without another paid dispatch:
 *  - family structure: matched families (recall family has a capture) + holdout count
 *  - fire-rate overall + within matched families, via the REAL BlockServer policy
 *  - precision@fire using family labels (same-family fire = genuine reuse candidate)
 *  - binding issue: (a) insufficient repeated-family coverage, (b) weak retrieval,
 *    (c) overly strict evidence policy on genuinely similar cases
 *
 * FAITHFULNESS + CAVEAT: capture blocks are PROXIES reconstructed from the frozen
 * manifest — situation = the runtime extractor's firstSentence ("A unit test
 * fails: <test>."), mechanism/unlock = a generic bug description (NOT stuffed with
 * the family label, which a real agent would not repeat). This faithfully models
 * the SITUATION match (distinctive token = the differing test path) but only
 * approximates the agent's real mechanism text. Treat fire-rate as an estimate;
 * the empirical anchor is the v2 checkpoint (real blocks → 0 fired).
 */
import Database from "better-sqlite3";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BlockStore } from "../../src/core/block-store.js";
import { BlockServer } from "../../src/core/block-serving.js";
import { storeReasoningPattern } from "../../src/server/mcp-v2-helpers.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MANIFEST = process.env.TB_MANIFEST ?? join(ROOT, "bench-runs", "reasoning-reuse", "capture-manifest.frozen.json");
const OUT = join(ROOT, "bench-runs", "reasoning-reuse", "results", "offline-corpus-audit.json");

interface Row { taskId: string; repo: string; arm: string; sourceFamily: string; expectedFailingTest: string; sourceFilesTouched: string[]; verificationCommand: string; }
const mf = JSON.parse(readFileSync(MANIFEST, "utf-8"));
const tasks: Row[] = mf.tasks;
const cap = tasks.filter((t) => t.arm === "capture");
const rec = tasks.filter((t) => t.arm === "recall");
const srcTopOf = (t: Row) => (t.sourceFilesTouched?.[0] ?? "").split("/").slice(0, -1).join("/") || "the source";
// Faithful captured situation = the extractor's firstSentence.
const situationOf = (t: Row) => `A unit test fails: ${t.expectedFailingTest}.`;
// The runtime recalls on the FULL prompt (inject-context query), not firstSentence.
const queryOf = (t: Row) => `A unit test fails: ${t.expectedFailingTest}. There is a bug in ${srcTopOf(t)} (problem area: ${t.sourceFamily}). Find and fix the root cause so the failing test passes.`;

// Seed the store with proxy capture blocks (real serving policy reads these).
const store = new BlockStore(new Database(":memory:"));
const blockToTask = new Map<string, Row>();
let stored = 0, rejected = 0;
for (const t of cap) {
  try {
    const r = storeReasoningPattern(store, {
      situation: situationOf(t),
      mechanism: `The logic in ${srcTopOf(t)} mishandles an input or edge case, so the assertion in ${t.expectedFailingTest} does not hold and the test fails.`,
      unlock: `Correct the handling in ${srcTopOf(t)} so the previously failing assertion passes; keep the change minimal.`,
      verification: `Run ${t.verificationCommand} and confirm it passes.`,
      distilledBy: "rule",
    } as any);
    if (r.blockId) { blockToTask.set(r.blockId, t); stored++; }
  } catch { rejected++; }
}
const server = new BlockServer(store);

// Family structure.
const famCap = new Map<string, number>(), famRec = new Map<string, number>();
for (const t of cap) famCap.set(t.sourceFamily, (famCap.get(t.sourceFamily) ?? 0) + 1);
for (const t of rec) famRec.set(t.sourceFamily, (famRec.get(t.sourceFamily) ?? 0) + 1);
const matchedFamilies = [...famRec.keys()].filter((f) => famCap.has(f));
const recurringFamilies = [...new Set([...famCap.keys(), ...famRec.keys()])].filter((f) => (famCap.get(f) ?? 0) + (famRec.get(f) ?? 0) >= 2);
const recallInMatched = rec.filter((t) => famCap.has(t.sourceFamily));

// Recall each task through the real policy.
const results = rec.map((t) => {
  const r = server.recall({ text: queryOf(t) } as any);
  const top = r.blocks?.[0];
  const topTask = top ? blockToTask.get(top.block.id) : undefined;
  const sameFam = r.blocks.find((b) => blockToTask.get(b.block.id)?.sourceFamily === t.sourceFamily);
  const fired = !!r.shouldInject && r.blocks.some((b) => b.passesGate);
  return {
    taskId: t.taskId, family: t.sourceFamily, repo: t.repo, fired,
    topFamily: topTask?.sourceFamily ?? null, topScore: top?.score ?? null,
    topEvidence: top?.evidenceConfidence ?? null, topCalibrated: top?.calibratedProb ?? null,
    decision: r.servingDecision?.action ?? null, reason: r.servingDecision?.reason ?? null,
    threshold: r.servingDecision?.threshold ?? null, marginThreshold: r.servingDecision?.marginThreshold ?? null,
    candidates: r.blocks.length,
    sameFamilyRetrieved: !!sameFam, sameFamilyPassedGate: !!sameFam?.passesGate, sameFamilyScore: sameFam?.score ?? null,
  };
});

const fires = results.filter((r) => r.fired);
const firesSameFamily = fires.filter((r) => r.topFamily === r.family);
const matchedNoFire = results.filter((r) => matchedFamilies.includes(r.family) && !r.fired);
const retrievedButGated = matchedNoFire.filter((r) => r.sameFamilyRetrieved);
const notRetrieved = matchedNoFire.filter((r) => !r.sameFamilyRetrieved);
const reasonCounts: Record<string, number> = {};
for (const r of results) reasonCounts[String(r.reason)] = (reasonCounts[String(r.reason)] ?? 0) + 1;

let bindingIssue: string;
if (matchedFamilies.length < 10 || recallInMatched.length < 15)
  bindingIssue = "(a) insufficient repeated-family coverage — too few leakage-safe matched-family pairs exist to reach 30 precision-ready";
else if (notRetrieved.length > retrievedButGated.length)
  bindingIssue = "(b) weak retrieval — same-family blocks are not even surfaced as candidates for their recall tasks";
else
  bindingIssue = "(c) overly strict evidence policy — same-family blocks are retrieved but the gate abstains on these weakly-similar distinct bugs (correct for precision; limits reuse volume)";

const report = {
  note: "OFFLINE ESTIMATE via proxy capture blocks (situation faithful = extractor firstSentence; mechanism approximate). Empirical anchor: v2 checkpoint real blocks → 0 fired.",
  manifestHash: mf.manifestHash,
  corpus: { captureTasks: cap.length, recallTasks: rec.length, proxyBlocksStored: stored, proxyRejected: rejected },
  families: {
    distinctCaptureFamilies: famCap.size, distinctRecallFamilies: famRec.size,
    matchedFamilies: matchedFamilies.length, recurringFamilies_ge2: recurringFamilies.length,
    recallTasksInMatchedFamily: recallInMatched.length,
    familiesWithMultipleCaptures: [...famCap.values()].filter((n) => n >= 2).length,
  },
  fireRate: { overall: `${fires.length}/${rec.length}`, overallPct: +(fires.length / rec.length * 100).toFixed(1),
    withinMatchedFamily: `${results.filter((r) => matchedFamilies.includes(r.family) && r.fired).length}/${recallInMatched.length}` },
  precisionAtFire: fires.length ? +(firesSameFamily.length / fires.length).toFixed(3) : null,
  abstentionReasons: reasonCounts,
  gateFit: { matchedNoFire: matchedNoFire.length, sameFamilyRetrievedButGated: retrievedButGated.length, sameFamilyNotRetrieved: notRetrieved.length },
  bindingIssue,
  sampleResults: results.slice(0, 12),
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ ...report, sampleResults: undefined }, null, 2));
console.log(`\nwrote ${OUT}`);
