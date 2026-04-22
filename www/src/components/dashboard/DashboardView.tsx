"use client";

import type { ReactNode } from "react";
import { ToolbarTag } from "@/components/dashboard/ToolbarTag";
import type { DashboardBootstrap } from "@/lib/control-plane/types";

type InstallationRow = DashboardBootstrap["installations"][number];
type ApiKeyRow = DashboardBootstrap["apiKeys"][number];

function staggerStyle(i: number) {
  return { animationDelay: `${i * 42}ms` } as const;
}

function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return "just now";

  const diffMinutes = Math.floor(diffMs / 60000);
  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function scopeLabel(scope: DashboardBootstrap["workspace"]["scope"] | undefined) {
  switch (scope) {
    case "org":
      return "organization workspace";
    default:
      return "personal workspace";
  }
}

const ARCHITECTURE_SECTIONS = [
  {
    eyebrow: "Capture",
    title: "Successful runs become reusable blocks",
    body: "TraceBase distills every resolved debugging loop into a trigger + body pair. The trigger is what retrieval matches; the body is the reasoning that earned the match.",
  },
  {
    eyebrow: "Recall",
    title: "New work starts from prior wins",
    body: "Before the agent burns tokens, retrieval surfaces the top candidates from procedural and semantic memory. Cold-start exploration gives way to grounded priors.",
  },
  {
    eyebrow: "Inject",
    title: "Only gated candidates reach the prompt",
    body: "Every injection is recorded 1:1 with the payload that rendered into context. Dashboard analytics cannot drift from what the agent actually saw.",
  },
  {
    eyebrow: "Measure",
    title: "Outcome attribution closes the loop",
    body: "Retrieval → injection → agent_used → outcome stay chained by a single queryId. Disproved blocks demote out of serving automatically.",
  },
] as const;

