"use client";

import { useMemo, useState } from "react";
import { CopyCommand } from "@/components/CopyButton";
import type { DashboardBootstrap } from "@/lib/control-plane/types";

type KeyCreateState =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "done"; value: string }
  | { kind: "error"; message: string };

function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return "just now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function ApiKeysView({ initialData }: { initialData: DashboardBootstrap }) {
  const [data, setData] = useState(initialData);
  const [keyState, setKeyState] = useState<KeyCreateState>({ kind: "idle" });

  const ciCommand = useMemo(() => {
    const key = keyState.kind === "done" ? keyState.value : "<workspace-api-key>";
    return `TRACEBASE_API_URL=${data.apiBaseUrl} TRACEBASE_API_KEY=${key} npx tracebase init --yes`;
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
    <section className="space-y-5" aria-label="API keys">
      <header className="flex flex-col gap-1.5">
        <p
          className="text-[10px] font-mono uppercase tracking-[0.22em]"
          style={{ color: "var(--text-tertiary)" }}
        >
          API keys
        </p>
        <h1 className="text-[1.5rem] font-light tracking-[-0.02em] md:text-[1.7rem]">
          CI / headless installs
        </h1>
        <p
          className="max-w-[44rem] text-[13px] font-light leading-relaxed"
          style={{ color: "var(--text-secondary)" }}
        >
          Humans should use the picker in{" "}
          <span className="font-mono">npx tracebase init</span>. Keys here are for CI pipelines and
          browserless environments.
        </p>
      </header>

      <article
        className="rounded-sm border"
        style={{ borderColor: "var(--border)", background: "var(--surface)" }}
      >
        <div className="border-b px-5 py-4" style={{ borderColor: "var(--border)" }}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p
                className="text-[10px] font-mono uppercase tracking-[0.22em]"
                style={{ color: "var(--text-tertiary)" }}
              >
                Create
              </p>
              <p className="mt-1 text-[13px] font-light">
                Each key is revealed once. Store it in your CI secret store before navigating away.
              </p>
            </div>
            <button
              type="button"
              onClick={createApiKey}
              disabled={keyState.kind === "working"}
              className="rounded-sm border px-3 py-2 text-sm font-medium transition-[background-color,border-color] disabled:cursor-default disabled:opacity-60"
              style={{
                borderColor: "var(--border)",
                background: "var(--bg)",
                color: "var(--text)",
              }}
            >
              {keyState.kind === "working" ? "Creating…" : "Create API key"}
            </button>
          </div>
        </div>

        <div className="space-y-3 p-5">
          <CopyCommand command={ciCommand} />
          {keyState.kind === "error" ? (
            <p className="text-[12px] font-light" style={{ color: "#f8deb1" }}>
              {keyState.message}
            </p>
          ) : null}
          {keyState.kind === "done" ? (
            <p className="text-[12px] font-light" style={{ color: "var(--text-tertiary)" }}>
              The command above now contains your new key.
            </p>
          ) : null}
        </div>
      </article>

      <article
        className="rounded-sm border"
        style={{ borderColor: "var(--border)", background: "var(--surface)" }}
      >
        <header
          className="flex items-baseline justify-between gap-3 border-b px-5 py-4"
          style={{ borderColor: "var(--border)" }}
        >
          <div>
            <p
              className="text-[10px] font-mono uppercase tracking-[0.22em]"
              style={{ color: "var(--text-tertiary)" }}
            >
              Issued
            </p>
            <p className="mt-1 text-[13px] font-light">
              Active keys on this workspace.
            </p>
          </div>
          <span
            className="rounded-sm border px-2 py-1 text-[10px] font-mono uppercase tracking-[0.16em]"
            style={{ borderColor: "var(--border)", color: "var(--text-tertiary)" }}
          >
            {data.apiKeys.length}
          </span>
        </header>
        {data.apiKeys.length === 0 ? (
          <div className="p-5">
            <p
              className="text-[12px] font-light leading-relaxed"
              style={{ color: "var(--text-secondary)" }}
            >
              No API keys yet. Human installs do not need one — create a key here only when you need
              a browserless install or CI pipeline.
            </p>
          </div>
        ) : (
          <ul>
            {data.apiKeys.map((key) => (
              <li
                key={key.id}
                className="flex items-start justify-between gap-3 border-b px-5 py-3 last:border-b-0"
                style={{ borderColor: "var(--border)" }}
              >
                <div className="min-w-0">
                  <p className="text-[13px] font-light tracking-tight">{key.label}</p>
                  <p className="mt-1 font-mono text-[11px]" style={{ color: "var(--text-tertiary)" }}>
                    {key.prefix}…{key.last4}
                  </p>
                </div>
                <span className="shrink-0 text-[11px] font-light" style={{ color: "var(--text-tertiary)" }}>
                  {formatRelativeTime(key.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </article>
    </section>
  );
}
