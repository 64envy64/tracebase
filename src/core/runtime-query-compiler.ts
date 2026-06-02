/**
 * Runtime two-view query compiler (Router V2, Phase D.1 — docs/PLAN.md §4.2).
 *
 * WHY THIS EXISTS
 *   Candidate generation feeds ONE bounded intent (the raw query text) to both
 *   the sparse FTS lane and the semantic provider. A raw task prompt is noisy:
 *   symbol-heavy queries ("TypeError … foo.bar() … src/api/handler.ts …") dilute
 *   the few mechanism words with identifier fragments, dropping the semantic
 *   cosine of the RIGHT lesson and crowding the slate with blocks that merely
 *   share a symbol. Symptom-only queries carry the mechanism implicitly. Phase C
 *   lifted candidate recall with a semantic lane, but the lane scores the noisy
 *   full text. V4 (Phase C.3) is precision-1.0 but can only license what reaches
 *   the slate, and a body-phrased paraphrase that FTS-over-the-full-text matches
 *   is routed to the lexical lane (V2 abstains) instead of the semantic-license
 *   lane it should take.
 *
 * WHAT THE COMPILER DOES
 *   Derive TWO bounded, privacy-scanned views from the sanitized task text:
 *     • LITERAL — structured invariants (errorType/api/framework/language) plus
 *       symbol-shaped identifier fragments (dotted/pathy/camelCase/CapErr). The
 *       lexical signal the sparse FTS lane should match on.
 *     • CAUSAL — the mechanism PROSE: the informative non-symbol words, the
 *       compact "what is going wrong" intent the semantic lane should match
 *       against block bodies. Produced ONLY when enough mechanism prose remains.
 *
 *   Routing structured signals to FTS and mechanism prose to the semantic lane
 *   (a) raises the right lesson's semantic cosine (concentration), (b) keeps
 *   symbol-shared blocks out of the semantic slate, and (c) makes a pure-prose
 *   paraphrase semantic-ONLY (no literal signal ⇒ FTS misses it) so V4's
 *   contrastive license — not the lexical lane — adjudicates it.
 *
 * HARD CONSTRAINTS
 *   • Pure + deterministic: same input → same views. No DB, no I/O, no clock,
 *     no randomness. Replayable.
 *   • No chain-of-thought, no domain-specific keyword lists, no LLM. Symbol vs
 *     prose is a STRUCTURAL (morphological) classifier; the only "vocabulary" is
 *     the shared stop/generic lists already used everywhere (serving-tokenizer).
 *   • Privacy: the raw text is leakage/injection-scrubbed BEFORE classification
 *     (so absolute paths / secrets never enter a view or a view hash), and each
 *     view is length-bounded. Views are never persisted raw — only hashed.
 */
import type { BlockInvariants } from "../types.js";
import { scrubSensitiveSpans } from "./guard.js";
import { tokenizeInformative, isGenericToken, queryHash } from "./serving-tokenizer.js";

/** Max characters of any single compiled view text crossing downstream. */
export const MAX_VIEW_CHARS = 256;
/**
 * Minimum number of informative (non-generic) prose tokens for a causal view to
 * be worth compiling. Below this the residual prose is too thin to be a useful
 * mechanism intent, so no causal lane is produced (the cascade stays literal).
 * Principled (a mechanism needs at least a subject + relation + object), not
 * tuned to a fixture.
 */
export const MIN_CAUSAL_TOKENS = 3;

export type QueryViewKind = "literal" | "causal";

/** One compiled, privacy-scanned, bounded retrieval view. */
export interface RuntimeQueryView {
  kind: QueryViewKind;
  /** Sanitized + bounded view text. */
  text: string;
  /** Stable, non-reversible hash for telemetry (never the raw view text). */
  viewHash: string;
  /** Count of informative (non-generic) tokens in the view (telemetry/cascade). */
  informativeTokenCount: number;
  invariants?: BlockInvariants;
}

/** The output of compiling one query: a literal view plus an optional causal view. */
export interface CompiledQuery {
  compiler: string;
  literal: RuntimeQueryView;
  /** Present only when enough mechanism prose remains (see MIN_CAUSAL_TOKENS). */
  causal?: RuntimeQueryView;
  provenance: {
    /** Symbol-shaped raw tokens routed to the literal view. */
    symbolTokenCount: number;
    /** Informative prose tokens routed to the causal view. */
    proseTokenCount: number;
    /** Whether a causal view was produced. */
    hasCausal: boolean;
  };
}

/**
 * A pluggable, deterministic query compiler. Implementations MUST be pure and
 * MUST NOT read raw bodies, persist raw prompts, or use an LLM. Swapping in a
 * learned compiler later is a drop-in: implement this interface.
 */
