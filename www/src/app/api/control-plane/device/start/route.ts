import { NextRequest, NextResponse } from "next/server";
import { getControlPlaneApiBaseUrl, getControlPlaneStore } from "@/lib/control-plane/store";
import { checkRateLimit } from "@/lib/server/rate-limit";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const limit = checkRateLimit({
    bucket: "device-start",
    key: requestIp(req),
    limit: 20,
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
  const session = await store.startDeviceSession({
    localWorkspaceId: body.localWorkspaceId,
    projectName: body.projectName,
    agent: body.agent,
    ...(body.cliVersion ? { cliVersion: body.cliVersion } : {}),
    verificationUrlBase: getControlPlaneApiBaseUrl(),
  });

  return NextResponse.json(session);
}

function requestIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}
