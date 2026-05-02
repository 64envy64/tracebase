/**
 * POST /api/engineering-brain/memory
 *
 * Memory governance — single endpoint with an `action` discriminator
 * keeps action wiring simple and the audit trail consistent. Every
 * action writes a memory_event; rollback also writes a rollback_event.
 *
 * Hard delete keeps the row's id so memory_events keep referring to a
 * real record — only the snapshot fields (trig_situation, body_preview)
 * are nulled. The body itself never lived in this store.
 */
import { NextRequest, NextResponse } from "next/server";
import { getEngineeringBrainStore } from "@/lib/control-plane/engineering-brain";
import { requireAuthenticatedWorkspace } from "@/lib/control-plane/engineering-brain-server";
import type { MemoryEventActorKind } from "@/lib/control-plane/types";

export const runtime = "nodejs";

type Action = "retire" | "delete" | "supersede" | "rollback" | "upsert";

export async function POST(req: NextRequest) {
  const workspace = await requireAuthenticatedWorkspace();
  const body = (await req.json().catch(() => null)) as {
    action?: Action;
    memoryId?: string;
    reason?: string;
    trigSituation?: string;
    bodyPreview?: string;
    actorLabel?: string;
  } | null;

  if (!body?.action || !body.memoryId) {
    return NextResponse.json(
      { error: "action and memoryId are required" },
      { status: 400 },
    );
  }

  const store = await getEngineeringBrainStore();
  const actorKind: MemoryEventActorKind = "human";
  const actorId = body.actorLabel ?? "dashboard-user";

  if (body.action === "upsert") {
    const status = await store.upsertMemoryStatus({
      workspaceId: workspace.id,
      memoryId: body.memoryId,
      ...(body.trigSituation ? { trigSituation: body.trigSituation } : {}),
      ...(body.bodyPreview ? { bodyPreview: body.bodyPreview } : {}),
      provenanceKind: "manual",
    });
    await store.createMemoryEvent({
      workspaceId: workspace.id,
      memoryId: body.memoryId,
      actorKind,
      actorId,
      action: "created",
      ...(body.reason ? { reason: body.reason } : {}),
    });
    return NextResponse.json({ status });
  }

  if (body.action === "rollback") {
    const result = await store.rollbackMemoryStatus({
      workspaceId: workspace.id,
      memoryId: body.memoryId,
      actorKind,
      actorId,
      reason: body.reason ?? "manual rollback",
    });
    if (!result) {
      return NextResponse.json(
        { error: "no prior transition to roll back" },
        { status: 409 },
      );
    }
    return NextResponse.json(result);
  }

  const toStatus =
    body.action === "retire"
      ? "retired"
      : body.action === "delete"
        ? "deleted"
        : "superseded";

  const result = await store.changeMemoryStatus({
    workspaceId: workspace.id,
    memoryId: body.memoryId,
    toStatus,
    actorKind,
    actorId,
    ...(body.reason ? { reason: body.reason } : {}),
  });
  return NextResponse.json(result);
}
