/**
 * Demo fixture integrity. The old Engineering Brain graph view was
 * retired in favour of the unified dashboard demo data, so this test now
 * pins the data relationships the dashboard pages consume directly.
 */
import { describe, expect, it } from "vitest";
import { getDataInfraFixture } from "@/lib/demo/data-infra-fixture";

describe("data-infra demo fixture", () => {
  const fixture = getDataInfraFixture();

  it("has runs tied to known codebases", () => {
    const codebases = new Set(fixture.codebases.map((c) => c.name));
    for (const run of fixture.runs) {
      expect(codebases.has(run.taskRepo)).toBe(true);
    }
  });

  it("keeps pattern sourceRunId references valid", () => {
    const runIds = new Set(fixture.runs.map((r) => r.id));
    for (const pattern of fixture.patterns) {
      if (pattern.sourceRunId) {
        expect(runIds.has(pattern.sourceRunId)).toBe(true);
      }
    }
  });

  it("has findings attached to known codebases", () => {
    const codebases = new Set(fixture.codebases.map((c) => c.name));
    for (const finding of fixture.findings) {
      expect(codebases.has(finding.codebase)).toBe(true);
    }
  });

  it("reports project count separately from installation count", () => {
    const projectsCount = new Set(fixture.installations.map((i) => i.projectName)).size;
    expect(projectsCount).toBeGreaterThan(0);
    expect(fixture.installations.length).toBeGreaterThan(projectsCount);
  });
});
