/**
 * Copy regression — textual guard for the Impact surface.
 *
 * The dashboard impact surface should stay value-first for a regular
 * coder while preserving workspace-scoped contributor counts for the
 * enterprise analytics path. This test reads the view source and fails
 * if old project/adapters framing resurfaces.
 *
 * Textual rather than DOM-rendered because react-dom is a www-only
 * dep; vitest runs from root and cannot resolve "react-dom/server".
 * The asserts are narrow enough that legitimate refactors pass.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const IMPACT_VIEW_PATH = resolve(
  __dirname,
  "../../www/src/components/dashboard/ImpactView.tsx",
);
const IMPACT_PAGE_PATH = resolve(
  __dirname,
  "../../www/src/app/dashboard/impact/page.tsx",
);

const impactView = readFileSync(IMPACT_VIEW_PATH, "utf-8");
const impactPage = readFileSync(IMPACT_PAGE_PATH, "utf-8");

describe("ImpactView copy", () => {
  it('uses a value-first page title, not "Project activity"', () => {
    // Phase 0.8.x trimmed the heading from "What TraceBase saved"
    // to plain "Impact" — either is acceptable here as long as the
    // page surface anchors on Impact/Savings, not on Activity.
    expect(impactView).toMatch(/title="(Impact|What TraceBase saved)"/);
    expect(impactView).not.toMatch(/Project activity/);
  });

  it('drops the misleading "wired adapters" language', () => {
    expect(impactView).not.toMatch(/wired\s+adapters?/i);
  });

  it("root section aria-label matches the workspace-scoped heading (a11y consistency)", () => {
    expect(impactView).toContain('aria-label="Savings and memory impact"');
    expect(impactView).not.toMatch(/aria-label="Impact — project activity"/);
  });

  it("describes its counts as contributors-in-window, not as workspace-wide inventory", () => {
    // The view must not say "linked to this workspace" — that was
    // the mistaken framing when counts were workspace totals. The
    // cleaner 0.8.x copy says "in this window" without the "pushed
    // samples" phrasing.
    expect(impactView).toMatch(/in this window/);
    expect(impactView).not.toMatch(/linked to this workspace/i);
  });

  it("renders a projectsCount prop distinct from installationsCount", () => {
    // Props must be split so the view cannot quietly conflate one
    // as the other — a recurring mistake the rename guards against.
    expect(impactView).toContain("projectsCount");
    expect(impactView).toContain("installationsCount");
    expect(impactView).toMatch(/projectsCount\s*\}/); // destructured
    expect(impactView).toMatch(/installationsCount\s*,?\s*\}/);
  });
});

describe("Impact page wiring", () => {
  it("routes both counts through countContributorsInWindow, not workspace-wide inventory", () => {
    // Regression: page used to compute projectsCount from
    // `installations.map(...localWorkspaceId)` — i.e. every
    // installation in the workspace, regardless of whether it
    // pushed a sample in the window. The fix routes it through
    // `countContributorsInWindow(samples, installations)`, which
    // returns only the window's actual contributors.
    expect(impactPage).toContain("countContributorsInWindow");
    // The stale "all linked installations" derivation must be gone.
    expect(impactPage).not.toMatch(/installationsCount=\{installations\.length\}/);
    expect(impactPage).not.toMatch(/new Set\(installations\.map\(\(i\) => i\.localWorkspaceId\)\)/);
  });

  it("metadata description labels the route workspace-level, not project-level", () => {
    expect(impactPage).toMatch(/Workspace-level/);
    expect(impactPage).not.toMatch(/Project-level/);
  });

  it("metadata does not claim rollup across every linked project/adapter", () => {
    // Phase 1E.3 scoped counts to contributors-in-window, but the
    // metadata description still claimed "rolled up across every
    // linked project and adapter" — a different shape of the same
    // drift. Metadata must match the route's actual semantics.
    expect(impactPage).not.toMatch(/every linked project and adapter/i);
    expect(impactPage).toMatch(/contributors in the selected window/i);
  });

  it("fold and contributor counts key off the same filtered-and-validated sample set", () => {
    // Phase 1E.4 introduced a single-filter pipeline; 1E.5 added a
    // schema-validate step so invalid metrics payloads cannot count
    // as contributors while being dropped from the fold. Both
    // consumers must feed from `validated`, never from the
    // unfiltered or unparsed sources.
    expect(impactPage).toContain("filterSamplesByScope");
    expect(impactPage).toContain("workspaceSamples");
    expect(impactPage).toContain("validateSamples(workspaceSamples)");
    // Neither consumer may accept the pre-validation sets.
    expect(impactPage).not.toMatch(/toDailyBuckets\(rawSamples\)/);
    expect(impactPage).not.toMatch(/countContributorsInWindow\(rawSamples\b/);
    expect(impactPage).not.toMatch(/toDailyBuckets\(workspaceSamples\)/);
    expect(impactPage).not.toMatch(/countContributorsInWindow\(workspaceSamples\b/);
    // Explicit shape: both receive the validated set.
    expect(impactPage).toMatch(/toDailyBuckets\(validated\)/);
    expect(impactPage).toMatch(/countContributorsInWindow\(validated\b/);
  });
});
