import type { DashboardBootstrap } from "@/lib/control-plane/types";
import type { ImpactWindow } from "@/lib/control-plane/usage";
import { MetricTile } from "@/components/dashboard/charts/MetricTile";
import { EmptyState } from "@/components/dashboard/charts/EmptyState";
import { PageHeader } from "@/components/dashboard/primitives/PageHeader";
import { ActionPill, SecondaryButton } from "@/components/dashboard/primitives/Buttons";
import { StatusStrip } from "@/components/dashboard/primitives/StatusStrip";
import { CardHeaderRow, SectionCard } from "@/components/dashboard/primitives/SectionCard";
import {
  IconArrowUpRight,
  IconChart,
  IconKey,
  IconLink,
  IconRocket,
} from "@/components/dashboard/primitives/Icons";

/**
 * Overview — landing page for the dashboard.
 *
 * Pure functional surface: title + actions, status strip with
 * headline counts, four clickable metric tiles, a Recent-activity
 * panel. Every tile and every row is a navigation target — no
 * dead-end visual estate. The architectural explainer that used to
 * live at the bottom moved to the marketing site; the dashboard
 * itself shows numbers and links.
 *
 * Tiles drill in like this:
 *   Runs           → /dashboard/runs       (timeline of agent runs)
 *   Success rate   → /dashboard/impact     (funnel + cohort comparison)
 *   Memories used  → /dashboard/memory     (memory status + events)
 *   Tokens saved   → /dashboard/impact     (estimated savings detail)
 */

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

function formatInt(n: number): string {
  return n.toLocaleString();
}

function formatPercent(rate: number | null): string | null {
  if (rate === null) return null;
  return `${(rate * 100).toFixed(1)}%`;
}

export function OverviewView({
  bootstrap,
  window,
}: {
  bootstrap: DashboardBootstrap;
  window: ImpactWindow;
}) {
  const { observed, estimated } = window.totals;
  const successRate =
    observed.eligibleRuns > 0
      ? observed.helpfulRuns / observed.eligibleRuns
      : null;
  const tokensSaved = estimated.tokensSaved.value;
  const misses = Math.max(0, observed.usedRuns - observed.helpfulRuns);

  const recent = [...bootstrap.installations]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 5);

  const latestUpdate = recent[0]?.updatedAt;

  return (
    <section className="space-y-7" aria-label="Workspace overview">
      <PageHeader
        title={bootstrap.workspace.displayName}
        subtitle={latestUpdate ? `last activity ${formatRelativeTime(latestUpdate)}` : "no activity yet"}
        actions={
          <>
            <ActionPill href="/dashboard/impact" icon={<IconChart />}>
              Impact
            </ActionPill>
            <ActionPill href="/dashboard/installations" icon={<IconLink />}>
              Installs
            </ActionPill>
            <ActionPill href="/dashboard/api-keys" icon={<IconKey />}>
              API keys
            </ActionPill>
          </>
        }
      />

      <StatusStrip
        counters={[
          { value: observed.helpfulRuns, label: "helpful", tone: "positive", signed: true },
          { value: misses, label: misses === 1 ? "miss" : "misses", tone: "negative", signed: true },
        ]}
        note={`${observed.eligibleRuns} run${observed.eligibleRuns === 1 ? "" : "s"} in last 30 days`}
        actionRight={<SecondaryButton href="/dashboard/impact">Open impact view</SecondaryButton>}
      />

      <section
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4"
        aria-label="Window totals"
      >
        <MetricTile
          label="Runs"
          value={formatInt(observed.eligibleRuns)}
          note={
            observed.eligibleRuns === 0
              ? "no recorded runs yet"
              : observed.eligibleRuns === 1
                ? "this run"
                : "across this window"
          }
          href="/dashboard/runs"
        />
        <MetricTile
          label="Success rate"
          value={formatPercent(successRate) ?? "—"}
          note={
            successRate === null
              ? "waiting for first resolved run"
              : `${observed.helpfulRuns} of ${observed.eligibleRuns} resolved`
          }
          tone={successRate !== null && successRate >= 0.5 ? "positive" : "neutral"}
          href="/dashboard/impact"
        />
        <MetricTile
          label="Memories used"
          value={formatInt(observed.usedRuns)}
          note={
            observed.usedRuns === 0
              ? "agents have not acted on a memory yet"
              : "agent acted on a recalled memory"
          }
          href="/dashboard/memory"
        />
        <MetricTile
          label="Tokens saved"
          value={tokensSaved === null ? null : formatInt(Math.round(tokensSaved))}
          note={
            tokensSaved === null
              ? "waiting for comparison data"
              : `over ${estimated.tokensSaved.sampleSize} compared runs`
          }
          estimate
          formula={estimated.tokensSaved.formula}
          sampleSize={estimated.tokensSaved.sampleSize}
          href="/dashboard/impact"
        />
      </section>

      <SectionCard
        header={
          <>
            <p className="text-[13px] font-normal tracking-tight">Recent activity</p>
            <SecondaryButton href="/dashboard/runs">View all</SecondaryButton>
          </>
        }
        inset={false}
        body={
          recent.length === 0 ? (
            <EmptyState
              title="No activity yet"
              body="Run `npx tracebase-ai init` in a project to link it here. Once your agent uses a memory, this list fills in."
              artSrc="/octopus.svg"
              artAlt="TraceBase octopus"
              hint={
                <>
                  Need the install command?{" "}
                  <a href="/dashboard/quickstart" className="underline">
                    Open quickstart
                  </a>
                  .
                </>
              }
            />
          ) : (
            <ul className="divide-y" style={{ borderColor: "var(--border)" }}>
              {recent.map((install) => (
                <ActivityRow key={install.id} install={install} />
              ))}
            </ul>
          )
        }
      />
    </section>
  );
}

function ActivityRow({
  install,
}: {
  install: DashboardBootstrap["installations"][number];
}) {
  return (
    <li
      className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
      style={{ borderColor: "var(--border)" }}
    >
      <CardHeaderRow
        icon={<IconRocket />}
        actor={<span style={{ color: "var(--text)" }}>{install.projectName}</span>}
        meta={
          <>
            · {install.agent}
            {install.cliVersion ? (
              <span className="ml-2 normal-case tracking-normal">cli {install.cliVersion}</span>
            ) : null}
          </>
        }
      />
      <div className="flex items-center gap-3 self-end sm:self-auto">
        <span
          className="text-[11px] font-mono uppercase tracking-[0.18em]"
          style={{ color: "var(--text-tertiary)" }}
        >
          {formatRelativeTime(install.updatedAt)}
        </span>
        <SecondaryButton href="/dashboard/installations" icon={<IconArrowUpRight />}>
          Open
        </SecondaryButton>
      </div>
    </li>
  );
}
