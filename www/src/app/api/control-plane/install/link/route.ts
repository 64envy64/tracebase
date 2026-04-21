import { NextRequest, NextResponse } from "next/server";
import { getControlPlaneApiBaseUrl, getControlPlaneStore } from "@/lib/control-plane/store";
import { checkRateLimit } from "@/lib/server/rate-limit";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const apiKey = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : "";
  if (!apiKey) {
    return NextResponse.json({ error: "missing bearer token" }, { status: 401 });
  }

  const limit = checkRateLimit({
    bucket: "install-link",
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

  const store = await getControlPlaneStore();
  const resolved = await store.resolveWorkspaceByApiKey(apiKey);
  if (!resolved) {
    return NextResponse.json({ error: "invalid api key" }, { status: 401 });
  }

  return NextResponse.json({
    apiBaseUrl: getControlPlaneApiBaseUrl(),
    workspace: resolved.workspace,
  });
}

function requestKey(req: NextRequest, apiKey: string): string {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || apiKey.slice(0, 24);
}
