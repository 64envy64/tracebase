/**
 * POST /api/engineering-brain/integrations
 *
 * Creates / upserts a GitHub integration for the authenticated
 * workspace. Tokens are NOT accepted in the body — they are read
 * from server-side env (`TRACEBASE_GITHUB_TOKEN` or `GITHUB_TOKEN`)
 * by the ingest pipeline. The body only carries the repo identity.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  getEngineeringBrainStore,
} from "@/lib/control-plane/engineering-brain";
import { requireAuthenticatedWorkspaceForApi } from "@/lib/control-plane/engineering-brain-server";

export const runtime = "nodejs";

export async function GET() {
  const auth = await requireAuthenticatedWorkspaceForApi();
  if (!auth.ok) return auth.response;
  const store = await getEngineeringBrainStore();
  const integrations = await store.listIntegrations(auth.workspace.id);
  return NextResponse.json({ integrations });
}

export async function POST(req: NextRequest) {
  const auth = await requireAuthenticatedWorkspaceForApi();
  if (!auth.ok) return auth.response;
  const workspace = auth.workspace;
  const body = (await req.json().catch(() => null)) as {
    repoFullName?: string;
    accountLogin?: string;
  } | null;

  if (!body?.repoFullName) {
    return NextResponse.json(
      { error: "repoFullName is required (e.g. 'tracebase/tracebase')" },
      { status: 400 },
    );
  }
  const repoMatch = body.repoFullName.match(/^([^/]+)\/([^/]+)$/);
  if (!repoMatch) {
    return NextResponse.json(
      { error: "repoFullName must be 'owner/repo'" },
      { status: 400 },
    );
  }

  const store = await getEngineeringBrainStore();
  const integration = await store.upsertIntegration({
    workspaceId: workspace.id,
    provider: "github",
    accountLogin: body.accountLogin ?? repoMatch[1],
    repoFullName: body.repoFullName,
    status: "connected",
  });
  return NextResponse.json({ integration });
}
