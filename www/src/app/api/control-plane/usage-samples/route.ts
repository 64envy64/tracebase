/**
 * POST /api/control-plane/usage-samples
 *
 * CLI-initiated push of a rolled-up UsageMetrics sample for one
 * installation and one time window. Idempotent on
 * (installation, windowStart, windowEnd) — a retried daemon never
 * double-counts.
 *
 * Bearer auth against a workspace API key. The request's
 * `installationId` must belong to the authenticated workspace.
 */
import { NextRequest, NextResponse } from "next/server";
import { getControlPlaneStore } from "@/lib/control-plane/store";
import { parseUsageMetrics } from "@/lib/control-plane/usage";
import { checkRateLimit } from "@/lib/server/rate-limit";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const apiKey = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : "";
  if (!apiKey) {
    return NextResponse.json({ error: "missing bearer token" }, { status: 401 });
  }

  const limit = await checkRateLimit({
    bucket: "usage-sample-push",
    key: requestKey(req, apiKey),
    limit: 120,
    windowMs: 60_000,
  });
  if (!limit.ok) {
    return NextResponse.json(
      { error: "rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } },
    );
  }

  const body = (await req.json().catch(() => null)) as {
    installationId?: string;
    windowStart?: string;
    windowEnd?: string;
    metrics?: Record<string, unknown>;
    cliVersion?: string;
  } | null;

  if (!body?.installationId || !body?.windowStart || !body?.windowEnd || !body?.metrics) {
    return NextResponse.json(
      { error: "installationId, windowStart, windowEnd, metrics are required" },
      { status: 400 },
    );
  }

  if (!isIsoTimestamp(body.windowStart) || !isIsoTimestamp(body.windowEnd)) {
    return NextResponse.json(
      { error: "windowStart and windowEnd must be ISO-8601 timestamps" },
      { status: 400 },
    );
  }

  if (body.windowEnd <= body.windowStart) {
    return NextResponse.json(
      { error: "windowEnd must be strictly greater than windowStart" },
      { status: 400 },
    );
  }

  // Reject payloads that fail UsageMetrics schema validation. The
  // same `parseUsageMetrics` is the authoritative reader on the
  // dashboard side, so a row that would silently fall out of the
  // render pipeline later is blocked at ingest now. This closes
  // the drift where contributor counts (pre-parse) disagreed with
  // fold totals (post-parse).
  if (!parseUsageMetrics(body.metrics)) {
    return NextResponse.json(
      { error: "metrics payload failed UsageMetrics schema validation" },
      { status: 400 },
    );
  }

  const store = await getControlPlaneStore();
  const resolved = await store.resolveWorkspaceByApiKey(apiKey);
  if (!resolved) {
    return NextResponse.json({ error: "invalid api key" }, { status: 401 });
  }

  // Scoping: the installation must belong to the authenticated
  // workspace. This prevents one workspace from pushing samples onto
  // another workspace's installation.
  const installation = await store.getInstallationById({
    workspaceId: resolved.workspace.id,
    installationId: body.installationId,
  });
  if (!installation) {
    return NextResponse.json(
      { error: "installationId does not belong to this workspace" },
      { status: 404 },
    );
  }

  const sample = await store.upsertUsageSample({
    workspaceId: resolved.workspace.id,
    installationId: body.installationId,
    windowStart: body.windowStart,
    windowEnd: body.windowEnd,
    metrics: body.metrics,
    ...(body.cliVersion ? { cliVersion: body.cliVersion } : {}),
  });

  return NextResponse.json({ sample });
}

function requestKey(req: NextRequest, apiKey: string): string {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || apiKey.slice(0, 24);
}

function isIsoTimestamp(value: string): boolean {
  if (typeof value !== "string" || value.length < 10) return false;
  const t = Date.parse(value);
  return Number.isFinite(t);
}