export function DashboardView({ bootstrap }: { bootstrap?: DashboardBootstrap }) {
  const workspace = bootstrap?.workspace;
  const installations = bootstrap?.installations ?? [];
  const apiKeys = bootstrap?.apiKeys ?? [];
  const latestInstall = installations[0];

  const title = workspace?.displayName ?? "production workspace";
  const subtitle = {
    organization: scopeLabel(workspace?.scope),
    environment: "Production",
    lastUpdated: latestInstall
      ? `linked ${formatRelativeTime(latestInstall.updatedAt)}`
      : "no installs linked yet",
  };

  return (
    <article className="space-y-6 pb-6" aria-label="Workspace dashboard">
      <header
        id="overview"
        className="dash-enter flex flex-col gap-4 border-b pb-5 lg:flex-row lg:items-end lg:justify-between"
        style={{ ...staggerStyle(0), borderColor: "var(--border)" }}
      >
        <div>
          <p
            className="text-[10px] font-mono uppercase tracking-[0.22em]"
            style={{ color: "var(--text-tertiary)" }}
          >
            Dashboard
          </p>
          <h1 className="mt-2 text-[1.8rem] font-light tracking-[-0.03em]">{title}</h1>
          <p
            className="mt-2 max-w-3xl text-sm font-light leading-relaxed"
            style={{ color: "var(--text-secondary)" }}
          >
            Hosted control plane for install, reuse analytics, and trace auditability. Real data only —
            mock patterns and audit rows have been removed so nothing on this surface can lie.
          </p>
          <p
            className="mt-3 text-[11px] font-light uppercase tracking-[0.18em]"
            style={{ color: "var(--text-tertiary)" }}
          >
            {subtitle.organization}
            <span className="mx-2">·</span>
            {subtitle.environment}
            <span className="mx-2">·</span>
            {subtitle.lastUpdated}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <ToolbarTag active>{`scope ${workspace?.scope ?? "personal"}`}</ToolbarTag>
          <ToolbarTag>{`installs ${installations.length}`}</ToolbarTag>
          <ToolbarTag>{`api keys ${apiKeys.length}`}</ToolbarTag>
          {workspace?.slug ? <ToolbarTag>{workspace.slug}</ToolbarTag> : null}
        </div>
      </header>

      <section
        id="workspace"
        className="dash-enter grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4"
        aria-label="Workspace snapshot"
        style={staggerStyle(1)}
      >
        <StatTile
          label="Linked installs"
          value={installations.length}
          note={latestInstall ? `${latestInstall.projectName} · ${latestInstall.agent}` : "No linked projects yet"}
        />
        <StatTile
          label="API keys"
          value={apiKeys.length}
          note={apiKeys[0] ? `latest · ${apiKeys[0].label}` : "No API keys issued yet"}
        />
        <StatTile
          label="Workspace scope"
          value={workspace?.scope === "org" ? "org" : "personal"}
          note={workspace?.slug ?? "awaiting link"}
          literal
        />
        <StatTile
          label="Control plane"
          value={bootstrap ? "online" : "offline"}
          note={bootstrap?.apiBaseUrl ?? "no api base url"}
          literal
        />
      </section>

      <section
        id="architecture"
        className="dash-enter grid gap-px overflow-hidden border"
        style={{
          ...staggerStyle(2),
          borderColor: "var(--border)",
          background: "var(--border)",
          gridTemplateColumns: "repeat(auto-fit,minmax(16rem,1fr))",
        }}
        aria-label="How TraceBase works"
      >
        {ARCHITECTURE_SECTIONS.map((section) => (
          <article
            key={section.eyebrow}
            className="flex min-h-[180px] flex-col justify-between p-5 md:p-6"
            style={{ background: "var(--bg)" }}
          >
            <div>
              <p
                className="text-[10px] font-mono uppercase tracking-[0.22em]"
                style={{ color: "var(--text-tertiary)" }}
              >
                {section.eyebrow}
              </p>
              <h3 className="mt-4 text-[0.98rem] font-normal tracking-tight">{section.title}</h3>
            </div>
            <p
              className="mt-5 text-[12px] font-light leading-relaxed"
              style={{ color: "var(--text-secondary)" }}
            >
              {section.body}
            </p>
          </article>
        ))}
      </section>

      <section
        id="installs"
        className="dash-enter grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]"
        style={staggerStyle(3)}
      >
        <InstallationsPanel installations={installations} />
        <ApiKeysPanel apiKeys={apiKeys} />
      </section>

      <section
        id="audit"
        className="dash-enter rounded-sm border p-5"
        aria-label="Audit trail"
        style={{
          ...staggerStyle(4),
          borderColor: "var(--border)",
          background: "var(--surface)",
        }}
      >
        <header className="mb-4 flex flex-col gap-1.5">
          <p
            className="text-[10px] font-mono uppercase tracking-[0.22em]"
            style={{ color: "var(--text-tertiary)" }}
          >
            Audit Trail
          </p>
          <h2 className="text-[0.98rem] font-medium tracking-tight">Retrieval → injection → outcome stay chained</h2>
          <p
            className="max-w-3xl text-[12px] font-light leading-relaxed"
            style={{ color: "var(--text-secondary)" }}
          >
            Every assist carries a stable <code className="font-mono">queryId</code> so reuse quality can
            be measured instead of guessed. The substrate is live — a dedicated query viewer is rolling
            out with the v2 control plane.
          </p>
        </header>
        <EmptyState
          title="No recent runs yet"
          body="Once an agent starts using TraceBase in a linked project, the most recent query → injection → outcome rows will appear here."
          hint="Install an adapter above, run a session, then refresh this page."
        />
      </section>
    </article>
  );
}

function StatTile({
  label,
  value,
  note,
  literal = false,
}: {
  label: string;
  value: number | string;
  note: string;
  literal?: boolean;
}) {
  return (
    <article
      className="rounded-sm border p-4"
      style={{ borderColor: "var(--border)", background: "var(--surface)" }}
    >
      <p
        className="text-[10px] font-mono uppercase tracking-[0.22em]"
        style={{ color: "var(--text-tertiary)" }}
      >
        {label}
      </p>
      <p className={`mt-4 ${literal ? "text-[1.4rem]" : "text-[1.7rem]"} font-light tracking-[-0.03em]`}>
        {typeof value === "number" ? value.toLocaleString() : value}
      </p>
      <p
        className="mt-3 min-h-[2.5rem] text-[12px] font-light leading-relaxed"
        style={{ color: "var(--text-secondary)" }}
      >
        {note}
      </p>
    </article>
  );
}

