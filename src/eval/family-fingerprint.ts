/**
 * Recurring-reasoning-family observability (runtime-first, generic).
 *
 * A "family" is a recurring problem class. We need to know, as dogfood capture
 * accumulates, whether genuinely RECURRING problems are appearing (families with
 * ≥2 captures) — the precondition for any precision-ready reasoning-reuse signal.
 *
 * The fingerprint is a DETERMINISTIC hash of a block's top salient terms, drawn
 * from its distilled (privacy-safe) situation + mechanism. It is intentionally
 * CONSERVATIVE (favours precision): only near-identical problem statements share
 * a family, so the recurring-family count never over-reports. It is a transparent
 * heuristic, not a semantic clusterer — no repo/benchmark-specific terms, no model
 * calls, no raw prompts (operates only on stored distilled content).
 */
import { createHash } from "node:crypto";

const FAMILY_TERMS = 6; // salient terms that define a family fingerprint

// Generic English/code stop-words — keep this list domain-neutral.
const STOP = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "else", "when", "while", "for",
  "of", "to", "in", "on", "at", "by", "with", "from", "into", "as", "is", "are", "was",
  "were", "be", "been", "being", "it", "its", "this", "that", "these", "those", "there",
  "here", "so", "not", "no", "do", "does", "did", "done", "can", "will", "would", "should",
  "could", "have", "has", "had", "you", "your", "we", "our", "they", "their", "i", "me",
  "my", "he", "she", "his", "her", "which", "who", "what", "why", "how", "because", "due",
  "test", "tests", "fails", "fail", "failing", "failed", "bug", "fix", "fixed", "fixes",
  "issue", "problem", "code", "file", "files", "function", "method", "value", "values",
  "case", "cases", "unit", "assertion", "passes", "pass", "run", "running", "root", "cause",
  "source", "logic", "handling", "input", "edge", "minimal", "change", "changed", "area",
]);

/** Top-K salient terms (by frequency, deterministic ties), sorted for stability. */
export function salientTerms(text: string, k: number = FAMILY_TERMS): string[] {
  const cleaned = text.toLowerCase().replace(/```[\s\S]*?```/g, " ");
  const freq = new Map<string, number>();
  for (const raw of cleaned.split(/[^a-z]+/)) {
    if (raw.length < 4 || STOP.has(raw)) continue;
    freq.set(raw, (freq.get(raw) ?? 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, k)
    .map((e) => e[0])
    .sort();
}

/** Deterministic family fingerprint from free text. "none" when too thin to cluster. */
export function fingerprintText(text: string): string {
  const top = salientTerms(text);
  return top.length >= 2 ? createHash("sha1").update(top.join(" ")).digest("hex").slice(0, 12) : "none";
}

/** Minimal block shape (distilled, privacy-safe). */
export interface FingerprintableBlock {
  id: string;
  trigger: { situation: string };
  body: { mechanism?: string };
}
export function fingerprintBlock(b: FingerprintableBlock): string {
  return fingerprintText(`${b.trigger?.situation ?? ""} ${b.body?.mechanism ?? ""}`);
}

export interface FamilyStats {
  totalBlocks: number;
  families: number;
  recurringFamilies: number; // size >= 2
  largestFamilySize: number;
  sizeDistribution: Record<string, number>; // "1","2",... → number of families of that size
  recurring: Array<{ fingerprint: string; size: number; blockIds: string[] }>;
}

/** Cluster blocks into families and summarize. Generic; deterministic ordering. */
export function clusterFamilies(blocks: FingerprintableBlock[]): FamilyStats {
  const fam = new Map<string, string[]>();
  for (const b of blocks) {
    const fp = fingerprintBlock(b);
    if (fp === "none") continue;
    if (!fam.has(fp)) fam.set(fp, []);
    fam.get(fp)!.push(b.id);
  }
  const sizes: Record<string, number> = {};
  let recurring = 0, largest = 0;
  for (const ids of fam.values()) {
    const s = ids.length;
    sizes[String(s)] = (sizes[String(s)] ?? 0) + 1;
    if (s >= 2) recurring++;
    if (s > largest) largest = s;
  }
  const recurringList = [...fam.entries()]
    .filter(([, ids]) => ids.length >= 2)
    .map(([fingerprint, blockIds]) => ({ fingerprint, size: blockIds.length, blockIds }))
    .sort((a, b) => b.size - a.size || a.fingerprint.localeCompare(b.fingerprint));
  return {
    totalBlocks: blocks.length,
    families: fam.size,
    recurringFamilies: recurring,
    largestFamilySize: largest,
    sizeDistribution: sizes,
    recurring: recurringList,
  };
}
