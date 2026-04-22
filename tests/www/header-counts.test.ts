/**
 * Header counts regression — guards that every workspace surface
 * separates "projects" (distinct localWorkspaceId) from
 * "installations" ((project × adapter) rows). Before Phase 1E.2
 * both Overview and Installations rendered `installations.length`
 * as if it were the project count, which was the same bug Impact
 * carried until 1E.1.
 *
 * Textual because react-dom is a www-only dep. The asserts look for
 * the two labels existing side by side in the source; this catches
 * regressions where someone removes one count or collapses them
 * into a single chip that reads "installs N" only.
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

describe("OverviewView header counts", () => {
  it("exposes both projects and installations as separate counts", () => {
    expect(overview).toContain("projectsCount");
    expect(overview).toContain("installationsCount");
    // The chip bar must carry both numbers explicitly — literal
    // substring asserts so the template-literal form cannot drift
    // back to a single conflated chip.
    expect(overview).toContain("`projects ${projectsCount}`");
    expect(overview).toContain("`installs ${installationsCount}`");
  });

  it("labels the primary stat tile as Linked projects, not Linked installs", () => {
    expect(overview).toContain('label="Linked projects"');
    expect(overview).not.toContain('label="Linked installs"');
  });

  it("derives projectsCount from localWorkspaceId, not installations.length", () => {
    // The Set-based dedupe on localWorkspaceId is the honest source.
    // Assert the three tokens exist so the regression fires if the
    // dedupe is removed even if formatting changes.
    expect(overview).toContain("new Set(");
    expect(overview).toContain("localWorkspaceId");
    expect(overview).not.toMatch(/value=\{bootstrap\.installations\.length\}/);
  });
});

describe("InstallationsView header", () => {
  it('heading no longer says "Linked adapters"', () => {
    expect(installations).not.toMatch(/Linked\s+adapters/);
    expect(installations).toContain("Linked installations");
  });

  it("reports project count separately from row count in the panel header", () => {
    expect(installations).toContain("projectsCount");
    expect(installations).toContain("installationsCount");
    expect(installations).toContain("new Set(");
    expect(installations).toContain("localWorkspaceId");
  });
});
