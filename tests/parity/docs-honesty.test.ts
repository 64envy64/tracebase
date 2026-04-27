/**
 * Docs honesty grep (PLAN-0.7 §6 stable §4).
 *
 * Pins two copy invariants in landing/README/AGENTS/CLAUDE prose:
 *
 *   1. Any blanket "all N capabilities" / "every host" / "everywhere"
 *      claim must be qualified with a parity-matrix reference. The
 *      Host Parity table lives in README.md and the integration
 *      tests in `tests/parity/host-matrix.test.ts` back every cell.
 *      A claim that all hosts have everything is dishonest until
 *      generic Tool/Loop becomes preventive.
 *
 *   2. Prompt-cache copy must NEVER claim direct token savings as
 *      a TraceBase output. The provider reports the savings; we
 *      record what the API gave us, never estimate. Approved
 *      phrasings are listed below.
 *
 * Adding new copy that triggers either gate? Either re-word it or
 * add a CASE to the corresponding allow-list with a 1-line reason.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(__dirname, "..", "..");

/**
 * Files we audit. Add new prose surfaces here as they appear.
 * Skipped silently if absent — keeps the test forward-compatible.
 */
const AUDITED_FILES = [
  "README.md",
  "AGENTS.md",
  "CLAUDE.md",
  "SDK.md",
  "www/src/app/page.tsx",
];

function readIfExists(rel: string): string | null {
  const path = join(repoRoot, rel);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf-8");
}

// ---------------------------------------------------------------------------
// 1) "all N capabilities" / "everywhere" claims must reference the parity matrix
// ---------------------------------------------------------------------------

const BLANKET_CLAIM_PATTERNS: RegExp[] = [
  /\ball (?:five|six|seven|6|7|8) capabilit/i,
  /\bevery (?:host|adapter|integration|wrapper)\s+(?:gets|has|supports|covers)/i,
  /\beverywhere\b.*(?:capabilit|recall|file\s*mem|fold|cache|tool|loop)/i,
  /\bfully supported across all hosts/i,
  /\bbattle-tested across (?:every|all)\s+host/i,
];

/**
 * If a file makes a blanket claim, it MUST also link to the parity
 * matrix (heading "## Host Parity" or the test path). The matrix is
 * the canonical "what works where" surface.
 */
function hasParityMatrixReference(content: string): boolean {
  return (
    /## Host Parity/i.test(content) ||
    /tests\/parity\/host-matrix/i.test(content) ||
    /Host Parity/i.test(content)
  );
}

describe("docs honesty — blanket capability claims must reference the parity matrix", () => {
  for (const rel of AUDITED_FILES) {
    it(`${rel} — any blanket "all capabilities" claim is matrix-anchored`, () => {
      const content = readIfExists(rel);
      if (content === null) return; // file absent — skip

      const blanketHits: string[] = [];
      for (const re of BLANKET_CLAIM_PATTERNS) {
        const re2 = new RegExp(re.source, re.flags + (re.flags.includes("g") ? "" : "g"));
        let m: RegExpExecArray | null;
        while ((m = re2.exec(content)) !== null) {
          blanketHits.push(m[0]);
        }
      }
      if (blanketHits.length > 0 && !hasParityMatrixReference(content)) {
        // Surface the offending phrases for fast diagnosis.
        throw new Error(
          `${rel} contains blanket capability claims without a Host Parity ` +
            `reference. Either link to README#host-parity or rephrase. ` +
            `Hits: ${JSON.stringify(blanketHits.slice(0, 5))}`,
        );
      }
      expect(true).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// 2) Prompt-cache copy must use approved phrasing
// ---------------------------------------------------------------------------

/**
 * Phrases that imply TraceBase produces or estimates prompt-cache
 * savings as its own output. These are dishonest — the provider
 * reports cache savings; we count what the API tells us.
 */
const FORBIDDEN_CACHE_PHRASES: RegExp[] = [
  /tracebase\s+(?:saves|reduces)\s+\d+%?\s+(?:tokens|cost)/i,
  /(?:we|tracebase)\s+(?:cut|slash|halve)\s+(?:your\s+)?(?:tokens|prompt\s+cost)/i,
  /(?:guaranteed|always|every call)\s+(?:saves|reduces)\s+tokens\s+via\s+(?:prompt\s+)?cache/i,
];

/**
 * Phrases that are approved — at least one of these (or no
 * cache mention at all) must appear when the file talks about
 * prompt cache. The "may reduce billed/processed prefix tokens"
 * hedge is the canonical wording per §6 stable §4.
 */
const APPROVED_CACHE_PHRASES: RegExp[] = [
  /may reduce (?:billed|processed)\s+(?:prefix\s+)?tokens/i,
  /counts only what the provider reports/i,
  /never estimates? (?:prompt\s+)?cache savings/i,
  /provider[-\s](?:side\s+)?(?:reports|reported)\s+cache/i,
  /cache_read_input_tokens|prompt_tokens_details\.cached_tokens/i,
];

function mentionsPromptCache(content: string): boolean {
  return /\bprompt\s*cache\b|\bcache_control\b|\bcached_tokens\b|cache\.prompt_hit/i.test(
    content,
  );
}

describe("docs honesty — prompt-cache copy uses approved phrasing", () => {
  for (const rel of AUDITED_FILES) {
    it(`${rel} — no forbidden "tracebase saves N tokens" claims`, () => {
      const content = readIfExists(rel);
      if (content === null) return;
      const offenders: string[] = [];
      for (const re of FORBIDDEN_CACHE_PHRASES) {
        const m = re.exec(content);
        if (m) offenders.push(m[0]);
      }
      expect(offenders, `forbidden cache phrasing in ${rel}: ${JSON.stringify(offenders)}`).toHaveLength(0);
    });

    it(`${rel} — files that mention prompt cache use at least one approved phrase`, () => {
      const content = readIfExists(rel);
      if (content === null) return;
      if (!mentionsPromptCache(content)) return;
      const hasApproved = APPROVED_CACHE_PHRASES.some((re) => re.test(content));
      expect(
        hasApproved,
        `${rel} mentions prompt cache but doesn't use the approved hedge ` +
          `("may reduce billed/processed prefix tokens", "counts only what the ` +
          `provider reports", or similar). Add one or rewrite the section.`,
      ).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// 3) Parity-matrix presence (README has it; integration tests back it)
// ---------------------------------------------------------------------------

describe("parity matrix — present in README and backed by integration tests", () => {
  it("README.md contains the Host Parity table", () => {
    const readme = readIfExists("README.md");
    expect(readme).not.toBeNull();
    expect(readme!).toMatch(/## Host Parity/);
    // Table header — matches the columns the integration test pins.
    expect(readme!).toMatch(/Recall.*FileMem.*Fold.*PromptCache.*Tool.*Loop/);
  });

  it("tests/parity/host-matrix.test.ts exists (the matrix's enforcement)", () => {
    const t = readIfExists("tests/parity/host-matrix.test.ts");
    expect(t).not.toBeNull();
    // At least one cell per host kind. We don't pin an exact count
    // here — that's the test file's own job — but the file's
    // existence is the contract.
    expect(t!).toMatch(/Claude Code \(hooks\)/);
    expect(t!).toMatch(/wrapAnthropic/);
    expect(t!).toMatch(/wrapOpenAI/);
    expect(t!).toMatch(/wrapGeneric/);
  });
});
