"use client";

import { useMemo, useState } from "react";
import { CopyCommand } from "@/components/CopyButton";
import type { DashboardBootstrap } from "@/lib/control-plane/types";

type DashboardInstallPanelProps = {
  initialData: DashboardBootstrap;
};

type KeyCreateState =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "done"; value: string }
  | { kind: "error"; message: string };

export function DashboardInstallPanel({ initialData }: DashboardInstallPanelProps) {
  const [data, setData] = useState(initialData);
  const [keyState, setKeyState] = useState<KeyCreateState>({ kind: "idle" });

  const latestInstall = data.installations[0];
  const installCommand = "npx tracebase init";
  const ciCommand = useMemo(() => {
    const key =
      keyState.kind === "done" ? keyState.value : "<workspace-api-key>";
    return `TRACEBASE_API_URL=${data.apiBaseUrl} TRACEBASE_API_KEY=${key} npx tracebase init`;
  }, [data.apiBaseUrl, keyState]);

  async function createApiKey() {
    setKeyState({ kind: "working" });
    try {
      const res = await fetch("/api/control-plane/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "CI / manual install" }),
      });
      const body = (await res.json().catch(() => null)) as
        | {
            key?: {
              id: string;
              workspaceId: string;
              label: string;
              prefix: string;
              last4: string;
              createdAt: string;
              value: string;
            };
            error?: string;
          }
        | null;

      if (!res.ok || !body?.key?.value) {
        throw new Error(body?.error || "failed to create api key");
      }

      setData((current) => ({
        ...current,
        apiKeys: [
          {
            id: body.key!.id,
            workspaceId: body.key!.workspaceId,
            label: body.key!.label,
            prefix: body.key!.prefix,
            last4: body.key!.last4,
            createdAt: body.key!.createdAt,
          },
          ...current.apiKeys,
        ],
      }));
      setKeyState({ kind: "done", value: body.key.value });
    } catch (error) {
      setKeyState({
        kind: "error",
        message: error instanceof Error ? error.message : "failed to create api key",
      });
    }
  }

  return (
    <section
      id="quickstart"
      className="grid gap-3 lg:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]"
      aria-label="Install and workspace overview"
    >
      <article className="rounded-sm border" style={{ borderColor: "var(--border)", background: "var(--bg)" }}>
        <div className="border-b px-4 py-3 md:px-5" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
          <p className="text-[10px] font-mono uppercase tracking-[0.18em]" style={{ color: "var(--text-tertiary)" }}>
            Quickstart
          </p>
          <h2 className="mt-2 text-[1.05rem] font-light tracking-tight">One-command install</h2>
        </div>

        <div className="space-y-4 p-4 md:p-5">
          <p className="max-w-[42rem] text-[13px] font-light leading-relaxed" style={{ color: "var(--text-secondary)" }}>
            Keep the install path agentic and low-friction. Run the command below from the project root.
            If you are already signed into TraceBase in the browser, the CLI will open an approval page and finish the hosted link automatically.
          </p>

          <CopyCommand command={installCommand} />

          <div className="grid gap-2.5 md:grid-cols-3">
            <MetricBox label="Workspace" value={data.workspace.displayName} note={data.workspace.slug} />
            <MetricBox label="Linked installs" value={String(data.installations.length)} note={latestInstall ? latestInstall.projectName : "No linked projects yet"} />
            <MetricBox label="API keys" value={String(data.apiKeys.length)} note={data.apiKeys.length > 0 ? `${data.apiKeys[0].prefix}••${data.apiKeys[0].last4}` : "Generated only when needed"} />
          </div>
        </div>
      </article>

      <article
        id="control"
        className="rounded-sm border"
        style={{ borderColor: "var(--border)", background: "var(--bg)" }}
      >
        <div className="border-b px-4 py-3 md:px-5" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
          <p className="text-[10px] font-mono uppercase tracking-[0.18em]" style={{ color: "var(--text-tertiary)" }}>
            Control plane
          </p>
          <h2 className="mt-2 text-[1.05rem] font-light tracking-tight">Manual / CI fallback</h2>
        </div>

        <div className="space-y-4 p-4 md:p-5">
          <p className="text-[13px] font-light leading-relaxed" style={{ color: "var(--text-secondary)" }}>
            Humans should use <code>npx tracebase init</code>. API keys stay here for CI, headless setup, and custom integrations.
          </p>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={createApiKey}
              disabled={keyState.kind === "working"}
              className="rounded-sm border px-3 py-2 text-sm font-medium transition-[background-color,border-color] disabled:cursor-default disabled:opacity-60"
              style={{
                borderColor: "var(--border)",
                background: "var(--surface)",
                color: "var(--text)",
              }}
            >
              {keyState.kind === "working" ? "Creating…" : "Create API key"}
            </button>

            <span className="text-[11px] font-light" style={{ color: "var(--text-tertiary)" }}>
              {keyState.kind === "done" ? "Shown once below." : "Use only when browser-based install is not available."}
            </span>
          </div>

          <CopyCommand command={ciCommand} />

          {keyState.kind === "error" ? (
            <p className="text-[12px] font-light" style={{ color: "#f8deb1" }}>
              {keyState.message}
            </p>
          ) : null}
        </div>
      </article>
    </section>
  );
}

function MetricBox({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note: string;
}) {
  return (
    <div className="rounded-sm border p-3.5" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
      <p className="text-[10px] font-mono uppercase tracking-[0.16em]" style={{ color: "var(--text-tertiary)" }}>
        {label}
      </p>
      <p className="mt-3 text-[1.3rem] font-light tracking-tight">{value}</p>
      <p className="mt-2 text-[11px] font-light leading-relaxed" style={{ color: "var(--text-tertiary)" }}>
        {note}
      </p>
    </div>
  );
}
