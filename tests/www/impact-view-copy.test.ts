/**
 * Copy regression — textual guard for the Impact surface.
 *
 * The Phase 1 fold aggregates samples across every linked project in
 * the control-plane workspace. Rendering that as "Project activity"
 * is wrong for any workspace with more than one project. This test
 * reads the view source and fails if:
 *   - "Project activity" resurfaces as a heading;
 *   - "wired adapter(s)" copy resurfaces (each install row is
 *     (project × agent), not just an adapter);
 *   - "Workspace activity" + split project/installation labels are
 *     missing.
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
  it('uses "Workspace activity" as the heading, not "Project activity"', () => {
    expect(impactView).toContain("Workspace activity");
    expect(impactView).not.toMatch(/Project activity/);
  });

  it('drops the misleading "wired adapters" language', () => {
    expect(impactView).not.toMatch(/wired\s+adapters?/i);
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
  it("computes distinct projects from localWorkspaceId and passes it in", () => {
    // The page must actually pass projectsCount to the view.
    expect(impactPage).toContain("localWorkspaceId");
    expect(impactPage).toContain("projectsCount=");
  });

  it("metadata description labels the route workspace-level, not project-level", () => {
    expect(impactPage).toMatch(/Workspace-level/);
    expect(impactPage).not.toMatch(/Project-level/);
  });
});
