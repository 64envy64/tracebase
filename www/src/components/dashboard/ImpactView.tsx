import Link from "next/link";
import { Funnel } from "@/components/dashboard/charts/Funnel";
import { MetricTile } from "@/components/dashboard/charts/MetricTile";
import { Timeseries } from "@/components/dashboard/charts/Timeseries";
import { EmptyState } from "@/components/dashboard/charts/EmptyState";
import { PageHeader } from "@/components/dashboard/primitives/PageHeader";
import { ActionPill } from "@/components/dashboard/primitives/Buttons";
import { IconKey, IconLink, IconRocket } from "@/components/dashboard/primitives/Icons";
import type { ImpactWindow } from "@/lib/control-plane/usage";
import type { UsageCausal, UsageCohort } from "@/lib/usage/types";

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
  projectsCount,
  installationsCount,
}: {
  window: ImpactWindow;
  windowKey: ImpactWindowKey;
  projectsCount: number;
  installationsCount: number;
}) {
  const { totals, buckets } = window;
  const { observed, estimated, integrity } = totals;

  const hasActivity = observed.eligibleRuns > 0;
  const projectsLabel = projectsCount === 1 ? "project" : "projects";
  const installsLabel = installationsCount === 1 ? "installation" : "installations";

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
    <section className="space-y-6" aria-label="Savings and memory impact">
      <PageHeader
        title="Impact"
        subtitle={`${projectsCount} ${projectsLabel} · ${installationsCount} ${installsLabel} in this window`}
        actions={
          <>
            <ActionPill href="/dashboard" icon={<IconRocket />}>
              Overview
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

      <nav
        aria-label="Window"
        className="flex w-fit overflow-hidden rounded-lg border text-[11px] font-mono uppercase tracking-[0.18em]"
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

      {!hasActivity ? (
        <EmptyState
          title="No savings yet"
          body="The octopus is waiting. Run a few Claude Code tasks with TraceBase attached, then sync this project."
          artSrc="/octopus.svg"
          artAlt="TraceBase octopus"
          hint={
            <>
              Run <span className="font-mono">npx tracebase-ai usage sync</span> in a project directory
              after any session that touched memory.
            </>
          }
        />
      ) : (
        <>
          <section
            className="rounded-lg border p-5"
            style={{ borderColor: "var(--border)", background: "var(--surface)" }}
            aria-label="Task-to-win funnel"
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
                  From task to win
                </h2>
              </div>
              <span
                className="font-mono text-[11px] uppercase tracking-[0.18em]"
                style={{ color: "var(--text-tertiary)" }}
              >
                tasks
              </span>
            </header>
            <Funnel
              stages={[
                {
                  label: "Agent tasks",
                  value: observed.eligibleRuns,
                  hint: "tasks where TraceBase checked memory",
                },
                {
                  label: "Matched memory",
                  value: observed.recalledRuns,
                  hint: "found at least one relevant memory",
                },
                {
                  label: "Shown",
                  value: observed.injectedRuns,
                  hint: "memory was added to the agent context",
                },
                {
                  label: "Used",
                  value: observed.usedRuns,
                  hint: "agent acted on the memory",
                },
                {
                  label: "Helped",
                  value: observed.helpfulRuns,
                  hint: "the task resolved after the memory was used",
                },
              ]}
            />
          </section>

          <section
            className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4"
            aria-label="Observed counts"
          >
            <MetricTile
              label="Tasks helped"
              value={formatInt(observed.helpfulRuns)}
              note="memory used and task resolved"
              tone="positive"
            />
            <MetricTile
              label="Memories shown"
              value={formatInt(observed.injectedRuns)}
              note="added to the agent context"
            />
            <MetricTile
              label="Memories used"
              value={formatInt(observed.usedRuns)}
              note="agent actually acted on them"
            />
            <MetricTile
              label="Success with memory"
              value={formatRate(observed.resolvedRateWithMemory)}
              note="helped tasks out of shown memories"
            />
          </section>

          <CausalSection causal={totals.causal} />

          <section aria-label="Diagnostic estimate (shadow-based)">
            <header className="mb-3 flex flex-col gap-1">
              <p
                className="text-[10px] font-mono uppercase tracking-[0.22em]"
                style={{ color: "var(--text-tertiary)" }}
              >
                Token savings
              </p>
              <h2 className="text-[0.98rem] font-medium tracking-tight">
                With TraceBase vs without
              </h2>
              <p
                className="max-w-[44rem] text-[12px] font-light leading-relaxed"
                style={{ color: "var(--text-secondary)" }}
              >
                A plain estimate for teams that have not collected enough held-out comparison data
                yet. The measured block above takes over when both groups are large enough.
              </p>
            </header>
            <div className="grid gap-2.5 sm:grid-cols-2">
              <MetricTile
                label="Tokens saved"
                value={
                  estimated.tokensSaved.value === null
                    ? null
                    : formatInt(Math.round(estimated.tokensSaved.value))
                }
                note={
                  estimated.tokensSaved.value === null
                    ? "waiting for comparison data"
                    : `over ${estimated.tokensSaved.sampleSize} compared runs`
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
                    ? "waiting for comparison data"
                    : `over ${estimated.latencySavedMs.sampleSize} compared runs`
                }
                estimate
                formula={estimated.latencySavedMs.formula}
                sampleSize={estimated.latencySavedMs.sampleSize}
              />
            </div>
          </section>

          {buckets.length >= 2 ? (
            <section
              className="rounded-lg border p-5"
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
              className="rounded-lg border p-4"
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

/**
 * Assisted-vs-held-out causal comparison. The only surface on
 * `/dashboard/impact` that may report a causal lift. Renders
 * strictly from `metrics.causal`; never infers from `estimated`,
 * never blends.
 *
 * Three states, matching the Phase 3.3 contract:
 *   - absent        → `metrics.causal` undefined → "no causal data
 *                     yet" card.
 *   - under threshold → cohort sizes visible, lift fields null,
 *                       explicit waiting copy.
 *   - above threshold → cohort cards + lift tiles with formulas
 *                       and sample sizes. Lifts are observed
 *                       comparisons, not estimates — no `≈` badge.
 */
function CausalSection({ causal }: { causal?: UsageCausal }) {
  if (!causal) {
    return (
      <section aria-label="Measured comparison" className="space-y-3">
        <CausalHeader />
        <EmptyState
          title="No measured lift yet"
          body="Enable the comparison group by re-running `npx tracebase-ai init --holdout-rate 0.1`. Once enough held-out tasks finish, this block shows measured lift."
          hint={
            <>
              See <span className="font-mono">npx tracebase-ai doctor</span> to inspect the
              current measurement state.
            </>
          }
        />
      </section>
    );
  }

  const cohortReady =
    causal.assisted.n >= causal.minCohortSize && causal.holdout.n >= causal.minCohortSize;

  return (
    <section aria-label="Measured comparison" className="space-y-3">
      <CausalHeader cohortReady={cohortReady} minCohortSize={causal.minCohortSize} />

      <div className="grid gap-2.5 sm:grid-cols-2">
        <CohortCard label="With TraceBase" cohort={causal.assisted} tone="positive" />
        <CohortCard label="Held out" cohort={causal.holdout} tone="neutral" />
      </div>

      {cohortReady ? (
        <div className="grid gap-2.5 sm:grid-cols-3">
          <MetricTile
            label="Task success lift"
            value={
              causal.resolvedLift === null
                ? null
                : formatRateLift(causal.resolvedLift)
            }
            note="with TraceBase minus held-out"
            tone="positive"
          />
          <MetricTile
            label="Tokens saved"
            value={
              causal.tokensLift.value === null
                ? null
                : formatInt(Math.round(causal.tokensLift.value))
            }
            note={
              causal.tokensLift.value === null
                ? "waiting for comparison data"
                : `over ${causal.tokensLift.sampleSize} compared outcomes`
            }
            formula={causal.tokensLift.formula}
            sampleSize={causal.tokensLift.sampleSize}
          />
          <MetricTile
            label="Latency saved"
            value={
              causal.latencyLift.value === null
                ? null
                : formatMs(causal.latencyLift.value)
            }
            note={
              causal.latencyLift.value === null
                ? "waiting for comparison data"
                : `over ${causal.latencyLift.sampleSize} compared outcomes`
            }
            formula={causal.latencyLift.formula}
            sampleSize={causal.latencyLift.sampleSize}
          />
        </div>
      ) : (
        <div
          className="rounded-lg border px-4 py-4"
          style={{ borderColor: "var(--border)", background: "rgba(255,255,255,0.02)" }}
        >
          <p
            className="text-[12px] font-light leading-relaxed"
            style={{ color: "var(--text-secondary)" }}
          >
            Waiting for each cohort to reach{" "}
            <span className="font-mono" style={{ color: "var(--text)" }}>
              n = {causal.minCohortSize}
            </span>
            . Lift is only computed once both groups meet the threshold — earlier numbers would be
            too noisy to report honestly.
          </p>
          <p
            className="mt-2 text-[11px] font-light"
            style={{ color: "var(--text-tertiary)" }}
          >
            Remaining: with TraceBase {Math.max(0, causal.minCohortSize - causal.assisted.n)} · held-out{" "}
            {Math.max(0, causal.minCohortSize - causal.holdout.n)}
          </p>
        </div>
      )}
    </section>
  );
}

function CausalHeader({
  cohortReady,
  minCohortSize,
}: {
  cohortReady?: boolean;
  minCohortSize?: number;
} = {}) {
  const subtitle =
    cohortReady === undefined
      ? "Measured comparison for teams that want proof, not just estimates."
      : cohortReady
        ? "Both groups cleared the minimum size. Lift below is observed, not estimated."
        : `Comparison is live. Lift stays hidden until both groups reach n = ${minCohortSize}.`;
  return (
    <header className="flex flex-col gap-1">
      <p
        className="text-[10px] font-mono uppercase tracking-[0.22em]"
        style={{ color: "var(--text-tertiary)" }}
      >
        Measured
      </p>
      <h2 className="text-[0.98rem] font-medium tracking-tight">With TraceBase vs held-out</h2>
      <p
        className="max-w-[44rem] text-[12px] font-light leading-relaxed"
        style={{ color: "var(--text-secondary)" }}
      >
        {subtitle}
      </p>
    </header>
  );
}

function CohortCard({
  label,
  cohort,
  tone,
}: {
  label: string;
  cohort: UsageCohort;
  tone: "positive" | "neutral";
}) {
  const rate =
    cohort.resolvedRate === null ? "—" : `${(cohort.resolvedRate * 100).toFixed(1)}%`;
  const valueColor = tone === "positive" ? "var(--accent)" : "var(--text)";
  return (
    <article
      className="flex min-h-[140px] flex-col justify-between rounded-lg border p-4"
      style={{ borderColor: "var(--border)", background: "var(--surface)" }}
    >
      <p
        className="text-[10px] font-mono uppercase tracking-[0.22em]"
        style={{ color: "var(--text-tertiary)" }}
      >
        {label}
      </p>
      <div>
        <p className="text-[1.7rem] font-light tracking-[-0.03em]" style={{ color: valueColor }}>
          {rate}
        </p>
        <p
          className="mt-2 text-[12px] font-light leading-relaxed"
          style={{ color: "var(--text-secondary)" }}
        >
          {cohort.resolved.toLocaleString()} resolved of {cohort.n.toLocaleString()} outcome
          {cohort.n === 1 ? "" : "s"}
        </p>
      </div>
    </article>
  );
}

function formatRateLift(value: number): string {
  // Percentage points, not percent. "+4.2 pp" reads as a rate
  // difference rather than a relative change.
  const pp = value * 100;
  const sign = pp >= 0 ? "+" : "";
  return `${sign}${pp.toFixed(1)} pp`;
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
