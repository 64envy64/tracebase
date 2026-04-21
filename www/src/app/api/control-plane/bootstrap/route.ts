import { NextResponse } from "next/server";
import { getAuthenticatedDashboardBootstrap } from "@/lib/control-plane/server";
import { checkRateLimit } from "@/lib/server/rate-limit";
import { auth } from "@clerk/nextjs/server";

export const runtime = "nodejs";

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const limit = checkRateLimit({
    bucket: "dashboard-bootstrap",
    key: userId,
    limit: 60,
    windowMs: 60_000,
  });
  if (!limit.ok) {
    return NextResponse.json(
      { error: "rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } },
    );
  }

  const bootstrap = await getAuthenticatedDashboardBootstrap();
  return NextResponse.json(bootstrap);
}
