"use client";

import { useMemo, useState } from "react";
import { LoadingButton } from "@/components/ui/LoadingButton";

type DeviceApprovalPanelProps = {
  deviceCode: string;
};

type ApprovalState =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "approved"; workspaceName: string; projectName: string }
  | { kind: "error"; message: string };

export function DeviceApprovalPanel({ deviceCode }: DeviceApprovalPanelProps) {
  const [state, setState] = useState<ApprovalState>({ kind: "idle" });

  const statusText = useMemo(() => {
    switch (state.kind) {
      case "approved":
        return `Linked to ${state.workspaceName}. Return to your terminal and init will finish automatically.`;
      case "error":
        return state.message;
      case "working":
        return "Approving this CLI install…";
      default:
        return "Approve this device and the CLI will finish setup automatically.";
    }
  }, [state]);

  async function approve() {
    setState({ kind: "working" });
    try {
      const res = await fetch("/api/control-plane/device/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceCode }),
      });
      const body = (await res.json().catch(() => null)) as
        | {
            status?: string;
            workspace?: { displayName?: string };
            installation?: { projectName?: string };
            error?: string;
          }
        | null;

      if (!res.ok || body?.status !== "approved") {
        throw new Error(body?.error || "approval failed");
      }

      setState({
        kind: "approved",
        workspaceName: body.workspace?.displayName || "your workspace",
        projectName: body.installation?.projectName || "this project",
      });
    } catch (error) {
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : "approval failed",
      });
    }
  }

  return (
    <div
      className="rounded-sm border p-5"
      style={{
        borderColor: "var(--border)",
        background: "var(--surface)",
      }}
    >
      <p className="text-[10px] font-mono uppercase tracking-[0.18em]" style={{ color: "var(--text-tertiary)" }}>
        CLI install
      </p>
      <h2 className="mt-3 text-[1.15rem] font-light tracking-tight">Connect TraceBase to this terminal session</h2>
      <p className="mt-3 max-w-[34rem] text-[13px] font-light leading-relaxed" style={{ color: "var(--text-secondary)" }}>
        {statusText}
      </p>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <LoadingButton
          type="button"
          loading={state.kind === "working"}
          onClick={approve}
          disabled={state.kind === "approved"}
          className="rounded-sm border px-4 py-2 text-sm font-medium transition-[background-color,border-color,color] hover:[border-color:rgba(237,236,236,0.18)] disabled:cursor-default disabled:opacity-70"
          style={{
            borderColor: "var(--accent)",
            background: "var(--accent)",
            color: "#050505",
          }}
        >
          {state.kind === "approved" ? "Connected" : "Approve install"}
        </LoadingButton>

        <code
          className="rounded-sm border px-3 py-2 text-[11px]"
          style={{
            borderColor: "var(--border)",
            color: "var(--text-tertiary)",
            background: "rgba(255,255,255,0.02)",
          }}
        >
          {deviceCode.slice(0, 8)}
        </code>
      </div>
    </div>
  );
}
