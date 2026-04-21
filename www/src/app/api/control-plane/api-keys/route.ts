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

  const limit = checkRateLimit({
    bucket: "api-key-create",
    key: userId,
    limit: 12,
    windowMs: 60_000,
  });
  if (!limit.ok) {
    return NextResponse.json(
      { error: "rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } },
    );
  }

  const body = (await req.json().catch(() => null)) as { label?: string } | null;
  const label = (body?.label?.trim() || "CLI install").slice(0, 80);
  const user = await currentUser();
  const store = await getControlPlaneStore();
  const workspace = await store.ensurePersonalWorkspaceForUser({
    clerkUserId: userId,
    email: user?.primaryEmailAddress?.emailAddress ?? null,
    name: user?.fullName ?? user?.firstName ?? null,
  });
  const key = await store.createApiKey(workspace.id, label);

  return NextResponse.json({ key });
}
