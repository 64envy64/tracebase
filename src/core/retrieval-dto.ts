/**
 * Privacy-hardened retrieval DTO builders (Router V2, Phase C.2).
 *
 * The BlockServer (not the provider) builds these bounded, scanned DTOs, so the
 * provider boundary carries ONLY safe content — never raw prompts, raw blocks,
 * bodies, or paths. A remote adapter that implements `RetrievalProvider`
 * therefore cannot receive sensitive content implicitly: there is no path for
 * it to reach.
 *
 *   - buildRetrievalIntent: scrub leakage/injection spans + bound the length.
 *   - buildRetrievalDocument: opaque blockId + approved scanned token sets,
 *     reusing `buildStructuredView` (which redacts any field that trips a guard)
 *     so a leaky body field never reaches the document.
 */
import type { ReasoningBlock, BlockInvariants } from "../types.js";
import { scrubSensitiveSpans } from "./guard.js";
import { buildStructuredView } from "./serving-evidence-v2.js";
import type { RetrievalIntent, RetrievalDocument } from "./retrieval-provider.js";

/** Hard cap on intent text length crossing the provider boundary. */
export const MAX_INTENT_CHARS = 512;

/** Build the sanitized, bounded retrieval intent. */
export function buildRetrievalIntent(
  text: string,
  invariants: BlockInvariants | undefined,
  limit: number,
): RetrievalIntent {
  const scrubbed = scrubSensitiveSpans(text ?? "");
  const bounded = scrubbed.length > MAX_INTENT_CHARS ? scrubbed.slice(0, MAX_INTENT_CHARS) : scrubbed;
  return { text: bounded, ...(invariants ? { invariants } : {}), limit };
}

/**
 * Build a sanitized-text retrieval document. Token sets come from
 * `buildStructuredView`, which has already run the leakage + injection guards
 * and redacted any offending body field — so a leaky mechanism/unlock never
 * appears in the document. The opaque block id is the only identifier exposed.
 */
export function buildRetrievalDocument(block: ReasoningBlock): RetrievalDocument {
  const view = buildStructuredView(block);
  return {
    blockId: block.id,
    tokens: {
      situation: [...view.situationTokens],
      mechanism: [...view.fieldTokens.mechanism],
      unlock: [...view.fieldTokens.unlock],
      invariants: [...view.memory.invariants],
    },
  };
}

/**
 * Build a vector-only document: opaque id + an opaque vector reference (model +
 * dims), never the floats and never any token text. For future vector-only
 * adapters; returns just the id when the block has no stored embedding.
 */
export function buildVectorOnlyDocument(block: ReasoningBlock): RetrievalDocument {
  const vec = block.embeddings?.situationVec;
  if (block.embeddings && vec) {
    return { blockId: block.id, vectorRef: { model: block.embeddings.model, dims: vec.length } };
  }
  return { blockId: block.id };
}
