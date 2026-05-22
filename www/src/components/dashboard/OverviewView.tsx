import type { DashboardBootstrap } from "@/lib/control-plane/types";
import type { ImpactWindow } from "@/lib/control-plane/usage";
import { EmptyState } from "@/components/dashboard/charts/EmptyState";
import { MetricTile } from "@/components/dashboard/charts/MetricTile";
import { Timeseries } from "@/components/dashboard/charts/Timeseries";
import { ActionPill, SecondaryButton } from "@/components/dashboard/primitives/Buttons";
import {
  IconActivity,
  IconArrowUpRight,
  IconBook,
  IconPattern,
  IconRocket,
} from "@/components/dashboard/primitives/Icons";
import { PageHeader } from "@/components/dashboard/primitives/PageHeader";
import { CardHeaderRow, SectionCard } from "@/components/dashboard/primitives/SectionCard";
import { StatusStrip } from "@/components/dashboard/primitives/StatusStrip";
import type { DataInfraFixture } from "@/lib/demo/data-infra-fixture";

type OverviewProps =
  | {
      demo: false;
      bootstrap: DashboardBootstrap;
      window: ImpactWindow;
    }
  | {
      demo: true;
      fixture: DataInfraFixture;
    };

function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return "just now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatInt(n: number): string {
  return n.toLocaleString();
}

