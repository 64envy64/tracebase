import { NextRequest, NextResponse } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import { getControlPlaneStore } from "@/lib/control-plane/store";
import { checkRateLimit } from "@/lib/server/rate-limit";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as { deviceCode?: string } | null;
  if (!body?.deviceCode) {
    return NextResponse.json({ error: "deviceCode is required" }, { status: 400 });
  }

  const limit = checkRateLimit({
    bucket: "device-approve",
    key: userId,
    limit: 30,
    windowMs: 60_000,
  });
  if (!limit.ok) {
    return NextResponse.json(
      { error: "rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } },
    );
  }

  const user = await currentUser();
  const store = await getControlPlaneStore();
  const payload = await store.approveDeviceSession({
    deviceCode: body.deviceCode,
    clerkUserId: userId,
    email: user?.primaryEmailAddress?.emailAddress ?? null,
    name: user?.fullName ?? user?.firstName ?? null,
  });

  if (!payload) {
    return NextResponse.json({ error: "device session not found or no longer approvable" }, { status: 404 });
  }

  return NextResponse.json({
    status: "approved",
    workspace: payload.workspace,
    installation: payload.installation,
  });
}
