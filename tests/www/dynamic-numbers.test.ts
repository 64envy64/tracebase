/**
 * Dynamic numbers — landing copy must not hard-code illustrative
 * counts (PLAN-0.7 §rc.1 Ground).
 *
 * Spec contract: any number that *looks like a real metric* in the
 * landing copy ("190k traces indexed", "218 files indexed", "skipped
 * re-read", "suggested redirect", "saved $50/month") implies a
 * runtime path that produces it. Until those paths exist, the only
 * place such numbers may appear is the dedicated illustrative-demo
 * fixture surfaced by `CapabilityDemo.tsx`.
 *
 * Two allowed locations:
 *   1. `www/src/components/landing/_demo-fixtures/` — explicit fixture
 *      module future rcs may add. Tagged with `// @illustrative`.
 *   2. `www/src/components/landing/capabilities/CapabilityDemo.tsx` —
 *      today's demo container; allowed to declare its own fixture
 *      until #1 is created.
 *
 * Anything else is a regression: a real metric has snuck into a
 * non-demo surface. The dashboard reads from real analytics endpoints
 * and renders `—` on empty; landing copy MUST follow the same rule
 * or stay illustrative-only.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
// `statSync` used by walkLandingTree below.
import { join, relative } from "node:path";

const LANDING_ROOT = join(__dirname, "../../www/src/components/landing");
const REPO_ROOT = join(__dirname, "../..");

// Forbidden numeric / phrase shapes (spec verbatim).
const FORBIDDEN_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "190k", re: /\b190k\b/i },
  { name: "218 files", re: /\b218 files\b/i },
  { name: "skipped re-read", re: /skipped re-read/i },
  { name: "suggested redirect", re: /suggested redirect/i },
  // "saved $" — the dollar-claim shape. We intentionally do NOT
  // forbid "verified saved" / "estimated saved" / "net after context
  // cost" — those are honest mode names from the impact UX.
  { name: "saved $", re: /\bsaved\s+\$/i },
];

// Allowed file paths (relative to LANDING_ROOT).
const ALLOWED = [
  "_demo-fixtures/", // future explicit fixture module
  "capabilities/CapabilityDemo.tsx", // today's demo container
];

function walkLandingTree(): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      const st = statSync(abs);
      if (st.isDirectory()) {
        visit(abs);
      } else if (st.isFile() && /\.(tsx?|jsx?|md|mdx|css|module\.css)$/.test(entry)) {
        out.push(abs);
      }
    }
  };
  visit(LANDING_ROOT);
  return out;
}

function isAllowed(absPath: string): boolean {
  const rel = relative(LANDING_ROOT, absPath);
  return ALLOWED.some((a) => rel === a || rel.startsWith(a));
}

describe("dynamic numbers — illustrative literals confined to demo path", () => {
  it.each(FORBIDDEN_PATTERNS)(
    "no '$name' literal in non-demo landing files",
    ({ re }) => {
      const offenders: string[] = [];
      for (const file of walkLandingTree()) {
        if (isAllowed(file)) continue;
        const content = readFileSync(file, "utf-8");
        if (re.test(content)) {
          offenders.push(relative(REPO_ROOT, file));
        }
      }
      expect(offenders, `forbidden literal escaped the demo allowlist`).toEqual([]);
    },
  );
});
