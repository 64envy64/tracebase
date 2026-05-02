/**
 * First-touch workspace seed.
 *
 * When a new Clerk user lands on the Engineering Brain, their
 * workspace is empty — every page renders empty states which is
 * accurate but unhelpful for a first impression. `ensureWorkspaceSeeded`
 * fills the workspace with a realistic, citable graph keyed to the
 * user's own display name so the dashboard reads as a real working
 * environment, not a "demo" surface.
 *
 * Idempotent: if any of the brain tables already contains rows for
 * the workspace, the seed is a no-op. The user can wipe their
 * workspace (remove every memory + integration) to trigger a fresh
 * seed; once anything real is created the seed never runs again.
 */
import {
  type EngineeringBrainStore,
} from "@/lib/control-plane/engineering-brain";

const REPO_FULL_NAME = "your-team/payments-app";

export interface SeedInput {
  workspaceId: string;
  ownerLabel: string;
  store: EngineeringBrainStore;
}

export async function ensureWorkspaceSeeded(input: SeedInput): Promise<{ seeded: boolean }> {
  const { workspaceId, ownerLabel, store } = input;

  const [
    integrations,
    githubItems,
    agents,
    memoryStatuses,
  ] = await Promise.all([
    store.listIntegrations(workspaceId),
    store.listGithubItems(workspaceId, { limit: 1 }),
    store.listAgents(workspaceId),
    store.listMemoryStatuses(workspaceId),
  ]);

  const empty =
    integrations.length === 0 &&
    githubItems.length === 0 &&
    agents.length === 0 &&
    memoryStatuses.length === 0;

  if (!empty) return { seeded: false };

  await seedFresh({ workspaceId, ownerLabel, store });
  return { seeded: true };
}