export interface RuntimeQueryCompiler {
  readonly name: string;
  compile(rawText: string, invariants?: BlockInvariants): CompiledQuery;
}

/**
 * Structural symbol classifier over a RAW whitespace token (no keyword list).
 * A token is symbol-shaped when it looks like a code identifier / path / typed
 * error rather than a natural-language word:
 *   • contains `.` `/` `\` or `_`  (dotted call, path, snake_case);
 *   • contains a digit;
 *   • is camelCase (an inner lower→upper boundary);
 *   • is a CapWord with a second capital (e.g. `TypeError`, `ECONNRESET`).
 */
export function isSymbolToken(raw: string): boolean {
  const t = raw.replace(/^[^A-Za-z0-9_./\\]+/, "").replace(/[^A-Za-z0-9_./\\]+$/, "");
  if (!t) return false;
  if (/[./\\_]/.test(t)) return true;
  if (/\d/.test(t)) return true;
  if (/[a-z][A-Z]/.test(t)) return true;
  if (/^[A-Z][a-zA-Z]*[A-Z]/.test(t)) return true;
  return false;
}

function bound(text: string): string {
  return text.length > MAX_VIEW_CHARS ? text.slice(0, MAX_VIEW_CHARS) : text;
}

function informativeCount(text: string): number {
  return tokenizeInformative(text).filter((t) => !isGenericToken(t)).length;
}

function mkView(kind: QueryViewKind, text: string, invariants?: BlockInvariants): RuntimeQueryView {
  const bounded = bound(text);
  return {
    kind,
    text: bounded,
    viewHash: queryHash(bounded),
    informativeTokenCount: informativeCount(bounded),
    ...(invariants ? { invariants } : {}),
  };
}

/** Render the structured invariants as literal lexical signal (lowercased). */
function invariantSignal(inv: BlockInvariants | undefined): string {
  if (!inv) return "";
  const parts: string[] = [];
  if (inv.errorType) parts.push(inv.errorType);
  if (inv.framework) parts.push(inv.framework);
  if (inv.language) parts.push(inv.language);
  for (const api of inv.apiSurface ?? []) parts.push(api);
  return parts.join(" ");
}

/**
 * The default deterministic compiler. Scrubs the raw text, splits it on
 * whitespace, routes symbol-shaped tokens (+ structured invariants) to the
 * LITERAL view and the informative prose to the CAUSAL view. The causal view is
 * produced only when ≥ MIN_CAUSAL_TOKENS informative prose tokens remain.
 */
export class StructuredQueryCompiler implements RuntimeQueryCompiler {
  readonly name = "structured-two-view.v1";

  compile(rawText: string, invariants?: BlockInvariants): CompiledQuery {
    // Privacy FIRST: scrub leakage/injection spans before anything is classified
    // or hashed, so absolute paths / secrets can never enter a view or its hash.
    const scrubbed = scrubSensitiveSpans(rawText ?? "");
    const rawTokens = scrubbed.split(/\s+/).filter((t) => t.length > 0);

    const symbolTokens: string[] = [];
    const proseTokens: string[] = [];
    for (const t of rawTokens) {
      if (isSymbolToken(t)) symbolTokens.push(t);
      else proseTokens.push(t);
    }

    // Literal view: structured invariants + symbol-shaped tokens. Falls back to
    // the full scrubbed text when the query carries no symbols at all, so the
    // sparse lane never loses a genuinely-literal query (off-parity-safe shape).
    const litSignal = `${invariantSignal(invariants)} ${symbolTokens.join(" ")}`.trim();
    const literalText = litSignal.length > 0 ? litSignal : scrubbed;
    const literal = mkView("literal", literalText, invariants);

    // Causal view: the mechanism prose. Only when enough informative prose remains.
    const proseText = proseTokens.join(" ").trim();
    const proseInformative = informativeCount(proseText);
    const hasCausal = proseInformative >= MIN_CAUSAL_TOKENS;
    const causal = hasCausal ? mkView("causal", proseText) : undefined;

    return {
      compiler: this.name,
      literal,
      ...(causal ? { causal } : {}),
      provenance: {
        symbolTokenCount: symbolTokens.length,
        proseTokenCount: proseTokens.length,
        hasCausal,
      },
    };
  }
}

/** Human-readable one-liner for doctor/report tooling (privacy-safe: hashes + counts). */
export function explainCompiledQuery(c: CompiledQuery): string {
  const cau = c.causal ? ` causal[${c.causal.viewHash} n=${c.causal.informativeTokenCount}]` : " causal[none]";
  return `compiler=${c.compiler} literal[${c.literal.viewHash} n=${c.literal.informativeTokenCount}]${cau} sym=${c.provenance.symbolTokenCount} prose=${c.provenance.proseTokenCount}`;
}
