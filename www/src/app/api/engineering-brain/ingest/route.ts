/**
 * POST /api/engineering-brain/ingest
 *
 * Trigger a GitHub ingest for one of the workspace's integrations.
 * Reads the PAT from server env vars only — never accepts tokens
 * in the request body. The ingest pipeline updates the integration
 * status (`connected` / `error`) and writes bounded summaries of
 * issues, PRs, review comments, commits, and check runs.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  getEngineeringBrainStore,
} from "@/lib/control-plane/engineering-brain";
import {
  createGithubClient,
  resolveGithubTokenFromEnv,
} from "@/lib/control-plane/github-client";
import { ingestRepo } from "@/lib/control-plane/github-ingest";
import { requireAuthenticatedWorkspace } from "@/lib/control-plane/engineering-brain-server";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const workspace = await requireAuthenticatedWorkspace();
  const body = (await req.json().catch(() => null)) as {
    integrationId?: string;
  } | null;
  if (!body?.integrationId) {
    return NextResponse.json(
      { error: "integrationId is required" },
      { status: 400 },
    );
  }
  const token = resolveGithubTokenFromEnv();
  if (!token) {
    return NextResponse.json(
      {
        error:
          "no github token configured — set TRACEBASE_GITHUB_TOKEN in the server environment",
      },
      { status: 412 },
    );
  }
  const store = await getEngineeringBrainStore();
  const integrations = await store.listIntegrations(workspace.id);
  const integration = integrations.find((i) => i.id === body.integrationId);
  if (!integration) {
    return NextResponse.json(
      { error: "integration not found in this workspace" },
      { status: 404 },
    );
  }

  const client = createGithubClient({ token });
  const result = await ingestRepo({
    workspaceId: workspace.id,
    integration,
    client,
    store,
  });

  return NextResponse.json({ result });
}
