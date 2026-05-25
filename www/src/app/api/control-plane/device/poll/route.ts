import { NextRequest, NextResponse } from "next/server";
import { getControlPlaneStore } from "@/lib/control-plane/store";
import { checkRateLimit } from "@/lib/server/rate-limit";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { deviceCode?: string } | null;
  if (!body?.deviceCode) {
    return NextResponse.json({ error: "deviceCode is required" }, { status: 400 });
  }

  const limit = await checkRateLimit({
    bucket: "device-poll",
    key: body.deviceCode,
    limit: 240,
    windowMs: 10 * 60_000,
  });
  if (!limit.ok) {
    return NextResponse.json(
      { error: "rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } },
    );
  }

  const store = await getControlPlaneStore();
  const result = await store.pollDeviceSession(body.deviceCode);
  if (result.status === "not_found") {
    return NextResponse.json({ error: "device session not found" }, { status: 404 });
  }
  if (result.status === "expired") {
    return NextResponse.json({ status: "expired" });
  }
  if (result.status === "pending") {
    return NextResponse.json({ status: "pending", expiresAt: result.expiresAt });
  }

  return NextResponse.json({
    status: "approved",
    workspace: result.payload.workspace,
    apiKey: result.payload.apiKey,
    installation: result.payload.installation,
  });
}
