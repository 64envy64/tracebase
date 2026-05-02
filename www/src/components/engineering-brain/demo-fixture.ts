/**
 * Demo fixture for /dashboard/demo.
 *
 * This is the only place in the dashboard that fabricates Engineering
 * Brain data. The fixture is deterministic, hardcoded, and clearly
 * named so it is impossible to confuse with a real workspace's data.
 * Every page that consumes it explicitly pulls from
 * `getDemoFixture()` and renders alongside a "Demo" badge.
 *
 * Acceptance: 1 repo, 2 issues, 1 failed CI, 2 agent runs, 1 prior
 * memory, 1 new memory created from the resolved run, 1 retired/
 * superseded memory, 1 rollback event.
 */
import type {
  AgentRecord,
  AgentRunRecord,
  EngineeringBrainBootstrap,
  GithubItemRecord,
  IntegrationRecord,
  MemoryEventRecord,
  MemoryStatusRecord,
  RollbackEventRecord,
} from "@/lib/control-plane/types";

const DEMO_WORKSPACE = "demo-workspace-uuid-0000-0000-000000000000";
const NOW = "2026-05-01T12:30:00.000Z";
const HOUR_AGO = "2026-05-01T11:30:00.000Z";
const DAY_AGO = "2026-04-30T12:30:00.000Z";
const TWO_DAYS_AGO = "2026-04-29T12:30:00.000Z";
const WEEK_AGO = "2026-04-24T12:30:00.000Z";

const integration: IntegrationRecord = {
  id: "demo-integration-1",
  workspaceId: DEMO_WORKSPACE,
  provider: "github",
  accountLogin: "tracebase",
  repoFullName: "tracebase/sample-app",
  status: "connected",
  lastSyncAt: HOUR_AGO,
  createdAt: WEEK_AGO,
  updatedAt: HOUR_AGO,
};

const githubItems: GithubItemRecord[] = [
  {
    id: "demo-issue-217",
    integrationId: integration.id,
    workspaceId: DEMO_WORKSPACE,
    repoFullName: "tracebase/sample-app",
    kind: "issue",
    externalId: "1900000217",
    number: 217,
    title: "JWT refresh fails for users with stale session cookies",
    state: "open",
    url: "https://github.com/tracebase/sample-app/issues/217",
    authorLogin: "ria",
    bodySummary:
      "Users with cookies older than 12h hit a 403 on /api/me. Stack trace blames jwt.verify() but the token is technically valid; suspect clock skew between auth-svc and the gateway.",
    labels: ["bug", "auth"],
    linkedFiles: ["packages/auth-svc/src/jwt.ts", "packages/gateway/src/middleware/auth.ts"],
    createdAtRemote: TWO_DAYS_AGO,
    updatedAtRemote: HOUR_AGO,
    ingestedAt: HOUR_AGO,
  },
  {
    id: "demo-issue-218",
    integrationId: integration.id,
    workspaceId: DEMO_WORKSPACE,
    repoFullName: "tracebase/sample-app",
    kind: "issue",
    externalId: "1900000218",
    number: 218,
    title: "Add structured logs to gateway middleware",
    state: "open",
    url: "https://github.com/tracebase/sample-app/issues/218",
    authorLogin: "marcus",
    bodySummary:
      "Once #217 lands we'll want consistent log fields so on-call can correlate auth-svc and gateway lines.",
    labels: ["enhancement", "observability"],
    linkedFiles: ["packages/gateway/src/middleware/auth.ts"],
    createdAtRemote: DAY_AGO,
    updatedAtRemote: DAY_AGO,
    ingestedAt: HOUR_AGO,
  },
  {
    id: "demo-pr-942",
    integrationId: integration.id,
    workspaceId: DEMO_WORKSPACE,
    repoFullName: "tracebase/sample-app",
    kind: "pull_request",
    externalId: "9420",
    number: 942,
    title: "fix(auth): allow 60s clock skew in jwt verify",
    state: "open",
    url: "https://github.com/tracebase/sample-app/pull/942",
    authorLogin: "agent-claude-1",
    bodySummary:
      "Patch widens jwt.verify() clockTolerance to 60s to absorb gateway↔auth-svc drift. Adds a regression test that simulates 30s skew.",
    labels: ["bug", "auth"],
    linkedFiles: [
      "packages/auth-svc/src/jwt.ts",
      "packages/auth-svc/test/jwt.test.ts",
    ],
    createdAtRemote: HOUR_AGO,
    updatedAtRemote: HOUR_AGO,
    ingestedAt: HOUR_AGO,
  },
  {
    id: "demo-check-77",
    integrationId: integration.id,
    workspaceId: DEMO_WORKSPACE,
    repoFullName: "tracebase/sample-app",
    kind: "check_run",
    externalId: "770",
    title: "ci: integration-tests · failure",
    state: "failure",
    url: "https://github.com/tracebase/sample-app/runs/770",
    bodySummary:
      "1 test failed: jwt clockTolerance test relies on a frozen Date.now mock that was reset by the test harness reorder.",
    labels: ["ci-failure"],
    linkedFiles: [],
    createdAtRemote: HOUR_AGO,
    updatedAtRemote: HOUR_AGO,
    ingestedAt: HOUR_AGO,
  },
];

const agents: AgentRecord[] = [
  {
    id: "demo-agent-claude-1",
    workspaceId: DEMO_WORKSPACE,
    displayName: "agent-claude-1",
    ownerLabel: "ria",
    host: "claude-code",
    status: "active",
    createdAt: WEEK_AGO,
    updatedAt: NOW,
  },
  {
    id: "demo-agent-codex-1",
    workspaceId: DEMO_WORKSPACE,
    displayName: "agent-codex-1",
    ownerLabel: "marcus",
    host: "codex",
    status: "active",
    createdAt: WEEK_AGO,
    updatedAt: HOUR_AGO,
  },
];

