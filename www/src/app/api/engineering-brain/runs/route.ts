/**
 * POST /api/engineering-brain/runs
 *
 * Bearer-authenticated endpoint for the SDK / CLI to report agent
 * runs. The payload carries counts only — never tool I/O — and the
 * agent display name is upserted on first contact.
 */
import { NextRequest, NextResponse } from "next/server";
import { getControlPlaneStore } from "@/lib/control-plane/store";
import { getEngineeringBrainStore } from "@/lib/control-plane/engineering-brain";
import type { AgentHost, AgentRunSourceKind, AgentRunStatus } from "@/lib/control-plane/types";

export const runtime = "nodejs";

const ALLOWED_HOSTS: AgentHost[] = [
  "claude-code",
  "codex",
  "cursor",
  "openai",
  "anthropic",
  "generic",
];
const ALLOWED_SOURCES: AgentRunSourceKind[] = [
  "manual",
  "github_issue",
  "pull_request",
  "ci_failure",
];
const ALLOWED_STATUSES: AgentRunStatus[] = ["running", "resolved", "failed", "abandoned"];

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const apiKey = authHeader?.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : "";
  if (!apiKey) {
    return NextResponse.json({ error: "missing bearer token" }, { status: 401 });
  }

  const cpStore = await getControlPlaneStore();
  const resolved = await cpStore.resolveWorkspaceByApiKey(apiKey);
  if (!resolved) {
    return NextResponse.json({ error: "invalid api key" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as {
    sessionId?: string;
    agentDisplayName?: string;
    agentHost?: string;
    ownerLabel?: string;
    taskTitle?: string;
    taskSourceKind?: string;
    taskSourceId?: string;
    startedAt?: string;
    endedAt?: string;
    status?: string;
    tokensInjected?: number;
    tokensSavedEstimated?: number;
    toolCallsCount?: number;
    blockedCallsCount?: number;
    recalledPatternsCount?: number;
    recalledFilesCount?: number;
  } | null;

  if (!body?.sessionId || !body.agentDisplayName) {
    return NextResponse.json(
      { error: "sessionId and agentDisplayName are required" },
      { status: 400 },
    );
  }

  const host: AgentHost = ALLOWED_HOSTS.includes(body.agentHost as AgentHost)
    ? (body.agentHost as AgentHost)
    : "generic";
  const sourceKind: AgentRunSourceKind = ALLOWED_SOURCES.includes(
    body.taskSourceKind as AgentRunSourceKind,
  )
    ? (body.taskSourceKind as AgentRunSourceKind)
    : "manual";
  const status: AgentRunStatus = ALLOWED_STATUSES.includes(body.status as AgentRunStatus)
    ? (body.status as AgentRunStatus)
    : "running";

  const store = await getEngineeringBrainStore();
  const agent = await store.upsertAgent({
    workspaceId: resolved.workspace.id,
    displayName: body.agentDisplayName,
    host,
    ...(body.ownerLabel ? { ownerLabel: body.ownerLabel } : {}),
  });
  const run = await store.createAgentRun({
    workspaceId: resolved.workspace.id,
    agentId: agent.id,
    sessionId: body.sessionId,
    ...(body.taskTitle ? { taskTitle: body.taskTitle } : {}),
    taskSourceKind: sourceKind,
    ...(body.taskSourceId ? { taskSourceId: body.taskSourceId } : {}),
    ...(body.startedAt ? { startedAt: body.startedAt } : {}),
    status,
    tokensInjected: numericOrZero(body.tokensInjected),
    tokensSavedEstimated: numericOrZero(body.tokensSavedEstimated),
    toolCallsCount: numericOrZero(body.toolCallsCount),
    blockedCallsCount: numericOrZero(body.blockedCallsCount),
    recalledPatternsCount: numericOrZero(body.recalledPatternsCount),
    recalledFilesCount: numericOrZero(body.recalledFilesCount),
  });
  return NextResponse.json({ agent, run });
}

function numericOrZero(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
