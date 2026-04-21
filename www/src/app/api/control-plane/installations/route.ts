import { NextRequest, NextResponse } from "next/server";
import { getControlPlaneStore } from "@/lib/control-plane/store";
import { checkRateLimit } from "@/lib/server/rate-limit";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const apiKey = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : "";
  if (!apiKey) {
    return NextResponse.json({ error: "missing bearer token" }, { status: 401 });
  }

  const limit = checkRateLimit({
    bucket: "install-upsert",
    key: requestKey(req, apiKey),
    limit: 60,
    windowMs: 60_000,
  });
  if (!limit.ok) {
    return NextResponse.json(
      { error: "rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } },
    );
  }

  const body = (await req.json().catch(() => null)) as {
    localWorkspaceId?: string;
    projectName?: string;
    agent?: string;
    cliVersion?: string;
  } | null;

  if (!body?.localWorkspaceId || !body?.projectName || !body?.agent) {
    return NextResponse.json(
      { error: "localWorkspaceId, projectName, and agent are required" },
      { status: 400 },
    );
  }

  const store = await getControlPlaneStore();
  const resolved = await store.resolveWorkspaceByApiKey(apiKey);
  if (!resolved) {
    return NextResponse.json({ error: "invalid api key" }, { status: 401 });
  }

  const installation = await store.upsertInstallation({
    workspaceId: resolved.workspace.id,
    localWorkspaceId: body.localWorkspaceId,
    projectName: body.projectName,
    agent: body.agent,
    ...(body.cliVersion ? { cliVersion: body.cliVersion } : {}),
  });

  return NextResponse.json({ installation });
}

function requestKey(req: NextRequest, apiKey: string): string {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || apiKey.slice(0, 24);
}
