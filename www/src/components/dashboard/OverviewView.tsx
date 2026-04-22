import type { DashboardBootstrap } from "@/lib/control-plane/types";
import { ToolbarTag } from "@/components/dashboard/ToolbarTag";

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

function scopeLabel(scope: DashboardBootstrap["workspace"]["scope"]): string {
  return scope === "org" ? "organization workspace" : "personal workspace";
}

const ARCHITECTURE_SECTIONS = [
  {
    eyebrow: "Capture",
    title: "Successful runs → reusable blocks",
    body: "Distilled into trigger + body pairs. Trigger is what retrieval matches; body is what gets injected.",
  },
  {
    eyebrow: "Recall",
    title: "New work starts from priors",
    body: "Retrieval surfaces top candidates before the agent burns tokens on cold exploration.",
  },
  {
    eyebrow: "Inject",
    title: "Only gated candidates reach the prompt",
    body: "Every injection is 1:1 with the payload rendered into context. Dashboard cannot drift from what the agent saw.",
  },
  {
    eyebrow: "Measure",
    title: "Outcome attribution closes the loop",
    body: "Retrieval → injection → agent_used → outcome stay chained by queryId. Disproved blocks demote automatically.",
  },
] as const;

export function OverviewView({ bootstrap }: { bootstrap: DashboardBootstrap }) {
  const latestInstall = bootstrap.installations[0];
  return (
    <section className="space-y-6" aria-label="Workspace overview">
      <header
        className="flex flex-col gap-4 border-b pb-5 lg:flex-row lg:items-end lg:justify-between"
        style={{ borderColor: "var(--border)" }}
      >
        <div>
          <p
            className="text-[10px] font-mono uppercase tracking-[0.22em]"
            style={{ color: "var(--text-tertiary)" }}
          >
            Overview
          </p>
          <h1 className="mt-2 text-[1.8rem] font-light tracking-[-0.03em]">
            {bootstrap.workspace.displayName}
          </h1>
          <p
            className="mt-3 text-[11px] font-light uppercase tracking-[0.18em]"
            style={{ color: "var(--text-tertiary)" }}
          >
            {scopeLabel(bootstrap.workspace.scope)}
            <span className="mx-2">·</span>
            {latestInstall
              ? `linked ${formatRelativeTime(latestInstall.updatedAt)}`
              : "no installs linked yet"}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <ToolbarTag active>{`scope ${bootstrap.workspace.scope}`}</ToolbarTag>
          <ToolbarTag>{`installs ${bootstrap.installations.length}`}</ToolbarTag>
          <ToolbarTag>{`api keys ${bootstrap.apiKeys.length}`}</ToolbarTag>
          {bootstrap.workspace.slug ? <ToolbarTag>{bootstrap.workspace.slug}</ToolbarTag> : null}
        </div>
      </header>

      <section
        className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4"
        aria-label="Workspace snapshot"
      >
        <StatTile
          label="Linked installs"
          value={bootstrap.installations.length}
          note={
            latestInstall
              ? `${latestInstall.projectName} · ${latestInstall.agent}`
              : "No linked projects yet"
          }
        />
        <StatTile
          label="API keys"
          value={bootstrap.apiKeys.length}
          note={bootstrap.apiKeys[0] ? `latest · ${bootstrap.apiKeys[0].label}` : "No API keys issued yet"}
        />
        <StatTile
          label="Workspace scope"
          value={bootstrap.workspace.scope === "org" ? "org" : "personal"}
          note={bootstrap.workspace.slug ?? "awaiting link"}
          literal
        />
        <StatTile
          label="Control plane"
          value="online"
          note={bootstrap.apiBaseUrl}
          literal
        />
      </section>

      <section
        className="grid gap-px overflow-hidden border"
        style={{
          borderColor: "var(--border)",
          background: "var(--border)",
          gridTemplateColumns: "repeat(auto-fit,minmax(16rem,1fr))",
        }}
        aria-label="How TraceBase works"
      >
        {ARCHITECTURE_SECTIONS.map((section) => (
          <article
            key={section.eyebrow}
            className="flex min-h-[160px] flex-col justify-between p-5"
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
    </section>
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