async function seedFresh({
  workspaceId,
  ownerLabel,
  store,
}: SeedInput): Promise<void> {
  const now = Date.now();
  const minutesAgo = (n: number) => new Date(now - n * 60_000).toISOString();
  const hoursAgo = (n: number) => new Date(now - n * 3_600_000).toISOString();
  const daysAgo = (n: number) => new Date(now - n * 86_400_000).toISOString();

  // 1) Integration
  const integration = await store.upsertIntegration({
    workspaceId,
    provider: "github",
    accountLogin: REPO_FULL_NAME.split("/")[0],
    repoFullName: REPO_FULL_NAME,
    status: "connected",
    lastSyncAt: minutesAgo(7),
  });

  // 2) GitHub items — issues, PR, CI failure
  const issue217 = await store.upsertGithubItem({
    workspaceId,
    integrationId: integration.id,
    repoFullName: REPO_FULL_NAME,
    kind: "issue",
    externalId: "1900000217",
    number: 217,
    title: "JWT refresh fails for users with stale session cookies",
    state: "open",
    url: `https://github.com/${REPO_FULL_NAME}/issues/217`,
    authorLogin: "ria",
    bodySummary:
      "Users with cookies older than 12h hit a 403 on /api/me. Stack trace blames jwt.verify() but the token is technically valid; suspect clock skew between auth-svc and the gateway.",
    labels: ["bug", "auth"],
    linkedFiles: [
      "packages/auth-svc/src/jwt.ts",
      "packages/gateway/src/middleware/auth.ts",
    ],
    createdAtRemote: daysAgo(2),
    updatedAtRemote: hoursAgo(1),
  });

  const issue218 = await store.upsertGithubItem({
    workspaceId,
    integrationId: integration.id,
    repoFullName: REPO_FULL_NAME,
    kind: "issue",
    externalId: "1900000218",
    number: 218,
    title: "Add structured logs to gateway middleware",
    state: "open",
    url: `https://github.com/${REPO_FULL_NAME}/issues/218`,
    authorLogin: "marcus",
    bodySummary:
      "Once #217 lands we'll want consistent log fields so on-call can correlate auth-svc and gateway lines.",
    labels: ["enhancement", "observability"],
    linkedFiles: ["packages/gateway/src/middleware/auth.ts"],
    createdAtRemote: daysAgo(1),
    updatedAtRemote: daysAgo(1),
  });
  // intentionally referenced to guarantee the row sticks even if
  // the linter prunes unused locals; issue218 helps populate the
  // intake list and graph.
  void issue218;

  const pr942 = await store.upsertGithubItem({
    workspaceId,
    integrationId: integration.id,
    repoFullName: REPO_FULL_NAME,
    kind: "pull_request",
    externalId: "9420",
    number: 942,
    title: "fix(auth): allow 60s clock skew in jwt verify",
    state: "open",
    url: `https://github.com/${REPO_FULL_NAME}/pull/942`,
    authorLogin: ownerLabel,
    bodySummary:
      "Patch widens jwt.verify() clockTolerance to 60s to absorb gateway↔auth-svc drift. Adds a regression test that simulates 30s skew.",
    labels: ["bug", "auth"],
    linkedFiles: [
      "packages/auth-svc/src/jwt.ts",
      "packages/auth-svc/test/jwt.test.ts",
    ],
    createdAtRemote: hoursAgo(2),
    updatedAtRemote: minutesAgo(7),
  });
  void pr942;

  const ciFailure = await store.upsertGithubItem({
    workspaceId,
    integrationId: integration.id,
    repoFullName: REPO_FULL_NAME,
    kind: "check_run",
    externalId: "770",
    title: "ci: integration-tests · failure",
    state: "failure",
    url: `https://github.com/${REPO_FULL_NAME}/runs/770`,
    bodySummary:
      "1 test failed: jwt clockTolerance test relies on a frozen Date.now mock that was reset by the test harness reorder.",
    labels: ["ci-failure"],
    linkedFiles: [],
    createdAtRemote: minutesAgo(45),
    updatedAtRemote: minutesAgo(45),
  });

  // 3) Agents — both owned by the current user
  const agentClaude = await store.upsertAgent({
    workspaceId,
    displayName: `${ownerLabel}'s Claude Code`,
    ownerLabel,
    host: "claude-code",
    status: "active",
  });

  const agentCodex = await store.upsertAgent({
    workspaceId,
    displayName: `${ownerLabel}'s Codex`,
    ownerLabel,
    host: "codex",
    status: "active",
  });

  // 4) Agent runs — one resolved, one still in progress
  const resolvedRun = await store.createAgentRun({
    workspaceId,
    agentId: agentClaude.id,
    sessionId: "live-session-001",
    taskTitle: "Resolve issue #217 — JWT refresh fails for stale sessions",
    taskSourceKind: "github_issue",
    taskSourceId: issue217.id,
    startedAt: daysAgo(2),
    status: "resolved",
    tokensInjected: 4200,
    tokensSavedEstimated: 18500,
    toolCallsCount: 24,
    blockedCallsCount: 1,
    recalledPatternsCount: 2,
    recalledFilesCount: 6,
  });
  await store.updateAgentRun({
    workspaceId,
    id: resolvedRun.id,
    endedAt: minutesAgo(45),
    status: "resolved",
  });

  const liveRun = await store.createAgentRun({
    workspaceId,
    agentId: agentCodex.id,
    sessionId: "live-session-002",
    taskTitle: "Investigate ci: integration-tests failure",
    taskSourceKind: "ci_failure",
    taskSourceId: ciFailure.id,
    startedAt: minutesAgo(8),
    status: "running",
    tokensInjected: 800,
    tokensSavedEstimated: 0,
    toolCallsCount: 5,
    blockedCallsCount: 0,
    recalledPatternsCount: 1,
    recalledFilesCount: 2,
  });

  // 5) Memory statuses — active, superseded, retired
  const memJwtClock = await store.upsertMemoryStatus({
    workspaceId,
    memoryId: `mem-jwt-clock-skew-${shortId()}`,
    status: "active",
    trigSituation:
      "JWT verify rejects valid tokens with iat in the future or expired by < 90s",
    bodyPreview:
      "When auth-svc and gateway run on different VMs, NTP drift can push iat 10-60s apart. jwt.verify() defaults to clockTolerance=0; widen to 60 and test.",
    provenanceKind: "agent_run",
    provenanceId: resolvedRun.id,
  });

  const memJwtRotate = await store.upsertMemoryStatus({
    workspaceId,
    memoryId: `mem-jwt-rotate-${shortId()}`,
    status: "superseded",
    trigSituation: "Old guidance: rotate JWT signing key every deploy",
    bodyPreview:
      "Earlier playbook recommended rotating signing key on every deploy. This caused unnecessary 401s; superseded by the dual-key approach in mem-jwt-dualkey.",
    provenanceKind: "manual",
  });

  const memRateLimit = await store.upsertMemoryStatus({
    workspaceId,
    memoryId: `mem-rate-limit-${shortId()}`,
    status: "retired",
    trigSituation: "Use exponential backoff with jitter on 429",
    bodyPreview:
      "Standard exponential-backoff guidance — retired now that we use the framework's built-in retry policy with budgets.",
    provenanceKind: "manual",
  });

  // 6) Memory events
  await store.createMemoryEvent({
    workspaceId,
    memoryId: memJwtClock.memoryId,
    actorKind: "agent",
    actorId: agentClaude.displayName,
    action: "created",
    sourceRunId: resolvedRun.id,
    sourceGithubItemId: issue217.id,
    reason: "Distilled from successful resolution of issue #217",
  });
  await store.createMemoryEvent({
    workspaceId,
    memoryId: memJwtRotate.memoryId,
    actorKind: "agent",
    actorId: agentClaude.displayName,
    action: "superseded",
    sourceRunId: resolvedRun.id,
    reason: "Replaced by dual-key approach found during issue #217 investigation",
  });
  await store.createMemoryEvent({
    workspaceId,
    memoryId: memRateLimit.memoryId,
    actorKind: "human",
    actorId: ownerLabel,
    action: "retired",
    reason: "Framework retry policy now covers this case",
  });
  await store.createMemoryEvent({
    workspaceId,
    memoryId: memJwtRotate.memoryId,
    actorKind: "agent",
    actorId: agentCodex.displayName,
    action: "used",
    sourceRunId: liveRun.id,
    reason: "Cited as background while investigating CI failure",
  });

  // 7) Rollback event — keeps the older guidance visible
  await store.rollbackMemoryStatus({
    workspaceId,
    memoryId: memJwtRotate.memoryId,
    actorKind: "human",
    actorId: ownerLabel,
    reason:
      "Rolled back the supersede so both pieces of guidance remain visible during review",
  });
}

function shortId(): string {
  return Math.random().toString(36).slice(2, 8);
}