function formatCompactInt(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${Math.round(n / 1_000)}k`;
  return n.toLocaleString();
}

function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function formatMinutes(n: number): string {
  if (n >= 60) {
    const hours = Math.floor(n / 60);
    const minutes = n % 60;
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  }
  return `${n}m`;
}

function formatPercent(rate: number | null): string | null {
  if (rate === null) return null;
  return `${(rate * 100).toFixed(1)}%`;
}

export function OverviewView(props: OverviewProps) {
  if (props.demo) return <DemoOverview fixture={props.fixture} />;
  return <RealOverview bootstrap={props.bootstrap} window={props.window} />;
}

function DemoOverview({ fixture }: { fixture: DataInfraFixture }) {
  const { impact, runs, patterns, findings, agents, codebases, installations } = fixture;
  const successRate = impact.successRate;
  const latestRun = runs[0];
  const dailyLabels = impact.dailyRuns.map((d) => d.date);
  const dailyRuns = impact.dailyRuns.map((d) => d.runs);
  const dailyHelped = impact.dailyRuns.map((d) => d.helpful);
  const dailyCost = impact.dailyImpact.map((d) => Math.round(d.costSavedUsd * 10) / 10);
  const dailyMinutes = impact.dailyImpact.map((d) => d.minutesSaved);

  return (
    <section className="space-y-7" aria-label="Workspace overview">
      <PageHeader
        title={fixture.workspaceDisplayName}
        subtitle={fixture.workspaceTagline}
        actions={
          <>
            <ActionPill href="/dashboard/runs?demo=1" icon={<IconActivity />}>
              Runs
            </ActionPill>
            <ActionPill href="/dashboard/patterns?demo=1" icon={<IconPattern />}>
              Patterns
            </ActionPill>
            <ActionPill href="/dashboard/memory?demo=1" icon={<IconBook />}>
              Memory
            </ActionPill>
          </>
        }
      />

      <StatusStrip
        counters={[
          { value: impact.helpfulRuns7d, label: "helpful", tone: "positive", signed: true },
          {
            value: impact.missedRuns7d,
            label: impact.missedRuns7d === 1 ? "miss" : "misses",
            tone: "negative",
            signed: true,
          },
        ]}
        note={`${impact.runs7d} runs in last 7 days · ${agents.length} active agents across ${codebases.length} codebases`}
        actionRight={<SecondaryButton href="/dashboard/impact?demo=1">Open impact view</SecondaryButton>}
      />

      <section
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4"
        aria-label="Window totals"
      >
        <MetricTile
          label="Runs"
          value={formatInt(impact.runs7d)}
          note="last 7 days · data-infra pilot"
          href="/dashboard/runs?demo=1"
        />
        <MetricTile
          label="Success rate"
          value={formatPercent(successRate) ?? "-"}
          note={`${impact.helpfulRuns7d} helpful out of ${impact.runs7d}`}
          tone={successRate >= 0.5 ? "positive" : "neutral"}
          href="/dashboard/impact?demo=1"
        />
        <MetricTile
          label="Agent cost saved"
          value={formatUsd(impact.costSaved7dUsd)}
          note={`${formatMinutes(impact.apiTimeSaved7dMin)} API time avoided`}
          tone="positive"
          href="/dashboard/impact?demo=1"
        />
        <MetricTile
          label="Output avoided"
          value={formatCompactInt(impact.outputTokensReduced7d)}
          note={`${formatCompactInt(impact.tokensSaved30d)} tokens saved over 30 days`}
          href="/dashboard/impact?demo=1"
        />
      </section>

      <section className="grid gap-3 xl:grid-cols-[1.25fr_0.75fr]">
        <SectionCard
          inset={false}
          header={
            <>
              <p className="text-[13px] font-normal tracking-tight">Memory impact</p>
              <span
                className="rounded-md border px-2 py-1 text-[10px] font-mono uppercase tracking-[0.16em]"
                style={{ borderColor: "var(--border)", color: "var(--text-tertiary)" }}
              >
                7 days
              </span>
            </>
          }
          body={
            <div className="px-1 py-2">
              <Timeseries
                labels={dailyLabels}
                series={[
                  { name: "helpful runs", values: dailyHelped, color: "rgba(255, 122, 92, 0.86)" },
                  { name: "all runs", values: dailyRuns, color: "rgba(125, 211, 252, 0.72)" },
                ]}
                height={150}
              />
            </div>
          }
          footer={`${impact.searchStepsAvoided7d} repeated search steps avoided across ${impact.helpfulRuns7d} helped runs`}
        />

        <SectionCard
          inset={false}
          header={
            <>
              <p className="text-[13px] font-normal tracking-tight">Cost curve</p>
              <SecondaryButton href="/dashboard/impact?demo=1">Open impact</SecondaryButton>
            </>
          }
          body={
            <div className="px-1 py-2">
              <Timeseries
                labels={dailyLabels}
                series={[
                  { name: "cost saved", values: dailyCost, color: "rgba(177, 255, 109, 0.76)" },
                  { name: "minutes saved", values: dailyMinutes, color: "rgba(242, 197, 114, 0.76)" },
                ]}
                height={150}
              />
            </div>
          }
          footer={`${formatUsd(impact.costSaved7dUsd)} total agent spend avoided`}
        />
      </section>

      <section className="grid gap-3 lg:grid-cols-3">
        <SectionCard
          inset={false}
          className="lg:col-span-2"
          header={
            <>
              <p className="text-[13px] font-normal tracking-tight">Recent runs</p>
              <SecondaryButton href="/dashboard/runs?demo=1">View all</SecondaryButton>
            </>
          }
          body={
            <ul className="divide-y" style={{ borderColor: "var(--border)" }}>
              {runs.slice(0, 6).map((r) => (
                <li
                  key={r.id}
                  className="flex flex-col gap-1 px-1 py-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <CardHeaderRow
                    icon={<IconActivity />}
                    actor={<span style={{ color: "var(--text)" }}>{r.taskTitle}</span>}
                    meta={
                      <>
                        · {r.user} · {r.taskRepo}
                      </>
                    }
                  />
                  <span
                    className="text-[11px] font-mono uppercase tracking-[0.18em]"
                    style={{
                      color:
                        r.status === "resolved"
                          ? "var(--accent)"
                          : r.status === "running"
                            ? "#9bd1f5"
                            : "var(--text-tertiary)",
                    }}
                  >
                    {r.status === "resolved" ? "success" : r.status} ·{" "}
                    {formatRelativeTime(r.endedIso ?? r.startedIso)}
                  </span>
                </li>
              ))}
            </ul>
          }
        />

        <SectionCard
          inset={false}
          header={
            <>
              <p className="text-[13px] font-normal tracking-tight">Memory library</p>
              <SecondaryButton href="/dashboard/patterns?demo=1">Open</SecondaryButton>
            </>
          }
          body={
            <div className="grid gap-2 px-1 py-1">
              <LibraryStat label="patterns" value={patterns.length} />
              <LibraryStat label="file findings" value={findings.length} />
              <LibraryStat label="installations" value={installations.length} />
              <LibraryStat label="codebases" value={codebases.length} />
            </div>
          }
          footer={latestRun ? <>last activity {formatRelativeTime(latestRun.startedIso)}</> : <>no activity yet</>}
        />
      </section>

      <SectionCard
        inset={false}
        header={
          <>
            <p className="text-[13px] font-normal tracking-tight">Active codebases</p>
            <span
              className="rounded-md border px-2 py-1 text-[10px] font-mono uppercase tracking-[0.16em]"
              style={{ borderColor: "var(--border)", color: "var(--text-tertiary)" }}
            >
              {codebases.length}
            </span>
          </>
        }
        body={
          <div className="grid gap-2 md:grid-cols-2">
            {codebases.map((c) => {
              const installs = installations.filter((i) =>
                c.name.startsWith(i.projectName.replace(" (prod)", "")) ||
                i.projectName.startsWith(c.name.split("/")[0]),
              ).length;
              const codebaseFindings = findings.filter((f) => f.codebase === c.name).length;
              return (
                <article
                  key={c.name}
                  className="rounded-sm border px-3 py-3"
                  style={{ borderColor: "var(--border)", background: "rgba(255,255,255,0.015)" }}
                >
                  <p className="font-mono text-[12px]" style={{ color: "var(--text)" }}>
                    {c.name}
                  </p>
                  <p
                    className="mt-1 text-[11px] font-light leading-snug"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    {c.description}
                  </p>
                  <p
                    className="mt-2 text-[10px] font-mono uppercase tracking-[0.14em]"
                    style={{ color: "var(--text-tertiary)" }}
                  >
                    {installs} installs · {codebaseFindings} findings
                  </p>
                </article>
              );
            })}
          </div>
        }
      />
    </section>
  );
}

function LibraryStat({ label, value }: { label: string; value: number }) {
  return (
    <div
      className="flex items-center justify-between rounded-sm border px-3 py-2"
      style={{ borderColor: "var(--border)", background: "rgba(255,255,255,0.015)" }}
    >
      <span
        className="text-[10px] font-mono uppercase tracking-[0.18em]"
        style={{ color: "var(--text-tertiary)" }}
      >
        {label}
      </span>
      <span className="font-mono text-[13px]" style={{ color: "var(--text)" }}>
        {value.toLocaleString()}
      </span>
    </div>
  );
}

function RealOverview({
  bootstrap,
  window,
}: {
  bootstrap: DashboardBootstrap;
  window: ImpactWindow;
}) {
  const { observed, estimated } = window.totals;
  const successRate =
    observed.eligibleRuns > 0 ? observed.helpfulRuns / observed.eligibleRuns : null;
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
            <ActionPill href="/dashboard/runs" icon={<IconActivity />}>
              Runs
            </ActionPill>
            <ActionPill href="/dashboard/patterns" icon={<IconPattern />}>
              Patterns
            </ActionPill>
            <ActionPill href="/dashboard/memory" icon={<IconBook />}>
              Memory
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
          note={observed.eligibleRuns === 0 ? "no recorded runs yet" : "across this window"}
          href="/dashboard/runs"
        />
        <MetricTile
          label="Success rate"
          value={formatPercent(successRate) ?? "-"}
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
          note={observed.usedRuns === 0 ? "agents have not acted on a memory yet" : "agent acted on a recalled memory"}
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
