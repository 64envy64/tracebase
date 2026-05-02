/**
 * Privacy / governance source guards.
 *
 * These textual checks are cheap insurance for the rules we cite in
 * the Engineering Brain copy: GitHub bodies are bounded summaries,
 * tokens never persist, deleted memories never inject, and audit
 * actions hit memory_events for every status change.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ENGINEERING_BRAIN = resolve(
  __dirname,
  "../../www/src/lib/control-plane/engineering-brain.ts",
);
const INGEST = resolve(
  __dirname,
  "../../www/src/lib/control-plane/github-ingest.ts",
);
const GITHUB_CLIENT = resolve(
  __dirname,
  "../../www/src/lib/control-plane/github-client.ts",
);
const ISSUE_BRIEF = resolve(
  __dirname,
  "../../www/src/lib/control-plane/issue-brief.ts",
);
const MEMORY_ROUTE = resolve(
  __dirname,
  "../../www/src/app/api/engineering-brain/memory/route.ts",
);
const RUNS_ROUTE = resolve(
  __dirname,
  "../../www/src/app/api/engineering-brain/runs/route.ts",
);

const engBrain = readFileSync(ENGINEERING_BRAIN, "utf-8");
const ingest = readFileSync(INGEST, "utf-8");
const ghClient = readFileSync(GITHUB_CLIENT, "utf-8");
const issueBrief = readFileSync(ISSUE_BRIEF, "utf-8");
const memoryRoute = readFileSync(MEMORY_ROUTE, "utf-8");
const runsRoute = readFileSync(RUNS_ROUTE, "utf-8");

describe("Engineering Brain — auth-route contract", () => {
  it("Clerk-protected API routes use the API auth helper, not the page-level throw helper", () => {
    const ROUTES = [
      resolve(__dirname, "../../www/src/app/api/engineering-brain/integrations/route.ts"),
      resolve(__dirname, "../../www/src/app/api/engineering-brain/ingest/route.ts"),
      resolve(__dirname, "../../www/src/app/api/engineering-brain/issue-brief/route.ts"),
      resolve(__dirname, "../../www/src/app/api/engineering-brain/memory/route.ts"),
    ];
    for (const path of ROUTES) {
      const src = readFileSync(path, "utf-8");
      // Must use the *ForApi variant (returns NextResponse on miss).
      expect(src).toContain("requireAuthenticatedWorkspaceForApi");
      // Must NOT use the throwing page-level variant — it would 500
      // on unauth API calls.
      expect(src).not.toMatch(/\brequireAuthenticatedWorkspace\(\s*\)/);
    }
  });
});

describe("Engineering Brain — privacy guards", () => {
  it("github body summaries are clamped to MAX_BODY_SUMMARY_CHARS", () => {
    expect(engBrain).toMatch(/const MAX_BODY_SUMMARY_CHARS\s*=\s*\d+/);
    expect(engBrain).toContain("collapsed.slice(0, MAX_BODY_SUMMARY_CHARS - 1)");
  });

  it("tokens are never persisted in records — only used at request time", () => {
    expect(ghClient).not.toMatch(/console\.(log|info|debug)\([^)]*token/);
    expect(ingest).toContain("redactGithubError");
    expect(ingest).toMatch(/TOKEN_PATTERN\s*=\s*\//);
  });

  it("hard delete nulls trig_situation and body_preview", () => {
    expect(engBrain).toMatch(
      /trig_situation\s*=\s*CASE WHEN \$4::boolean THEN NULL ELSE tracebase_memory_status\.trig_situation END/,
    );
    expect(engBrain).toMatch(
      /body_preview\s*=\s*CASE WHEN \$4::boolean THEN NULL ELSE tracebase_memory_status\.body_preview END/,
    );
  });

  it("deleted memories are excluded from issue-brief recall", () => {
    expect(issueBrief).toMatch(
      /\.filter\(\(m\)\s*=>\s*m\.status\s*!==\s*"deleted"\)/,
    );
  });

  it("memory governance route writes a memory_event for every action", () => {
    // The shared `changeMemoryStatus` is the path that writes the
    // event; the route delegates to it for retire/delete/supersede.
    expect(memoryRoute).toContain("store.changeMemoryStatus");
    // Rollback explicitly writes both a memory_event and a rollback_event.
    expect(memoryRoute).toContain("store.rollbackMemoryStatus");
  });

  it("runs route never accepts tool I/O — counts only", () => {
    // Body field whitelist: only counts and identity, never bodies/messages.
    const allowed = [
      "sessionId",
      "agentDisplayName",
      "agentHost",
      "ownerLabel",
      "taskTitle",
      "taskSourceKind",
      "taskSourceId",
      "startedAt",
      "endedAt",
      "status",
      "tokensInjected",
      "tokensSavedEstimated",
      "toolCallsCount",
      "blockedCallsCount",
      "recalledPatternsCount",
      "recalledFilesCount",
    ];
    for (const f of allowed) expect(runsRoute).toContain(f);
    expect(runsRoute).not.toContain("toolBody");
    expect(runsRoute).not.toContain("rawPrompt");
  });
});
