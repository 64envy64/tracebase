/**
 * Workspace fixture used in demo mode.
 *
 * This file is not loaded by real workspaces. Demo mode is enabled
 * with NEXT_PUBLIC_TRACEBASE_DEMO=1 or with ?demo=1 on dashboard URLs.
 *
 * The story matches the YC demo: a data-infra team uses TraceBase as
 * an agent memory layer. Prior PR decisions, file caveats, and
 * workflow rules are recalled before the next coding run, so agents
 * spend less time searching and less money re-discovering fixes.
 */

export type DemoFramework =
  | "claude-code"
  | "cursor"
  | "codex"
  | "openai"
  | "anthropic";

export type DemoPatternTier = "standing" | "common" | "tip";

export type DemoFindingType = "bug" | "note" | "pattern";

export type DemoRunStatus = "running" | "resolved" | "failed" | "abandoned";

export interface DemoCodebase {
  name: string;
  description: string;
}

export interface DemoTeammate {
  name: string;
  role: string;
}

export interface DemoAgent {
  id: string;
  displayName: string;
  framework: DemoFramework;
  user: string;
  status: "active" | "idle";
  lastSeenIso: string;
  totalRuns: number;
}

export interface DemoRun {
  id: string;
  framework: DemoFramework;
  agentDisplayName: string;
  user: string;
  startedIso: string;
  endedIso?: string;
  status: DemoRunStatus;
  taskTitle: string;
  taskRepo: string;
  profile: string;
  patternsUsed: number;
  toolCalls: number;
  tokensSaved: number;
}

export interface DemoPattern {
  id: string;
  tier: DemoPatternTier;
  scope: "universal" | "codebase";
  codebase?: string;
  title: string;
  body: string;
  usedCount: number;
  createdIso: string;
  sourceRunId?: string;
}

export interface DemoFinding {
  id: string;
  codebase: string;
  filePath: string;
  type: DemoFindingType;
  body: string;
  createdIso: string;
  lastUsedIso?: string;
}

export interface DemoImpactWindow {
  runs7d: number;
  resolvedRuns7d: number;
  helpfulRuns7d: number;
  missedRuns7d: number;
  tokensSaved7d: number;
  tokensSaved30d: number;
  costSaved7dUsd: number;
  apiTimeSaved7dMin: number;
  wallTimeSaved7dMin: number;
  outputTokensReduced7d: number;
  searchStepsAvoided7d: number;
  successRate: number;
  dailyRuns: Array<{ date: string; runs: number; helpful: number }>;
  dailyImpact: Array<{
    date: string;
    costSavedUsd: number;
    minutesSaved: number;
    outputTokensReduced: number;
  }>;
}

export interface DemoInstallation {
  id: string;
  projectName: string;
  framework: DemoFramework;
  cliVersion: string;
  user: string;
  linkedIso: string;
  updatedIso: string;
}

export interface DataInfraFixture {
  workspaceDisplayName: string;
  workspaceTagline: string;
  codebases: DemoCodebase[];
  team: DemoTeammate[];
  agents: DemoAgent[];
  runs: DemoRun[];
  patterns: DemoPattern[];
  findings: DemoFinding[];
  installations: DemoInstallation[];
  impact: DemoImpactWindow;
}

const ANCHOR_MS = Date.now();

function iso(daysBack: number, hoursBack = 0, minutesBack = 0): string {
  const t =
    ANCHOR_MS -
    daysBack * 86_400_000 -
    hoursBack * 3_600_000 -
    minutesBack * 60_000;
  return new Date(t).toISOString();
}

const CODEBASES: DemoCodebase[] = [
  {
    name: "data-platform/ledger-pipeline",
    description: "Settlement normalization, partner exports, and reconciliation reports.",
  },
  {
    name: "data-platform/cdc-sync",
    description: "Incremental source sync, watermarks, tombstones, and snapshot repair.",
  },
  {
    name: "warehouse/partition-writer",
    description: "UTC partition paths, warehouse loaders, and late-event handling.",
  },
  {
    name: "warehouse/backfill-runner",
    description: "Idempotent historical backfills and replay-safe job orchestration.",
  },
  {
    name: "agent-runtime/tracebase-hooks",
    description: "Claude Code hooks, prompt injection budgets, and memory capture.",
  },
];

