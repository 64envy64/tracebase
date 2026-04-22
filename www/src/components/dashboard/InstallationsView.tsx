import type { DashboardBootstrap } from "@/lib/control-plane/types";

type InstallationRow = DashboardBootstrap["installations"][number];

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
 * Inventory surface, not an attribution surface. Lists which adapters
 * a workspace has wired up + basic transport metadata. Deliberately
 * does NOT show per-adapter helpful / injected counts — Phase 1 does
 * not have per-agent event tagging, so any such number would be
 * fabrication. Per-adapter impact lands when Phase 2 tags the event
 * stream.
 */
export function InstallationsView({ installations }: { installations: InstallationRow[] }) {
  return (
    <section className="space-y-5" aria-label="Installations">
      <header className="flex flex-col gap-1.5">
        <p
          className="text-[10px] font-mono uppercase tracking-[0.22em]"
          style={{ color: "var(--text-tertiary)" }}
        >
          Installations
        </p>
        <h1 className="text-[1.5rem] font-light tracking-[-0.02em] md:text-[1.7rem]">
          Linked adapters
        </h1>
        <p
          className="max-w-[44rem] text-[13px] font-light leading-relaxed"
          style={{ color: "var(--text-secondary)" }}
        >
          Wiring inventory — each row is one project × adapter that has linked into this workspace.
          Impact numbers live on the dedicated Impact view.
        </p>
      </header>

      <article
        className="rounded-sm border"
        style={{ borderColor: "var(--border)", background: "var(--surface)" }}
      >
        <header
          className="flex items-baseline justify-between gap-3 border-b px-5 py-4"
          style={{ borderColor: "var(--border)" }}
        >
          <p className="text-[13px] font-light tracking-tight">Active installations</p>
          <span
            className="rounded-sm border px-2 py-1 text-[10px] font-mono uppercase tracking-[0.16em]"
            style={{ borderColor: "var(--border)", color: "var(--text-tertiary)" }}
          >
            {installations.length}
          </span>
        </header>

        {installations.length === 0 ? (
          <div className="p-5">
            <p
              className="text-[12px] font-light leading-relaxed"
              style={{ color: "var(--text-secondary)" }}
            >
              No linked installs yet. Run <code className="font-mono">npx tracebase init</code> in a project
              directory to link it into this workspace.
            </p>
          </div>
        ) : (
          <ul>
            {installations.map((install) => (
              <li
                key={install.id}
                className="flex items-start justify-between gap-3 border-b px-5 py-4 last:border-b-0"
                style={{ borderColor: "var(--border)" }}
              >
                <div className="min-w-0">
                  <p className="text-[14px] font-normal tracking-tight">{install.projectName}</p>
                  <p
                    className="mt-1 text-[11px] font-mono uppercase tracking-[0.18em]"
                    style={{ color: "var(--text-tertiary)" }}
                  >
                    {install.agent}
                    {install.cliVersion ? (
                      <span className="ml-2 normal-case tracking-normal">cli {install.cliVersion}</span>
                    ) : null}
                  </p>
                </div>
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
        )}
      </article>
    </section>
  );
}
