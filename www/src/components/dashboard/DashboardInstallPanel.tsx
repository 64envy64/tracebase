"use client";

import { useMemo, useState } from "react";
import { CopyCommand } from "@/components/CopyButton";
import type { DashboardBootstrap } from "@/lib/control-plane/types";

type DashboardInstallPanelProps = {
  initialData: DashboardBootstrap;
};

type AgentId = "claude-code" | "cursor" | "codex";

type KeyCreateState =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "done"; value: string }
  | { kind: "error"; message: string };

type AgentCard = {
  id: AgentId;
  label: string;
  tagline: string;
  surface: string;
  steps: string[];
  verifyHint: string;
};

const INSTALL_COMMAND = "npx tracebase init";

const AGENT_CARDS: readonly AgentCard[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    tagline: "Project-local MCP surface. Best default for interactive debugging loops.",
    surface: ".claude/settings.json + CLAUDE.md",
    steps: [
      "Run the command above in your project root — the picker pre-selects Claude Code.",
      "Restart Claude Code so the MCP server loads.",
      "Run /tools and confirm get_reasoning_patterns is listed.",
    ],
    verifyHint: "Configured per-project. Re-run init in each project you want TraceBase active in.",
  },
  {
    id: "cursor",
    label: "Cursor",
    tagline: "Global MCP config plus per-project AGENTS.md block. Same memory model.",
    surface: "~/.cursor/mcp.json + AGENTS.md",
    steps: [
      "Run the command above — pick Cursor in the arrow-key prompt.",
      "Restart Cursor so MCP reloads.",
      "Open Cursor Settings → MCP and confirm tracebase shows a green indicator.",
    ],
    verifyHint: "MCP server is global; the AGENTS.md instruction file is per-project.",
  },
  {
    id: "codex",
    label: "Codex",
    tagline: "Registers TraceBase through `codex mcp add`. Auto-detects when the codex CLI is on PATH.",
    surface: "codex mcp registry + AGENTS.md",
    steps: [
      "Run the command above — pick Codex in the prompt.",
      "Start a fresh Codex session in the project.",
      "Run `codex mcp list` and confirm tracebase is registered.",
    ],
    verifyHint: "The codex CLI must be installed and on PATH for registration to succeed.",
  },
] as const;