const TEAM: DemoTeammate[] = [
  { name: "Nika", role: "Data platform lead" },
  { name: "Amir", role: "Analytics engineer" },
  { name: "Lena", role: "Infra engineer" },
  { name: "Tomas", role: "Backend engineer" },
  { name: "Maya", role: "Data reliability" },
];

const AGENTS: DemoAgent[] = [
  {
    id: "agent-claude-datafix",
    displayName: "datafix-runner · Claude Code",
    framework: "claude-code",
    user: "Nika",
    status: "active",
    lastSeenIso: iso(0, 0, 8),
    totalRuns: 31,
  },
  {
    id: "agent-codex-pr-review",
    displayName: "pr-reviewer · Codex",
    framework: "codex",
    user: "Tomas",
    status: "active",
    lastSeenIso: iso(0, 0, 24),
    totalRuns: 18,
  },
  {
    id: "agent-cursor-dbt",
    displayName: "warehouse-steward · Cursor",
    framework: "cursor",
    user: "Amir",
    status: "active",
    lastSeenIso: iso(0, 1, 6),
    totalRuns: 14,
  },
  {
    id: "agent-sonnet-incident",
    displayName: "incident-debugger · Sonnet",
    framework: "anthropic",
    user: "Maya",
    status: "active",
    lastSeenIso: iso(0, 2, 10),
    totalRuns: 11,
  },
  {
    id: "agent-gpt-ingest",
    displayName: "schema-ingest · GPT-5",
    framework: "openai",
    user: "Production",
    status: "active",
    lastSeenIso: iso(0, 0, 4),
    totalRuns: 46,
  },
  {
    id: "agent-claude-runtime",
    displayName: "hook-maintainer · Claude Code",
    framework: "claude-code",
    user: "Lena",
    status: "idle",
    lastSeenIso: iso(1, 3),
    totalRuns: 9,
  },
];

