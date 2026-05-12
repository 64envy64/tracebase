import type { DashboardBootstrap } from "@/lib/control-plane/types";
import { PageHeader } from "@/components/dashboard/primitives/PageHeader";
import { ActionPill } from "@/components/dashboard/primitives/Buttons";
import { CardHeaderRow, SectionCard } from "@/components/dashboard/primitives/SectionCard";
import { EmptyState } from "@/components/dashboard/charts/EmptyState";
import {
  IconAgent,
  IconChart,
  IconKey,
  IconRocket,
} from "@/components/dashboard/primitives/Icons";

type InstallationRow = DashboardBootstrap["installations"][number];

/**
 * Installations — inventory surface, one row per (project × adapter)
 * pair linked into this workspace. Deliberately not an attribution
 * surface — per-adapter helpful counts would require event-tagging
 * we don't have yet, so they don't appear here.
 *
 * Same primitive set as the other section views (PageHeader,
 * SectionCard, CardHeaderRow) so installs feels like the rest of the
 * dashboard rather than a one-off list page.
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

export function InstallationsView({ installations }: { installations: InstallationRow[] }) {
  const projectsCount = new Set(installations.map((i) => i.localWorkspaceId)).size;
  const installationsCount = installations.length;

  return (
    <section className="space-y-7" aria-label="Installations">
      <PageHeader
        title="Installations"
        subtitle={`${projectsCount} project${projectsCount === 1 ? "" : "s"} · ${installationsCount} install${installationsCount === 1 ? "" : "s"}`}
        actions={
          <>
            <ActionPill href="/dashboard" icon={<IconRocket />}>
              Overview
            </ActionPill>
            <ActionPill href="/dashboard/impact" icon={<IconChart />}>
              Impact
            </ActionPill>
            <ActionPill href="/dashboard/api-keys" icon={<IconKey />}>
              API keys
            </ActionPill>
          </>
        }
      />

      <SectionCard
        inset={false}
        header={
          <>
            <p className="text-[13px] font-normal tracking-tight">All installs</p>
            <span
              className="rounded-md border px-2 py-1 text-[10px] font-mono uppercase tracking-[0.16em]"
              style={{ borderColor: "var(--border)", color: "var(--text-tertiary)" }}
            >
              {installationsCount}
            </span>
          </>
        }
        body={
          installations.length === 0 ? (
            <EmptyState
              title="No installs linked yet"
              body="Run `npx tracebase-ai init` in a project directory to link it into this workspace."
              artSrc="/octopus.svg"
              artAlt="TraceBase octopus"
            />
          ) : (
            <ul className="divide-y" style={{ borderColor: "var(--border)" }}>
              {installations.map((install) => (
                <li
                  key={install.id}
                  className="flex flex-col gap-2 px-1 py-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <CardHeaderRow
                    icon={<IconAgent />}
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
                  <div
                    className="shrink-0 text-right text-[11px] font-light"
                    style={{ color: "var(--text-tertiary)" }}
                  >
                    <p>linked {formatRelativeTime(install.createdAt)}</p>
                    <p>updated {formatRelativeTime(install.updatedAt)}</p>
                  </div>
                </li>
              ))}
            </ul>
          )
        }
      />
    </section>
  );
}
