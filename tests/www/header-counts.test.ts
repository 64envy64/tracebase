/**
 * Header counts regression — guards that every workspace surface
 * separates "projects" (distinct localWorkspaceId) from
 * "installations" ((project × adapter) rows). Before Phase 1E.2
 * both Overview and Installations rendered `installations.length`
 * as if it were the project count, which was the same bug Impact
 * carried until 1E.1.
 *
 * Textual because react-dom is a www-only dep. The asserts target
 * the *intent* (value-first tiles wired off UsageMetrics, no
 * conflation of projects and installs) rather than specific copy —
 * the 0.8.x dashboard cleanup trimmed headings to "Installations"
 * / "Impact" / "API keys" and pushed infrastructure counts off the
 * Overview entirely. Tile-level regression still fires if anyone
 * wires installations.length into a value tile.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const OVERVIEW_PATH = resolve(
  __dirname,
  "../../www/src/components/dashboard/OverviewView.tsx",
);
const INSTALLATIONS_PATH = resolve(
  __dirname,
  "../../www/src/components/dashboard/InstallationsView.tsx",
);

const overview = readFileSync(OVERVIEW_PATH, "utf-8");
const installations = readFileSync(INSTALLATIONS_PATH, "utf-8");

describe("OverviewView metric tiles", () => {
  it("value-first metric tiles read from UsageMetrics observed totals, not from installations", () => {
    // The top metric tiles surface UsageMetrics. The honest signal:
    // they reference `observed.` fields (eligibleRuns, helpfulRuns,
    // usedRuns) — installations.length must not be wired into any
    // MetricTile's value prop.
    expect(overview).toContain("observed.eligibleRuns");
    expect(overview).toContain("observed.helpfulRuns");
    expect(overview).toContain("observed.usedRuns");
    // Sanity: no MetricTile call site pulls installations.length
    // directly. Catches a regression where someone reverts the value
    // tile to "installs N" without updating the rest of the page.
    const tileBlocks = overview.match(/<MetricTile[\s\S]*?\/>/g) ?? [];
    for (const block of tileBlocks) {
      expect(block).not.toMatch(/installations\.length/);
    }
  });

  it("every metric tile is a navigation target (no dead-end visual estate)", () => {
    // The Overview cleanup made every headline number drill in
    // somewhere. Regression: someone removes the `href` from a tile,
    // turning the headline back into a passive number with no follow-
    // through. We assert at least 3 tiles carry an href.
    const tileBlocks = overview.match(/<MetricTile[\s\S]*?\/>/g) ?? [];
    const withHref = tileBlocks.filter((b) => /href=/.test(b));
    expect(withHref.length).toBeGreaterThanOrEqual(3);
  });
});

describe("InstallationsView header", () => {
  it('no longer uses the "Linked adapters" framing', () => {
    expect(installations).not.toMatch(/Linked\s+adapters/);
  });

  it("page title surfaces the inventory concept", () => {
    // The heading was trimmed from "Linked installations" to just
    // "Installations" in the 0.8.x cleanup. Either is fine as long as
    // the word "Installations" anchors the page.
    expect(installations).toMatch(/title="Installations"/);
  });

  it("reports project count separately from row count in the page header", () => {
    // Subtitle template literal must surface both numbers so a viewer
    // can read e.g. "3 projects · 5 installs". The Set-based dedupe
    // on projectName stays the honest project source in demo mode.
    expect(installations).toContain("projectsCount");
    expect(installations).toContain("installationsCount");
    expect(installations).toContain("new Set(");
    expect(installations).toContain("projectName");
    expect(installations).toMatch(/\$\{projectsCount\}/);
    expect(installations).toMatch(/\$\{installationsCount\}/);
  });
});