const RUNS: DemoRun[] = [
  {
    id: "run-ledger-1842",
    framework: "claude-code",
    agentDisplayName: "datafix-runner · Claude Code",
    user: "Nika",
    startedIso: iso(0, 0, 18),
    endedIso: iso(0, 0, 15),
    status: "resolved",
    taskTitle: "Fix settlement NaN after partner v2 export",
    taskRepo: "data-platform/ledger-pipeline",
    profile: "coding",
    patternsUsed: 1,
    toolCalls: 3,
    tokensSaved: 2_950,
  },
  {
    id: "run-cdc-9071",
    framework: "anthropic",
    agentDisplayName: "incident-debugger · Sonnet",
    user: "Maya",
    startedIso: iso(0, 0, 42),
    endedIso: iso(0, 0, 34),
    status: "resolved",
    taskTitle: "Stop incremental sync from replaying the closed watermark",
    taskRepo: "data-platform/cdc-sync",
    profile: "incident",
    patternsUsed: 2,
    toolCalls: 7,
    tokensSaved: 4_700,
  },
  {
    id: "run-partition-5190",
    framework: "cursor",
    agentDisplayName: "warehouse-steward · Cursor",
    user: "Amir",
    startedIso: iso(0, 1, 20),
    endedIso: iso(0, 1, 4),
    status: "resolved",
    taskTitle: "Patch UTC partition writer to zero-pad month and day",
    taskRepo: "warehouse/partition-writer",
    profile: "coding",
    patternsUsed: 1,
    toolCalls: 5,
    tokensSaved: 3_900,
  },
  {
    id: "run-backfill-6631",
    framework: "codex",
    agentDisplayName: "pr-reviewer · Codex",
    user: "Tomas",
    startedIso: iso(0, 2, 10),
    endedIso: iso(0, 1, 54),
    status: "resolved",
    taskTitle: "Review backfill idempotency key before replaying 18M rows",
    taskRepo: "warehouse/backfill-runner",
    profile: "pr_review",
    patternsUsed: 3,
    toolCalls: 9,
    tokensSaved: 6_600,
  },
  {
    id: "run-tombstone-7202",
    framework: "claude-code",
    agentDisplayName: "datafix-runner · Claude Code",
    user: "Nika",
    startedIso: iso(0, 3, 5),
    endedIso: iso(0, 2, 48),
    status: "resolved",
    taskTitle: "Apply CDC tombstone payload with id under entity.id",
    taskRepo: "data-platform/cdc-sync",
    profile: "coding",
    patternsUsed: 2,
    toolCalls: 6,
    tokensSaved: 4_200,
  },
  {
    id: "run-hook-3104",
    framework: "claude-code",
    agentDisplayName: "hook-maintainer · Claude Code",
    user: "Lena",
    startedIso: iso(0, 4, 40),
    endedIso: iso(0, 4, 15),
    status: "resolved",
    taskTitle: "Keep local demo hook from self-healing into npm latest",
    taskRepo: "agent-runtime/tracebase-hooks",
    profile: "coding",
    patternsUsed: 2,
    toolCalls: 8,
    tokensSaved: 5_800,
  },
  {
    id: "run-schema-4420",
    framework: "openai",
    agentDisplayName: "schema-ingest · GPT-5",
    user: "Production",
    startedIso: iso(0, 5, 15),
    endedIso: iso(0, 5, 6),
    status: "resolved",
    taskTitle: "Map partner ledger aliases into canonical settlement schema",
    taskRepo: "data-platform/ledger-pipeline",
    profile: "ingestion",
    patternsUsed: 2,
    toolCalls: 11,
    tokensSaved: 7_400,
  },
  {
    id: "run-dbt-8122",
    framework: "cursor",
    agentDisplayName: "warehouse-steward · Cursor",
    user: "Amir",
    startedIso: iso(1, 1, 10),
    endedIso: iso(1, 0, 50),
    status: "resolved",
    taskTitle: "Backfill mart_daily_revenue after SCD2 customer repair",
    taskRepo: "warehouse/partition-writer",
    profile: "coding",
    patternsUsed: 2,
    toolCalls: 12,
    tokensSaved: 6_100,
  },
  {
    id: "run-loop-1094",
    framework: "claude-code",
    agentDisplayName: "hook-maintainer · Claude Code",
    user: "Lena",
    startedIso: iso(1, 3),
    endedIso: iso(1, 2, 36),
    status: "failed",
    taskTitle: "Investigate duplicate hook registration on inherited Claude settings",
    taskRepo: "agent-runtime/tracebase-hooks",
    profile: "coding",
    patternsUsed: 1,
    toolCalls: 14,
    tokensSaved: 0,
  },
  {
    id: "run-loop-1095",
    framework: "claude-code",
    agentDisplayName: "hook-maintainer · Claude Code",
    user: "Lena",
    startedIso: iso(1, 2, 20),
    endedIso: iso(1, 1, 56),
    status: "resolved",
    taskTitle: "Patch launcher env restore and prevent duplicate recall cost",
    taskRepo: "agent-runtime/tracebase-hooks",
    profile: "coding",
    patternsUsed: 2,
    toolCalls: 6,
    tokensSaved: 8_200,
  },
  {
    id: "run-wm-3801",
    framework: "anthropic",
    agentDisplayName: "incident-debugger · Sonnet",
    user: "Maya",
    startedIso: iso(2, 4),
    endedIso: iso(2, 3, 20),
    status: "resolved",
    taskTitle: "Root-cause late events dropped by hourly loader",
    taskRepo: "warehouse/partition-writer",
    profile: "incident",
    patternsUsed: 2,
    toolCalls: 10,
    tokensSaved: 5_900,
  },
  {
    id: "run-pr-4810",
    framework: "codex",
    agentDisplayName: "pr-reviewer · Codex",
    user: "Tomas",
    startedIso: iso(2, 6),
    endedIso: iso(2, 5, 25),
    status: "resolved",
    taskTitle: "Review PR #412: source_event_id dedupe on replay jobs",
    taskRepo: "warehouse/backfill-runner",
    profile: "pr_review",
    patternsUsed: 4,
    toolCalls: 11,
    tokensSaved: 7_900,
  },
  {
    id: "run-ingest-6120",
    framework: "openai",
    agentDisplayName: "schema-ingest · GPT-5",
    user: "Production",
    startedIso: iso(3, 2),
    endedIso: iso(3, 1, 52),
    status: "resolved",
    taskTitle: "Classify new partner export as v2 ledger rather than refund feed",
    taskRepo: "data-platform/ledger-pipeline",
    profile: "ingestion",
    patternsUsed: 1,
    toolCalls: 8,
    tokensSaved: 4_800,
  },
  {
    id: "run-abandon-2109",
    framework: "cursor",
    agentDisplayName: "warehouse-steward · Cursor",
    user: "Amir",
    startedIso: iso(4, 4),
    endedIso: iso(4, 3, 35),
    status: "abandoned",
    taskTitle: "Try to infer missing source_event_id from row amount only",
    taskRepo: "warehouse/backfill-runner",
    profile: "coding",
    patternsUsed: 0,
    toolCalls: 9,
    tokensSaved: 0,
  },
  {
    id: "run-guard-9920",
    framework: "claude-code",
    agentDisplayName: "datafix-runner · Claude Code",
    user: "Nika",
    startedIso: iso(5, 1),
    endedIso: iso(5, 0, 32),
    status: "resolved",
    taskTitle: "Add guard for NaN settlement totals before report publish",
    taskRepo: "data-platform/ledger-pipeline",
    profile: "coding",
    patternsUsed: 2,
    toolCalls: 10,
    tokensSaved: 5_400,
  },
  {
    id: "run-cascade-7710",
    framework: "codex",
    agentDisplayName: "pr-reviewer · Codex",
    user: "Tomas",
    startedIso: iso(6, 2),
    endedIso: iso(6, 1, 30),
    status: "resolved",
    taskTitle: "Tune pattern gate after low-signal hints increased context cost",
    taskRepo: "agent-runtime/tracebase-hooks",
    profile: "coding",
    patternsUsed: 3,
    toolCalls: 13,
    tokensSaved: 6_300,
  },
];

