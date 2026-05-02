"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  EmptyState,
  PageHeader,
  StatusPill,
  SurfaceCard,
  formatRelativeTime,
} from "@/components/engineering-brain/shared";
import type { IntegrationRecord } from "@/lib/control-plane/types";

interface Props {
  integrations: IntegrationRecord[];
  hasEnvToken: boolean;
}

export function IntegrationsView({ integrations, hasEnvToken }: Props) {
  const router = useRouter();
  const [repoFullName, setRepoFullName] = useState("");
  const [busy, setBusy] = useState<"connect" | "ingest" | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<
    | { kind: "ok"; text: string }
    | { kind: "err"; text: string }
    | null
  >(null);

  async function connect() {
    if (!repoFullName.trim()) {
      setMessage({ kind: "err", text: "enter a repo as 'owner/name'" });
      return;
    }
    setBusy("connect");
    setMessage(null);
    try {
      const res = await fetch("/api/engineering-brain/integrations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repoFullName: repoFullName.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setMessage({ kind: "err", text: data?.error ?? "failed to add repo" });
        return;
      }
      setRepoFullName("");
      setMessage({ kind: "ok", text: "repository linked" });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function ingest(integrationId: string) {
    setBusy("ingest");
    setBusyId(integrationId);
    setMessage(null);
    try {
      const res = await fetch("/api/engineering-brain/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ integrationId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ kind: "err", text: data?.error ?? "ingest failed" });
        return;
      }
      const c = data?.result?.counts ?? {};
      setMessage({
        kind: "ok",
        text: `Synced — ${c.issues ?? 0} issues, ${c.pullRequests ?? 0} PRs, ${c.commits ?? 0} commits, ${c.failedCi ?? 0} failed CI runs.`,
      });
      router.refresh();
    } finally {
      setBusy(null);
      setBusyId(null);
    }
  }

  return (
    <section className="space-y-6" aria-label="Integrations">
      <PageHeader
        eyebrow="Integrations"
        title="Connect your code home"
        description={
          <>
            Link a GitHub repo so your team&apos;s Engineering Brain can see
            the work coming in: issues, pull requests, review comments, recent
            commits, and CI failures. Nothing is sent to agents as commands —
            it&apos;s background context they can cite when they help.
          </>
        }
      />

      <SurfaceCard
        title="Add a repository"
        meta={hasEnvToken ? "ready to sync" : "needs token"}
      >
        <div className="flex flex-col gap-3 px-5 py-4">
          {!hasEnvToken ? (
            <p
              className="text-[12px] font-light leading-relaxed"
              style={{ color: "var(--text-secondary)" }}
            >
              Ask your engineering admin to set{" "}
              <span className="font-mono">TRACEBASE_GITHUB_TOKEN</span> on the
              server. Tokens are read once at sync time and never stored on
              this dashboard.
            </p>
          ) : null}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              type="text"
              placeholder="owner/repo"
              value={repoFullName}
              onChange={(event) => setRepoFullName(event.target.value)}
              className="w-full rounded-sm border px-3 py-2 text-[13px] font-mono"
              style={{
                background: "var(--bg)",
                color: "var(--text)",
                borderColor: "var(--border)",
              }}
            />
            <button
              type="button"
              disabled={busy !== null}
              onClick={connect}
              className="rounded-sm border px-3 py-2 text-[12px] font-light disabled:opacity-50"
              style={{
                background: "var(--surface)",
                color: "var(--text)",
                borderColor: "var(--border)",
              }}
            >
              {busy === "connect" ? "linking…" : "Link repository"}
            </button>
          </div>
          {message ? (
            <p
              className="text-[12px] font-light"
              style={{
                color:
                  message.kind === "ok"
                    ? "#7adfae"
                    : "#f5a3a3",
              }}
            >
              {message.text}
            </p>
          ) : null}
        </div>
      </SurfaceCard>

      <SurfaceCard
        title={`Linked repositories · ${integrations.length}`}
        meta={hasEnvToken ? "ready to sync" : "needs token"}
      >
        {integrations.length === 0 ? (
          <EmptyState
            title="No repositories linked yet"
            description="Add a GitHub repository above to start pulling in issues, pull requests, review comments, and CI failures."
          />
        ) : (
          <ul className="divide-y" style={{ borderColor: "var(--border)" }}>
            {integrations.map((integration) => (
              <li
                key={integration.id}
                className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <p className="font-mono text-[13px]" style={{ color: "var(--text)" }}>
                      {integration.repoFullName ?? integration.accountLogin}
                    </p>
                    <StatusPill
                      status={integration.status}
                      tone={
                        integration.status === "connected"
                          ? "good"
                          : integration.status === "error"
                            ? "bad"
                            : "neutral"
                      }
                    />
                  </div>
                  <p
                    className="text-[11px] font-light"
                    style={{ color: "var(--text-tertiary)" }}
                  >
                    last sync {formatRelativeTime(integration.lastSyncAt)}
                    {integration.lastError ? ` · ${integration.lastError}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={busy !== null || !hasEnvToken}
                    onClick={() => ingest(integration.id)}
                    className="rounded-sm border px-3 py-1.5 text-[11px] font-light disabled:opacity-50"
                    style={{
                      background: "var(--surface)",
                      color: "var(--text)",
                      borderColor: "var(--border)",
                    }}
                  >
                    {busyId === integration.id ? "syncing…" : "Sync now"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SurfaceCard>
    </section>
  );
}
