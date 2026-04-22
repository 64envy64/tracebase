import Link from "next/link";
import { Funnel } from "@/components/dashboard/charts/Funnel";
import { MetricTile } from "@/components/dashboard/charts/MetricTile";
import { Timeseries } from "@/components/dashboard/charts/Timeseries";
import { EmptyState } from "@/components/dashboard/charts/EmptyState";
import type { ImpactWindow } from "@/lib/control-plane/usage";

const ACCENT_POSITIVE = "rgba(177, 255, 109, 0.85)";
const ACCENT_INJECTED = "rgba(125, 211, 252, 0.85)";
const ACCENT_USED = "rgba(242, 197, 114, 0.85)";

const WINDOW_CHOICES = [
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "90d", label: "90 days" },
] as const;

export type ImpactWindowKey = (typeof WINDOW_CHOICES)[number]["key"];

function formatInt(n: number): string {
  return n.toLocaleString();
}

function formatMs(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} min`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)} s`;
  return `${Math.round(ms)} ms`;
}

function formatRate(value: number | null): string {
  if (value === null) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

export function ImpactView({
  window,
  windowKey,
  installationsCount,
}: {
  window: ImpactWindow;
  windowKey: ImpactWindowKey;
  installationsCount: number;
}) {
  const { totals, buckets } = window;
  const { observed, estimated, integrity } = totals;

  const hasActivity = observed.eligibleRuns > 0;

  const labels = buckets.map((b) => b.date);
  const helpfulSeries = {
    name: "helpful",
    values: buckets.map((b) => b.metrics.observed.helpfulRuns),
    color: ACCENT_POSITIVE,
  };
  const injectedSeries = {
    name: "injected",
    values: buckets.map((b) => b.metrics.observed.injectedRuns),
    color: ACCENT_INJECTED,
  };
  const usedSeries = {
    name: "used",
    values: buckets.map((b) => b.metrics.observed.usedRuns),
    color: ACCENT_USED,
  };

  return (
    <section className="space-y-6" aria-label="Impact — project activity">
      <header className="flex flex-col gap-3">
        <p
          className="text-[10px] font-mono uppercase tracking-[0.22em]"
          style={{ color: "var(--text-tertiary)" }}
        >
          Impact
        </p>
        <h1 className="text-[1.5rem] font-light tracking-[-0.02em] md:text-[1.7rem]">
          Project activity
        </h1>
        <p
          className="max-w-[44rem] text-[13px] font-light leading-relaxed"
          style={{ color: "var(--text-secondary)" }}
        >
          Workspace-scoped rollup across{" "}
          <span style={{ color: "var(--text)" }}>{installationsCount}</span> wired{" "}
          {installationsCount === 1 ? "adapter" : "adapters"}. Per-adapter attribution lands in Phase 2,
          once the local event stream carries an agent tag. Until then, every number below is a
          project total.
        </p>

        <nav
          aria-label="Window"
          className="flex w-fit rounded-sm border text-[11px] font-mono uppercase tracking-[0.18em]"
          style={{ borderColor: "var(--border)", background: "var(--surface)" }}
        >
          {WINDOW_CHOICES.map((w) => {
            const active = w.key === windowKey;
            return (
              <Link
                key={w.key}
                href={`/dashboard/impact?window=${w.key}`}
                className="px-3 py-1.5 transition-[color,background-color]"
                style={{
                  background: active ? "var(--bg)" : "transparent",
                  color: active ? "var(--text)" : "var(--text-tertiary)",
                }}
                aria-current={active ? "page" : undefined}
              >
                {w.label}
              </Link>
            );
          })}
        </nav>
      </header>

      {!hasActivity ? (
        <EmptyState
          title="No samples yet"
          body="The dashboard renders what `tracebase usage sync` pushed. Run an agent turn, then sync."
          hint={
            <>
              Run <span className="font-mono">npx tracebase usage sync</span> in a project directory
              after any session that touched memory.
            </>
          }
        />
      ) : (
        <>
          <section
            className="rounded-sm border p-5"
            style={{ borderColor: "var(--border)", background: "var(--surface)" }}
            aria-label="Funnel"
          >
            <header className="mb-4 flex items-baseline justify-between gap-3">
              <div>
                <p
                  className="text-[10px] font-mono uppercase tracking-[0.22em]"
                  style={{ color: "var(--text-tertiary)" }}
                >
                  Funnel
                </p>
                <h2 className="mt-1 text-[0.98rem] font-medium tracking-tight">
                  eligible → recalled → injected → used → helpful
                </h2>
              </div>
              <span
                className="font-mono text-[11px] uppercase tracking-[0.18em]"
                style={{ color: "var(--text-tertiary)" }}
              >
                distinct queryIds
              </span>
            </header>
            <Funnel
              stages={[
                {
                  label: "Eligible",
                  value: observed.eligibleRuns,
                  hint: "runs that produced any retrieval event",
                },
                {
                  label: "Recalled",
                  value: observed.recalledRuns,
                  hint: "retrieval returned at least one candidate",
                },
                {
                  label: "Injected",
                  value: observed.injectedRuns,
                  hint: "candidate passed the gate and entered the prompt",
                },
                {
                  label: "Used",
                  value: observed.usedRuns,
                  hint: "agent actually followed the injected content",
                },
                {
                  label: "Helpful",
                  value: observed.helpfulRuns,
                  hint: "used ∧ outcome.resolved — §L6 helpfulness definition",
                },
              ]}
            />
          </section>

          <section
            className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4"
            aria-label="Observed counts"
          >
            <MetricTile
              label="Helpful runs"
              value={formatInt(observed.helpfulRuns)}
              note="injected → used → resolved"
              tone="positive"
            />
            <MetricTile
              label="Injected runs"
              value={formatInt(observed.injectedRuns)}
              note="candidate passed the gate"
            />
            <MetricTile
              label="Used runs"
              value={formatInt(observed.usedRuns)}
              note="agent followed the block"
            />
            <MetricTile
              label="Resolved with memory"
              value={formatRate(observed.resolvedRateWithMemory)}
              note="helpful ÷ injected"
            />
          </section>

          <section
            className="grid gap-2.5 sm:grid-cols-2"
            aria-label="Estimated savings"
          >
            <MetricTile
              label="Tokens saved"
              value={
                estimated.tokensSaved.value === null
                  ? null
                  : formatInt(Math.round(estimated.tokensSaved.value))
              }
              note={
                estimated.tokensSaved.value === null
                  ? "waiting for a shadow arm"
                  : `over ${estimated.tokensSaved.sampleSize} paired runs`
              }
              estimate
              formula={estimated.tokensSaved.formula}
              sampleSize={estimated.tokensSaved.sampleSize}
            />
            <MetricTile
              label="Latency saved"
              value={
                estimated.latencySavedMs.value === null
                  ? null
                  : formatMs(estimated.latencySavedMs.value)
              }
              note={
                estimated.latencySavedMs.value === null
                  ? "waiting for a shadow arm"
                  : `over ${estimated.latencySavedMs.sampleSize} paired runs`
              }
              estimate
              formula={estimated.latencySavedMs.formula}
              sampleSize={estimated.latencySavedMs.sampleSize}
            />
          </section>

          {buckets.length >= 2 ? (
            <section
              className="rounded-sm border p-5"
              style={{ borderColor: "var(--border)", background: "var(--surface)" }}
              aria-label="Daily timeseries"
            >
              <header className="mb-4 flex items-baseline justify-between gap-3">
                <div>
                  <p
                    className="text-[10px] font-mono uppercase tracking-[0.22em]"
                    style={{ color: "var(--text-tertiary)" }}
                  >
                    Daily
                  </p>
                  <h2 className="mt-1 text-[0.98rem] font-medium tracking-tight">
                    Runs per day
                  </h2>
                </div>
              </header>
              <Timeseries
                labels={labels}
                series={[helpfulSeries, injectedSeries, usedSeries]}
              />
            </section>
          ) : null}

          {integrity.shadowControlMismatches > 0 || integrity.outcomesWithoutRetrieval > 0 ? (
            <section
              className="rounded-sm border p-4"
              style={{
                borderColor: "var(--border)",
                background: "rgba(242, 197, 114, 0.04)",
              }}
              aria-label="Integrity diagnostics"
            >
              <p
                className="text-[10px] font-mono uppercase tracking-[0.22em]"
                style={{ color: "#f8deb1" }}
              >
                Integrity
              </p>
              <p className="mt-2 text-[12px] font-light leading-relaxed">
                Non-zero values do not invalidate the counts above, but they do signal upstream
                instrumentation issues. Fix these before trusting estimates at scale.
              </p>
              <ul
                className="mt-3 space-y-1 text-[12px] font-mono"
                style={{ color: "var(--text-secondary)" }}
              >
                {integrity.shadowControlMismatches > 0 ? (
                  <li>shadow/control mismatches: {integrity.shadowControlMismatches}</li>
                ) : null}
                {integrity.outcomesWithoutRetrieval > 0 ? (
                  <li>outcomes without retrieval: {integrity.outcomesWithoutRetrieval}</li>
                ) : null}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </section>
  );
}

export function windowKeyToRange(
  key: ImpactWindowKey,
): { afterTs: string; beforeTs: string } {
  const days = key === "7d" ? 7 : key === "90d" ? 90 : 30;
  const now = Date.now();
  const start = now - days * 86_400_000;
  return {
    afterTs: new Date(start).toISOString(),
    beforeTs: new Date(now).toISOString(),
  };
}

export function parseWindowKey(raw: string | undefined): ImpactWindowKey {
  if (raw === "7d" || raw === "30d" || raw === "90d") return raw;
  return "30d";
}