const PATTERNS: DemoPattern[] = [
  {
    id: "pat-standing-001",
    tier: "standing",
    scope: "universal",
    title: "Fix data at the boundary, not in downstream aggregates",
    body:
      "When a pipeline emits NaN, duplicated rows, or missing partitions, first inspect the normalizer or batch boundary. Downstream reducers should stay simple; hiding bad input there makes the next incident harder to debug.",
    usedCount: 88,
    createdIso: iso(31),
  },
  {
    id: "pat-standing-002",
    tier: "standing",
    scope: "universal",
    title: "Closed watermarks use strict greater-than",
    body:
      "A stored watermark is the last processed timestamp. The next incremental batch must fetch updated_at > watermark. Using >= replays the boundary row and causes duplicate work.",
    usedCount: 64,
    createdIso: iso(26),
    sourceRunId: "run-cdc-9071",
  },
  {
    id: "pat-standing-003",
    tier: "standing",
    scope: "universal",
    title: "Backfills dedupe by source event, not job scope",
    body:
      "The job id is too coarse: one job contains many legitimate events for the same account. Include source_event_id in idempotency keys and only collapse exact retries.",
    usedCount: 43,
    createdIso: iso(19),
    sourceRunId: "run-pr-4810",
  },
  {
    id: "pat-common-001",
    tier: "common",
    scope: "codebase",
    codebase: "data-platform/ledger-pipeline",
    title: "Partner v2 amount alias lives in normalize-ledger-row.js",
    body:
      "Settlement NaN after a partner v2 export maps to src/stages/normalize-ledger-row.js. Patch amountCents to Number(row.amount_cents ?? row.total_cents), then run npm test.",
    usedCount: 17,
    createdIso: iso(2),
    sourceRunId: "run-ledger-1842",
  },
  {
    id: "pat-common-002",
    tier: "common",
    scope: "codebase",
    codebase: "data-platform/cdc-sync",
    title: "CDC tombstones carry delete ids under entity.id",
    body:
      "New source connectors emit delete events as { type: 'delete', entity: { id } }. Keep legacy customer_id support, but read event.customer_id ?? event.entity?.id.",
    usedCount: 21,
    createdIso: iso(6),
    sourceRunId: "run-tombstone-7202",
  },
  {
    id: "pat-common-003",
    tier: "common",
    scope: "codebase",
    codebase: "warehouse/partition-writer",
    title: "UTC partition paths require zero-padded month and day",
    body:
      "Warehouse readers expect dt=YYYY-MM-DD. Always compose paths from UTC date parts and pad month/day with String(value).padStart(2, '0').",
    usedCount: 18,
    createdIso: iso(4),
    sourceRunId: "run-partition-5190",
  },
  {
    id: "pat-common-004",
    tier: "common",
    scope: "codebase",
    codebase: "agent-runtime/tracebase-hooks",
    title: "Demo hooks disable global recall and re-enable local injection only",
    body:
      "Launchers set TRACEBASE_DISABLED=1 to quiet inherited hooks. The local hook runner overrides it to 0 only for the controlled UserPromptSubmit injection.",
    usedCount: 12,
    createdIso: iso(1),
    sourceRunId: "run-loop-1095",
  },
  {
    id: "pat-common-005",
    tier: "common",
    scope: "universal",
    title: "Do not spend prompt tokens on low-confidence hints",
    body:
      "If a candidate memory does not name a concrete file, invariant, or patch shape, keep it out of the prompt. Context cost can erase the savings on small PRs.",
    usedCount: 36,
    createdIso: iso(7),
    sourceRunId: "run-cascade-7710",
  },
  {
    id: "pat-tip-001",
    tier: "tip",
    scope: "codebase",
    codebase: "warehouse/backfill-runner",
    title: "Replay dry-run first 500 rows before full historical backfill",
    body:
      "The dry-run catches schema drift and idempotency key mistakes without writing output. Only promote to full replay after dry-run duplicate rate is below 0.1%.",
    usedCount: 15,
    createdIso: iso(11),
  },
  {
    id: "pat-tip-002",
    tier: "tip",
    scope: "codebase",
    codebase: "agent-runtime/tracebase-hooks",
    title: "Use node --test test on Windows demo workspaces",
    body:
      "PowerShell does not expand test/*.test.js for node --test. Use node --test test so the demo verification is cross-platform and the agent is judged on the bug, not shell glob behavior.",
    usedCount: 9,
    createdIso: iso(1),
  },
];