export function DashboardInstallPanel({ initialData }: DashboardInstallPanelProps) {
  const [data, setData] = useState(initialData);
  const [keyState, setKeyState] = useState<KeyCreateState>({ kind: "idle" });
  const [ciOpen, setCiOpen] = useState(false);

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
    <section
      id="quickstart"
      className="space-y-4"
      aria-label="Quickstart — agent adapters"
    >
      <header className="flex flex-col gap-1.5">
        <p
          className="text-[10px] font-mono uppercase tracking-[0.22em]"
          style={{ color: "var(--text-tertiary)" }}
        >
          Quickstart
        </p>
        <h2 className="text-[1.45rem] font-light tracking-[-0.02em] md:text-[1.6rem]">
          Install in under 2 minutes.
        </h2>
        <p
          className="max-w-[48rem] text-[13px] font-light leading-relaxed"
          style={{ color: "var(--text-secondary)" }}
        >
          One command, pick the agent(s) you use with arrow keys. Each adapter is safe to remove:
          <code className="mx-1 font-mono">npx tracebase remove --keep-store</code>
          leaves your local memory DB intact while detaching the MCP surface.
        </p>
      </header>

      <article
        className="flex flex-col justify-between gap-3 rounded-sm border p-4 md:flex-row md:items-center md:gap-6 md:p-5"
        style={{
          borderColor: "var(--border)",
          background: "linear-gradient(180deg, rgba(255,255,255,0.015) 0%, rgba(255,255,255,0) 100%)",
        }}
      >
        <div className="max-w-[42rem]">
          <p
            className="text-[10px] font-mono uppercase tracking-[0.18em]"
            style={{ color: "var(--text-tertiary)" }}
          >
            Custom integration
          </p>
          <p className="mt-2 text-[0.98rem] font-normal tracking-tight">
            Building your own agent framework or need a custom setup?
          </p>
          <p className="mt-2 text-[13px] font-light" style={{ color: "var(--text-secondary)" }}>
            The TraceBase SDK is on npm as <code className="font-mono">tracebase-ai</code>. The MCP server is one
            reference integration — wire the library in directly when you need a tighter fit.
          </p>
        </div>
        <a
          href="https://github.com/64envy64/tracebase"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex shrink-0 items-center gap-2 rounded-sm border px-4 py-2 text-[12px] font-medium tracking-[0.02em] transition-colors"
          style={{
            borderColor: "var(--text)",
            background: "var(--text)",
            color: "var(--bg)",
          }}
        >
          Read the docs
          <span aria-hidden>↗</span>
        </a>
      </article>

      <div className="grid gap-3">
        {AGENT_CARDS.map((card) => (
          <AgentInstallCard key={card.id} card={card} />
        ))}
      </div>

      <article
        id="control"
        className="rounded-sm border"
        style={{ borderColor: "var(--border)", background: "var(--bg)" }}
      >
        <button
          type="button"
          onClick={() => setCiOpen((v) => !v)}
          className="flex w-full items-center justify-between px-4 py-3 text-left md:px-5"
          aria-expanded={ciOpen}
        >
          <div>
            <p
              className="text-[10px] font-mono uppercase tracking-[0.18em]"
              style={{ color: "var(--text-tertiary)" }}
            >
              Control plane
            </p>
            <p className="mt-1 text-[13px] font-light tracking-tight">
              CI and browserless installs
              <span className="ml-2 text-[11px]" style={{ color: "var(--text-tertiary)" }}>
                (API key fallback — humans should use the picker above)
              </span>
            </p>
          </div>
          <span
            className="rounded-sm border px-2 py-1 text-[10px] font-mono uppercase tracking-[0.16em]"
            style={{ borderColor: "var(--border)", color: "var(--text-tertiary)" }}
          >
            {ciOpen ? "hide" : "show"}
          </span>
        </button>

        {ciOpen ? (
          <div className="space-y-4 border-t p-4 md:p-5" style={{ borderColor: "var(--border)" }}>
            <p
              className="text-[13px] font-light leading-relaxed"
              style={{ color: "var(--text-secondary)" }}
            >
              Use this only for CI pipelines, headless installs, or custom integrations that cannot open a
              browser. The picker flow above is the recommended path for humans.
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
                {keyState.kind === "done" ? "Shown once below — copy it now." : "Key is revealed once and never again."}
              </span>
            </div>

            <CopyCommand command={ciCommand} />

            {keyState.kind === "error" ? (
              <p className="text-[12px] font-light" style={{ color: "#f8deb1" }}>
                {keyState.message}
              </p>
            ) : null}
          </div>
        ) : null}
      </article>
    </section>
  );
}

function AgentInstallCard({ card }: { card: AgentCard }) {
  return (
    <article
      className="rounded-sm border"
      style={{ borderColor: "var(--border)", background: "var(--bg)" }}
    >
      <header
        className="flex items-start justify-between gap-4 border-b px-4 py-4 md:px-5"
        style={{ borderColor: "var(--border)", background: "var(--surface)" }}
      >
        <div className="min-w-0">
          <h3 className="text-[0.98rem] font-medium tracking-tight">{card.label}</h3>
          <p
            className="mt-1 text-[12px] font-light leading-relaxed"
            style={{ color: "var(--text-secondary)" }}
          >
            {card.tagline}
          </p>
        </div>
        <span
          className="shrink-0 rounded-sm border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.18em]"
          style={{ borderColor: "var(--border)", color: "var(--text-tertiary)" }}
        >
          {card.surface}
        </span>
      </header>

      <div className="space-y-4 p-4 md:p-5">
        <div className="flex flex-col gap-2">
          <p
            className="text-[10px] font-mono uppercase tracking-[0.22em]"
            style={{ color: "var(--text-tertiary)" }}
          >
            Install
          </p>
          <CopyCommand command={INSTALL_COMMAND} />
        </div>

        <ol className="flex flex-col gap-2.5">
          {card.steps.map((step, index) => (
            <li
              key={step}
              className="flex gap-3 text-[13px] font-light leading-relaxed"
              style={{ color: "var(--text-secondary)" }}
            >
              <span
                className="mt-[1px] inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm border font-mono text-[10px]"
                style={{ borderColor: "var(--border)", color: "var(--text-tertiary)" }}
              >
                {index + 1}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>

        <p
          className="rounded-sm border-l-2 px-3 py-2 text-[12px] font-light leading-relaxed"
          style={{
            borderLeftColor: "var(--border)",
            background: "rgba(255,255,255,0.015)",
            color: "var(--text-tertiary)",
          }}
        >
          {card.verifyHint}
        </p>
      </div>
    </article>
  );
}
