"use client";

import { useMemo, useState } from "react";
import { CopyCommand } from "@/components/CopyButton";
import type { DashboardBootstrap } from "@/lib/control-plane/types";
import { PageHeader } from "@/components/dashboard/primitives/PageHeader";
import { ActionPill, PrimaryButton } from "@/components/dashboard/primitives/Buttons";
import { CardHeaderRow, SectionCard } from "@/components/dashboard/primitives/SectionCard";
import { EmptyState } from "@/components/dashboard/charts/EmptyState";
import {
  IconChart,
  IconCheck,
  IconKey,
  IconLink,
  IconPlus,
  IconRocket,
} from "@/components/dashboard/primitives/Icons";

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

/**
 * API keys — CI / headless install flow.
 *
 * Three explicit states drive the renderer so the user always knows
 * where they are: `idle` (no key created this session yet — show a
 * one-button hero), `working` (button disabled, spinner copy), `done`
 * (success card with the ready-to-paste init command + the new key
 * surfaced once), `error` (error card with retry).
 *
 * Below the create flow, a single list of issued keys with timestamps
 * — no per-row actions beyond what the API exposes today.
 */
export function ApiKeysView({ initialData }: { initialData: DashboardBootstrap }) {
  const [data, setData] = useState(initialData);
  const [keyState, setKeyState] = useState<KeyCreateState>({ kind: "idle" });

  const ciCommand = useMemo(() => {
    const key = keyState.kind === "done" ? keyState.value : "<workspace-api-key>";
    return `TRACEBASE_API_URL=${data.apiBaseUrl} TRACEBASE_API_KEY=${key} npx tracebase-ai init --yes`;
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
    <section className="space-y-7" aria-label="API keys">
      <PageHeader
        title="API keys"
        subtitle="For CI pipelines and headless installs."
        actions={
          <>
            <ActionPill href="/dashboard" icon={<IconRocket />}>
              Overview
            </ActionPill>
            <ActionPill href="/dashboard/impact" icon={<IconChart />}>
              Impact
            </ActionPill>
            <ActionPill href="/dashboard/installations" icon={<IconLink />}>
              Installs
            </ActionPill>
          </>
        }
      />

      <CreatePanel state={keyState} command={ciCommand} onCreate={createApiKey} />

      <SectionCard
        inset={false}
        header={
          <>
            <p className="text-[13px] font-normal tracking-tight">Issued keys</p>
            <span
              className="rounded-md border px-2 py-1 text-[10px] font-mono uppercase tracking-[0.16em]"
              style={{ borderColor: "var(--border)", color: "var(--text-tertiary)" }}
            >
              {data.apiKeys.length}
            </span>
          </>
        }
        body={
          data.apiKeys.length === 0 ? (
            <EmptyState
              title="No keys issued yet"
              body="Create your first key above. Most users never need one — humans should install through the picker in `npx tracebase-ai init`."
            />
          ) : (
            <ul className="divide-y" style={{ borderColor: "var(--border)" }}>
              {data.apiKeys.map((key) => (
                <li
                  key={key.id}
                  className="flex items-start justify-between gap-3 px-1 py-3"
                >
                  <CardHeaderRow
                    icon={<IconKey />}
                    actor={<span style={{ color: "var(--text)" }}>{key.label}</span>}
                    meta={
                      <span className="font-mono normal-case tracking-normal">
                        · {key.prefix}…{key.last4}
                      </span>
                    }
                  />
                  <span
                    className="shrink-0 text-[11px] font-light"
                    style={{ color: "var(--text-tertiary)" }}
                  >
                    {formatRelativeTime(key.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )
        }
      />
    </section>
  );
}

/**
 * The single most-important card on this page. Renders one of four
 * states — idle (call to action), working (disabled + waiting copy),
 * done (success + reveal command), error (retry button).
 *
 * Done-state explicitly tells the user the key is shown once; the
 * command-block below the success line already has the key inlined
 * so a single copy-and-paste finishes the install.
 */
function CreatePanel({
  state,
  command,
  onCreate,
}: {
  state: KeyCreateState;
  command: string;
  onCreate: () => void;
}) {
  if (state.kind === "done") {
    return (
      <SectionCard
        inset={false}
        header={
          <CardHeaderRow
            icon={<IconCheck />}
            actor={<span style={{ color: "var(--accent)" }}>New key ready</span>}
            meta={<>· this is shown only once — copy it now</>}
            actions={
              <PrimaryButton onClick={onCreate} icon={<IconPlus />}>
                Create another
              </PrimaryButton>
            }
          />
        }
        body={
          <div className="space-y-3">
            <p className="text-[12px] font-light" style={{ color: "var(--text-secondary)" }}>
              The command below already includes your new key. Paste it in your CI script or any
              headless environment that needs TraceBase.
            </p>
            <CopyCommand command={command} />
          </div>
        }
      />
    );
  }

  return (
    <SectionCard
      inset={false}
      header={
        <CardHeaderRow
          icon={<IconKey />}
          actor={<span style={{ color: "var(--text)" }}>Create an API key</span>}
          meta={<>· each key is revealed once</>}
          actions={
            <PrimaryButton
              onClick={onCreate}
              disabled={state.kind === "working"}
              icon={<IconPlus />}
            >
              {state.kind === "working" ? "Creating…" : "Create API key"}
            </PrimaryButton>
          }
        />
      }
      body={
        <div className="space-y-3">
          <p className="text-[13px] font-light leading-relaxed" style={{ color: "var(--text-secondary)" }}>
            Use a key in CI scripts or any environment that cannot run the interactive picker. The
            command preview below fills in once you create one.
          </p>
          <CopyCommand command={command} />
          {state.kind === "error" ? (
            <p className="text-[12px] font-light" style={{ color: "#f4a8a8" }}>
              {state.message}
            </p>
          ) : null}
        </div>
      }
    />
  );
}