const FINDINGS: DemoFinding[] = [
  {
    id: "fnd-ledger-001",
    codebase: "data-platform/ledger-pipeline",
    filePath: "src/stages/normalize-ledger-row.js",
    type: "pattern",
    body:
      "Partner v2 rows send total_cents. The normalizer still supports legacy amount_cents, so the safe expression is row.amount_cents ?? row.total_cents before Number().",
    createdIso: iso(2),
    lastUsedIso: iso(0, 0, 18),
  },
  {
    id: "fnd-ledger-002",
    codebase: "data-platform/ledger-pipeline",
    filePath: "src/stages/reconcile-settlement.js",
    type: "note",
    body:
      "Do not patch NaN inside the settlement reducer. The reducer is intentionally dumb so bad input remains visible at the boundary.",
    createdIso: iso(2),
  },
  {
    id: "fnd-cdc-001",
    codebase: "data-platform/cdc-sync",
    filePath: "src/incremental-sync.js",
    type: "bug",
    body:
      "The stored watermark is closed. Fetching >= watermark replays the boundary row. This was the root cause of duplicate work on the May 17 incident.",
    createdIso: iso(4),
    lastUsedIso: iso(0, 0, 42),
  },
  {
    id: "fnd-cdc-002",
    codebase: "data-platform/cdc-sync",
    filePath: "src/customer-snapshot.js",
    type: "pattern",
    body:
      "Delete ids may be event.customer_id or event.entity.id. Keep both while connectors are migrating; removing the legacy branch breaks old replay files.",
    createdIso: iso(6),
    lastUsedIso: iso(0, 3, 5),
  },
  {
    id: "fnd-part-001",
    codebase: "warehouse/partition-writer",
    filePath: "src/partition-path.js",
    type: "pattern",
    body:
      "Partition dates are UTC. Month and day must be zero-padded or the warehouse scanner silently misses the folder.",
    createdIso: iso(4),
    lastUsedIso: iso(0, 1, 20),
  },
  {
    id: "fnd-part-002",
    codebase: "warehouse/partition-writer",
    filePath: "loaders/hourly-loader.ts",
    type: "note",
    body:
      "Late events are loaded into the event date partition, not arrival date. The loader keeps a 36-hour repair window for daily marts.",
    createdIso: iso(5),
    lastUsedIso: iso(2, 4),
  },
  {
    id: "fnd-backfill-001",
    codebase: "warehouse/backfill-runner",
    filePath: "src/backfill-dedupe.js",
    type: "bug",
    body:
      "The old idempotency key account_id:job_id dropped legitimate events. The current key includes source_event_id and only collapses exact retries.",
    createdIso: iso(9),
    lastUsedIso: iso(0, 2, 10),
  },
  {
    id: "fnd-backfill-002",
    codebase: "warehouse/backfill-runner",
    filePath: "jobs/replay.ts",
    type: "pattern",
    body:
      "Replay jobs must emit a dry-run summary first: rows read, rows written, duplicate rate, and first 10 skipped ids. No full write before the summary is reviewed.",
    createdIso: iso(11),
  },
  {
    id: "fnd-hook-001",
    codebase: "agent-runtime/tracebase-hooks",
    filePath: "src/cli/commands/inject-context.ts",
    type: "note",
    body:
      "TRACEBASE_SKIP_HOOK_SELF_HEAL=1 is only for local demo hooks and tests. Production hooks should keep self-heal so older installs receive new managed events.",
    createdIso: iso(1),
    lastUsedIso: iso(0, 4, 40),
  },
  {
    id: "fnd-hook-002",
    codebase: "agent-runtime/tracebase-hooks",
    filePath: "scripts/yc-demo/setup.ts",
    type: "pattern",
    body:
      "Setup smoke must override TRACEBASE_DISABLED=0 while checking indexed injection. Launchers restore the prior env value after Claude exits.",
    createdIso: iso(1),
    lastUsedIso: iso(0, 4, 40),
  },
  {
    id: "fnd-hook-003",
    codebase: "agent-runtime/tracebase-hooks",
    filePath: ".claude/settings.json",
    type: "bug",
    body:
      "Claude Code merges hooks across scopes. If two TB TRACE lines appear, a global hook is running beside the demo hook and cost numbers are contaminated.",
    createdIso: iso(1),
    lastUsedIso: iso(1, 2, 20),
  },
  {
    id: "fnd-ledger-003",
    codebase: "data-platform/ledger-pipeline",
    filePath: "docs/partner-v2-export.md",
    type: "note",
    body:
      "Partner v2 renamed amount_cents to total_cents and moved refunds to a separate feed. Treat total_cents as gross settled amount.",
    createdIso: iso(3),
  },
];