const agentRuns: AgentRunRecord[] = [
  {
    id: "demo-run-1",
    workspaceId: DEMO_WORKSPACE,
    agentId: agents[0].id,
    sessionId: "sess-demo-001",
    taskTitle: "Resolve issue #217 — JWT refresh fails for stale sessions",
    taskSourceKind: "github_issue",
    taskSourceId: "demo-issue-217",
    startedAt: TWO_DAYS_AGO,
    endedAt: HOUR_AGO,
    status: "resolved",
    tokensInjected: 4200,
    tokensSavedEstimated: 18500,
    toolCallsCount: 24,
    blockedCallsCount: 1,
    recalledPatternsCount: 2,
    recalledFilesCount: 6,
  },
  {
    id: "demo-run-2",
    workspaceId: DEMO_WORKSPACE,
    agentId: agents[1].id,
    sessionId: "sess-demo-002",
    taskTitle: "Investigate ci: integration-tests failure",
    taskSourceKind: "ci_failure",
    taskSourceId: "demo-check-77",
    startedAt: HOUR_AGO,
    status: "running",
    tokensInjected: 800,
    tokensSavedEstimated: 0,
    toolCallsCount: 5,
    blockedCallsCount: 0,
    recalledPatternsCount: 1,
    recalledFilesCount: 2,
  },
];

const memoryStatuses: MemoryStatusRecord[] = [
  {
    workspaceId: DEMO_WORKSPACE,
    memoryId: "demo-mem-jwt-clock-skew-1",
    status: "active",
    trigSituation: "JWT verify rejects valid tokens with iat in the future or expired by < 90s",
    bodyPreview:
      "When auth-svc and gateway run on different VMs, NTP drift can push iat 10-60s apart. jwt.verify() defaults to clockTolerance=0; widen to 60 and test.",
    provenanceKind: "agent_run",
    provenanceId: "demo-run-1",
    createdAt: HOUR_AGO,
    updatedAt: HOUR_AGO,
  },
  {
    workspaceId: DEMO_WORKSPACE,
    memoryId: "demo-mem-jwt-rotate-1",
    status: "superseded",
    trigSituation: "Old guidance: rotate JWT signing key every deploy",
    bodyPreview:
      "Earlier playbook recommended rotating signing key on every deploy. This caused unnecessary 401s; superseded by the dual-key approach in mem-jwt-dualkey-2.",
    provenanceKind: "manual",
    createdAt: WEEK_AGO,
    updatedAt: TWO_DAYS_AGO,
  },
  {
    workspaceId: DEMO_WORKSPACE,
    memoryId: "demo-mem-rate-limit-1",
    status: "retired",
    trigSituation: "Use exponential backoff with jitter on 429",
    bodyPreview:
      "Standard exponential-backoff guidance — retired now that we use the framework's built-in retry policy with budgets.",
    provenanceKind: "manual",
    createdAt: WEEK_AGO,
    updatedAt: DAY_AGO,
  },
];

const memoryEvents: MemoryEventRecord[] = [
  {
    id: "demo-ev-1",
    workspaceId: DEMO_WORKSPACE,
    memoryId: "demo-mem-jwt-clock-skew-1",
    actorKind: "agent",
    actorId: "agent-claude-1",
    action: "created",
    sourceRunId: "demo-run-1",
    sourceGithubItemId: "demo-issue-217",
    reason: "Distilled from successful resolution of issue #217",
    createdAt: HOUR_AGO,
  },
  {
    id: "demo-ev-2",
    workspaceId: DEMO_WORKSPACE,
    memoryId: "demo-mem-jwt-rotate-1",
    actorKind: "agent",
    actorId: "agent-claude-1",
    action: "superseded",
    sourceRunId: "demo-run-1",
    reason: "Replaced by dual-key approach found during issue #217 investigation",
    createdAt: TWO_DAYS_AGO,
  },
  {
    id: "demo-ev-3",
    workspaceId: DEMO_WORKSPACE,
    memoryId: "demo-mem-rate-limit-1",
    actorKind: "human",
    actorId: "ria",
    action: "retired",
    reason: "Framework retry policy now covers this case",
    createdAt: DAY_AGO,
  },
  {
    id: "demo-ev-4",
    workspaceId: DEMO_WORKSPACE,
    memoryId: "demo-mem-jwt-rotate-1",
    actorKind: "human",
    actorId: "ria",
    action: "rollback",
    reason: "rolled back the supersede to keep both pieces of guidance visible",
    createdAt: HOUR_AGO,
  },
];

const rollbackEvents: RollbackEventRecord[] = [
  {
    id: "demo-rb-1",
    workspaceId: DEMO_WORKSPACE,
    actorId: "ria",
    targetKind: "memory",
    targetId: "demo-mem-jwt-rotate-1",
    rollbackToId: "active",
    reason: "rolled back the supersede to keep both pieces of guidance visible",
    createdAt: HOUR_AGO,
  },
];

export interface DemoFixture {
  workspaceId: string;
  brain: EngineeringBrainBootstrap;
}

export function getDemoFixture(): DemoFixture {
  return {
    workspaceId: DEMO_WORKSPACE,
    brain: {
      integrations: [integration],
      githubItems,
      agents,
      agentRuns,
      memoryStatuses,
      memoryEvents,
      rollbackEvents,
    },
  };
}
