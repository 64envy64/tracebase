/**
 * Deterministic local retrieval provider (Router V2, Phase C).
 *
 * A model-free, network-free, fully deterministic `RetrievalProvider` used by
 * tests, the frozen paraphrase eval, and as the safe default semantic source
 * when hybrid retrieval is enabled without a configured dense provider.
 *
 * WHAT IT IS — and isn't
 *   It is NOT a neural dense retriever. It scores a query against each active
 *   block by token-set cosine over the block's PRIVACY-SCANNED STRUCTURED VIEW
 *   (situation + mechanism + unlock + invariants — built via `buildStructuredView`,
 *   which runs the same leakage/injection guards as every other path). The key
 *   property: it considers the BODY fields (mechanism/unlock) that FTS5 does NOT
 *   index, so it can surface a lesson whose TRIGGER didn't lexically match the
 *   query but whose mechanism did — the recall lever Phase C exists to enable —
 *   without any model. Real neural providers (Qwen3, BGE-M3) are documented
 *   adapters that implement the same `RetrievalProvider` contract; see
 *   src/core/retrieval-provider.ts.
 *
 * GUARANTEES
 *   • Deterministic: identical inputs → identical ranked output (ties broken by
 *     blockId).
 *   • Bounded + fail-open: scans only `ctx.activeBlocks`, honours `deadlineMs`,
 *     and returns `null` (⇒ caller falls back to sparse) if the budget is blown.
 *   • Reads only privacy-scanned fields; never raw bodies, paths, or vectors.
 */
import { tokenizeInformative, isGenericToken } from "./serving-tokenizer.js";
import { buildStructuredView } from "./serving-evidence-v2.js";
import type { RetrievalProvider, RetrievalQuery, RetrievalContext, RetrievalCandidate } from "./retrieval-provider.js";

/** Meaningful (non-generic) token set of free text. */
function meaningfulSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of tokenizeInformative(text)) if (!isGenericToken(t)) out.add(t);
  return out;
}

/** Token-set cosine: |A ∩ B| / sqrt(|A| · |B|). Deterministic, ∈ [0,1]. */
function setCosine(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (large.has(t)) inter++;
  return inter / Math.sqrt(a.size * b.size);
}

export class DeterministicLocalProvider implements RetrievalProvider {
  readonly name = "deterministic-local";

  /** Minimum cosine to be a candidate at all (drops near-zero noise). */
  private readonly minScore: number;

  constructor(opts: { minScore?: number } = {}) {
    // A small floor so the provider proposes only blocks with real body overlap.
    // Not a serving gate — V2 evidence + the policy still decide fire/abstain.
    this.minScore = opts.minScore ?? 0.05;
  }

  async retrieve(query: RetrievalQuery, ctx: RetrievalContext): Promise<RetrievalCandidate[] | null> {
    const start = ctx.now();
    const q = meaningfulSet(query.text);
    if (q.size === 0) return [];
    const scored: RetrievalCandidate[] = [];
    for (const block of ctx.activeBlocks) {
      if (ctx.now() - start > ctx.deadlineMs) return null; // budget blown → fail open to sparse
      const view = buildStructuredView(block);
      // Body-aware token universe (situation + mechanism + unlock + invariants;
      // dead-ends/verification excluded, mirroring the V2 scored fields).
      const sim = setCosine(q, view.allTokens);
      if (sim >= this.minScore) scored.push({ blockId: block.id, score: sim });
    }
    scored.sort((a, b) => b.score - a.score || (a.blockId < b.blockId ? -1 : a.blockId > b.blockId ? 1 : 0));
    return scored.slice(0, Math.max(1, query.limit));
  }
}