const INSTALLATIONS: DemoInstallation[] = [
  {
    id: "inst-prod-ingest",
    projectName: "data-platform/ledger-pipeline (prod)",
    framework: "openai",
    cliVersion: "0.9.0",
    user: "Production",
    linkedIso: iso(38),
    updatedIso: iso(0, 0, 4),
  },
  {
    id: "inst-nika",
    projectName: "data-platform",
    framework: "claude-code",
    cliVersion: "0.9.0",
    user: "Nika",
    linkedIso: iso(32),
    updatedIso: iso(0, 0, 8),
  },
  {
    id: "inst-amir",
    projectName: "warehouse",
    framework: "cursor",
    cliVersion: "0.9.0",
    user: "Amir",
    linkedIso: iso(30),
    updatedIso: iso(0, 1, 6),
  },
  {
    id: "inst-tomas",
    projectName: "warehouse",
    framework: "codex",
    cliVersion: "0.9.0",
    user: "Tomas",
    linkedIso: iso(24),
    updatedIso: iso(0, 0, 24),
  },
  {
    id: "inst-maya",
    projectName: "data-platform/cdc-sync",
    framework: "anthropic",
    cliVersion: "0.9.0",
    user: "Maya",
    linkedIso: iso(19),
    updatedIso: iso(0, 2, 10),
  },
  {
    id: "inst-lena",
    projectName: "agent-runtime/tracebase-hooks",
    framework: "claude-code",
    cliVersion: "0.9.0",
    user: "Lena",
    linkedIso: iso(12),
    updatedIso: iso(1, 3),
  },
];

