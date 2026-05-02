/**
 * GET /api/engineering-brain/issue-brief?itemId=...
 *
 * Returns an Issue Brief — cited background drawn from already-ingested
 * GitHub items + Engineering Brain memory statuses. Read-only; no
 * writes happen here. Tokens are clamped via `tokenBudget` query param.
 */
import { NextRequest, NextResponse } from "next/server";
import { getEngineeringBrainStore } from "@/lib/control-plane/engineering-brain";
import { buildIssueBrief, renderIssueBriefAsContext } from "@/lib/control-plane/issue-brief";
import { requireAuthenticatedWorkspaceForApi } from "@/lib/control-plane/engineering-brain-server";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireAuthenticatedWorkspaceForApi();
  if (!auth.ok) return auth.response;
  const workspace = auth.workspace;
  const itemId = req.nextUrl.searchParams.get("itemId");
  if (!itemId) {
    return NextResponse.json({ error: "itemId is required" }, { status: 400 });
  }
  const tokenBudgetRaw = req.nextUrl.searchParams.get("tokenBudget");
  const tokenBudget = tokenBudgetRaw ? Number(tokenBudgetRaw) : undefined;
  const includeRendered = req.nextUrl.searchParams.get("rendered") === "1";

  const store = await getEngineeringBrainStore();
  const brief = await buildIssueBrief({
    workspaceId: workspace.id,
    itemId,
    store,
    ...(Number.isFinite(tokenBudget) && tokenBudget && tokenBudget > 0
      ? { tokenBudget }
      : {}),
  });
  if (!brief) {
    return NextResponse.json({ error: "github item not found" }, { status: 404 });
  }
  return NextResponse.json({
    brief,
    ...(includeRendered ? { rendered: renderIssueBriefAsContext(brief) } : {}),
  });
}