function InstallationsPanel({ installations }: { installations: InstallationRow[] }) {
  return (
    <article
      className="rounded-sm border"
      style={{ borderColor: "var(--border)", background: "var(--surface)" }}
    >
      <header className="flex items-baseline justify-between gap-3 border-b px-4 py-3 md:px-5" style={{ borderColor: "var(--border)" }}>
        <div>
          <p
            className="text-[10px] font-mono uppercase tracking-[0.22em]"
            style={{ color: "var(--text-tertiary)" }}
          >
            Installations
          </p>
          <h2 className="mt-1 text-[0.95rem] font-medium tracking-tight">Projects linked to this workspace</h2>
        </div>
        <span
          className="rounded-sm border px-2 py-1 text-[10px] font-mono uppercase tracking-[0.16em]"
          style={{ borderColor: "var(--border)", color: "var(--text-tertiary)" }}
        >
          {installations.length}
        </span>
      </header>

      {installations.length === 0 ? (
        <div className="p-5">
          <EmptyState
            title="No linked installs"
            body="Run the picker above in a project directory to link it here. Cold-start terminals still work — the adapter you pick gets wired; the rest stay untouched."
          />
        </div>
      ) : (
        <ul>
          {installations.slice(0, 6).map((install) => (
            <li
              key={install.id}
              className="flex items-start justify-between gap-3 border-b px-4 py-3 last:border-b-0 md:px-5"
              style={{ borderColor: "var(--border)" }}
            >
              <div className="min-w-0">
                <p className="text-[13px] font-light tracking-tight">{install.projectName}</p>
                <p
                  className="mt-1 text-[11px] font-mono uppercase tracking-[0.18em]"
                  style={{ color: "var(--text-tertiary)" }}
                >
                  {install.agent}
                </p>
              </div>
              <span
                className="shrink-0 text-[11px] font-light"
                style={{ color: "var(--text-tertiary)" }}
              >
                {formatRelativeTime(install.updatedAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function ApiKeysPanel({ apiKeys }: { apiKeys: ApiKeyRow[] }) {
  return (
    <article
      className="rounded-sm border"
      style={{ borderColor: "var(--border)", background: "var(--surface)" }}
    >
      <header className="flex items-baseline justify-between gap-3 border-b px-4 py-3 md:px-5" style={{ borderColor: "var(--border)" }}>
        <div>
          <p
            className="text-[10px] font-mono uppercase tracking-[0.22em]"
            style={{ color: "var(--text-tertiary)" }}
          >
            API keys
          </p>
          <h2 className="mt-1 text-[0.95rem] font-medium tracking-tight">Issued for CI / headless installs</h2>
        </div>
        <span
          className="rounded-sm border px-2 py-1 text-[10px] font-mono uppercase tracking-[0.16em]"
          style={{ borderColor: "var(--border)", color: "var(--text-tertiary)" }}
        >
          {apiKeys.length}
        </span>
      </header>

      {apiKeys.length === 0 ? (
        <div className="p-5">
          <EmptyState
            title="No API keys"
            body="Human installs do not need one. Create a key in the CI section of the quickstart only when you need a browserless install."
          />
        </div>
      ) : (
        <ul>
          {apiKeys.slice(0, 6).map((key) => (
            <li
              key={key.id}
              className="flex items-start justify-between gap-3 border-b px-4 py-3 last:border-b-0 md:px-5"
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
  );
}

function EmptyState({
  title,
  body,
  hint,
}: {
  title: string;
  body: string;
  hint?: ReactNode;
}) {
  return (
    <div
      className="rounded-sm border border-dashed px-4 py-6 text-center md:px-6"
      style={{ borderColor: "var(--border)", background: "rgba(255,255,255,0.01)" }}
    >
      <p className="text-[12px] font-mono uppercase tracking-[0.18em]" style={{ color: "var(--text-tertiary)" }}>
        {title}
      </p>
      <p
        className="mt-3 max-w-xl text-[12px] font-light leading-relaxed text-balance mx-auto"
        style={{ color: "var(--text-secondary)" }}
      >
        {body}
      </p>
      {hint ? (
        <p
          className="mt-3 text-[11px] font-light leading-relaxed"
          style={{ color: "var(--text-tertiary)" }}
        >
          {hint}
        </p>
      ) : null}
    </div>
  );
}