const DAILY_RUNS: DemoImpactWindow["dailyRuns"] = [
  { date: iso(6).slice(0, 10), runs: 15, helpful: 10 },
  { date: iso(5).slice(0, 10), runs: 17, helpful: 12 },
  { date: iso(4).slice(0, 10), runs: 19, helpful: 15 },
  { date: iso(3).slice(0, 10), runs: 22, helpful: 17 },
  { date: iso(2).slice(0, 10), runs: 20, helpful: 16 },
  { date: iso(1).slice(0, 10), runs: 24, helpful: 19 },
  { date: iso(0).slice(0, 10), runs: 16, helpful: 13 },
];

const DAILY_IMPACT: DemoImpactWindow["dailyImpact"] = [
  { date: DAILY_RUNS[0].date, costSavedUsd: 4.9, minutesSaved: 12, outputTokensReduced: 18_200 },
  { date: DAILY_RUNS[1].date, costSavedUsd: 5.8, minutesSaved: 15, outputTokensReduced: 22_400 },
  { date: DAILY_RUNS[2].date, costSavedUsd: 6.7, minutesSaved: 18, outputTokensReduced: 26_100 },
  { date: DAILY_RUNS[3].date, costSavedUsd: 7.6, minutesSaved: 21, outputTokensReduced: 31_900 },
  { date: DAILY_RUNS[4].date, costSavedUsd: 7.1, minutesSaved: 19, outputTokensReduced: 28_700 },
  { date: DAILY_RUNS[5].date, costSavedUsd: 8.4, minutesSaved: 24, outputTokensReduced: 35_200 },
  { date: DAILY_RUNS[6].date, costSavedUsd: 5.7, minutesSaved: 16, outputTokensReduced: 23_100 },
];

const TOTAL_RUNS_7D = DAILY_RUNS.reduce((sum, day) => sum + day.runs, 0);
const TOTAL_HELPFUL_7D = DAILY_RUNS.reduce((sum, day) => sum + day.helpful, 0);
const COST_SAVED_7D = DAILY_IMPACT.reduce((sum, day) => sum + day.costSavedUsd, 0);
const WALL_TIME_SAVED_7D = DAILY_IMPACT.reduce((sum, day) => sum + day.minutesSaved, 0);
const OUTPUT_REDUCED_7D = DAILY_IMPACT.reduce(
  (sum, day) => sum + day.outputTokensReduced,
  0,
);

const IMPACT: DemoImpactWindow = {
  runs7d: TOTAL_RUNS_7D,
  resolvedRuns7d: 117,
  helpfulRuns7d: TOTAL_HELPFUL_7D,
  missedRuns7d: TOTAL_RUNS_7D - TOTAL_HELPFUL_7D,
  tokensSaved7d: 227_000,
  tokensSaved30d: 1_060_000,
  costSaved7dUsd: Math.round(COST_SAVED_7D * 100) / 100,
  apiTimeSaved7dMin: 58,
  wallTimeSaved7dMin: WALL_TIME_SAVED_7D,
  outputTokensReduced7d: OUTPUT_REDUCED_7D,
  searchStepsAvoided7d: 314,
  successRate: TOTAL_HELPFUL_7D / TOTAL_RUNS_7D,
  dailyRuns: DAILY_RUNS,
  dailyImpact: DAILY_IMPACT,
};

export const DATA_INFRA_FIXTURE: DataInfraFixture = {
  workspaceDisplayName: "DataInfra pilot · agent memory layer",
  workspaceTagline: "7-day impact across data-platform and warehouse repos",
  codebases: CODEBASES,
  team: TEAM,
  agents: AGENTS,
  runs: RUNS,
  patterns: PATTERNS,
  findings: FINDINGS,
  installations: INSTALLATIONS,
  impact: IMPACT,
};

export function getDataInfraFixture(): DataInfraFixture {
  return DATA_INFRA_FIXTURE;
}
