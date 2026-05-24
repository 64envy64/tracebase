import Link from "next/link";
import type { CSSProperties } from "react";
import { SWE_BENCH_SNAPSHOT as S } from "@/content/benchmarkStats";
import { INK } from "./brand/tokens";

type BarMetric = {
  label: string;
  baseline: number;
  tracebase: number;
  delta: string;
  better: "higher" | "lower";
};

const BAR_METRICS: readonly BarMetric[] = [
  {
    label: "Resolved patches",
    baseline: S.accuracyBaselinePct,
    tracebase: S.accuracyInjectionPct,
    delta: `+${S.accuracyGainPp} pp`,
    better: "higher",
  },
  {
    label: "Cost index",
    baseline: 100,
    tracebase: 100 - S.costReductionAvgPct,
    delta: `-${S.costReductionAvgPct}%`,
    better: "lower",
  },
  {
    label: "Step index",
    baseline: 100,
    tracebase: 100 - S.stepReductionAvgPct,
    delta: `-${S.stepReductionAvgPct}%`,
    better: "lower",
  },
] as const;

export function RunComparisonSection() {
  return (
    <section className="scroll-mt-20 py-14 md:py-20" id="evidence" aria-labelledby="evidence-heading">
      <p className="mb-2 text-[10px] font-mono uppercase tracking-[0.18em]" style={{ color: "var(--text-tertiary)" }}>
        Benchmark signal
      </p>
      <h2
        id="evidence-heading"
        className="max-w-[52rem] text-[clamp(1.55rem,3.4vw,2.7rem)] font-light leading-[1.04] tracking-tight"
      >
        A conducted 40-task benchmark: same issues, same agent stack, TraceBase attached only in the second arm.
      </h2>
      <p className="mt-4 max-w-[38rem] text-[14px] font-light leading-relaxed md:text-[15px]" style={{ color: "var(--text-secondary)" }}>
        Forty SWE-bench Verified tasks were run in two paired conditions. The benchmark reports official grader
        outcomes, paired cost deltas, and the exact limits of the claim.
      </p>

      <div
        className="mt-8 overflow-hidden rounded-xl border"
        style={{
          borderColor: "rgba(232,217,184,0.12)",
          background: "rgba(232,217,184,0.08)",
        }}
      >
        <div className="grid gap-px lg:grid-cols-3">
          {BAR_METRICS.map((metric, index) => (
            <MetricChart key={metric.label} metric={metric} delayMs={index * 130} />
          ))}
        </div>

        <QualitySnapshot />

        <div className="grid gap-px md:grid-cols-[1.35fr_0.65fr]" style={{ background: "rgba(232,217,184,0.08)" }}>
          <MechanismChart />
          <BenchmarkCta />
        </div>
      </div>
    </section>
  );
}

function MetricChart({ metric, delayMs }: { metric: BarMetric; delayMs: number }) {
  const baselineWidth = `${Math.min(100, metric.baseline)}%`;
  const tracebaseWidth = `${Math.min(100, metric.tracebase)}%`;
  const traceColor = metric.better === "higher" ? INK.ember : INK.amber;

  return (
    <article className="p-5 md:p-6" style={{ background: INK.inkDeep }}>
      <div className="flex items-start justify-between gap-5">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em]" style={{ color: INK.sand }}>
            {metric.label}
          </p>
          <p className="mt-2 font-mono text-[clamp(1.65rem,3.6vw,2.35rem)] font-semibold leading-none tabular-nums" style={{ color: INK.pearl }}>
            {metric.delta}
          </p>
        </div>
        <span className="rounded border px-2 py-1 font-mono text-[9px] uppercase tracking-[0.14em]" style={{ borderColor: "rgba(255,122,92,0.32)", color: INK.ember }}>
          measured
        </span>
      </div>

      <div className="mt-6 space-y-4">
        <BarRow
          label={S.baselineLabel}
          value={metric.baseline}
          width={baselineWidth}
          color="rgba(232,217,184,0.46)"
          delayMs={delayMs}
        />
        <BarRow
          label="TraceBase"
          value={metric.tracebase}
          width={tracebaseWidth}
          color={traceColor}
          delayMs={delayMs + 120}
          strong
        />
      </div>
    </article>
  );
}

function BarRow({
  label,
  value,
  width,
  color,
  delayMs,
  strong,
}: {
  label: string;
  value: number;
  width: string;
  color: string;
  delayMs: number;
  strong?: boolean;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-3 font-mono text-[10px] uppercase tracking-[0.16em]">
        <span style={{ color: strong ? INK.pearl : INK.sand }}>{label}</span>
        <span style={{ color: strong ? INK.pearl : "rgba(232,217,184,0.55)" }}>{Math.round(value)}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-sm" style={{ background: "rgba(232,217,184,0.08)" }}>
        <span
          className="benchmark-bar-fill block h-full rounded-sm"
          style={{
            ["--bar-target" as string]: width,
            ["--bar-delay" as string]: `${delayMs}ms`,
            background: color,
          } as CSSProperties}
        />
      </div>
    </div>
  );
}

function QualitySnapshot() {
  return (
    <article className="border-t p-5 md:p-6" style={{ borderColor: "rgba(232,217,184,0.08)", background: INK.inkDeep }}>
      <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em]" style={{ color: INK.sand }}>
            Quality dimensions
          </p>
          <h3 className="mt-2 text-[clamp(1.15rem,2.2vw,1.55rem)] font-light leading-tight" style={{ color: INK.pearl }}>
            Better patches, not just cheaper runs.
          </h3>
        </div>
        <p className="max-w-[30rem] text-[12.5px] font-light leading-relaxed" style={{ color: "rgba(232,217,184,0.66)" }}>
          Scored across tasks where at least one arm produced a meaningful patch. Higher is better on every axis.
        </p>
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-5">
        {S.qualityDimensions.map((dim, index) => (
          <div key={dim.label} className="min-w-0">
            <div className="mb-2 flex items-center justify-between gap-3">
              <span className="truncate text-[12px] font-medium" style={{ color: INK.pearl }}>
                {dim.label}
              </span>
              <span className="font-mono text-[10px] tabular-nums" style={{ color: INK.ember }}>
                {dim.lift}
              </span>
            </div>
            <div className="relative h-[104px] rounded border p-3" style={{ borderColor: "rgba(232,217,184,0.09)", background: "rgba(232,217,184,0.025)" }}>
              <VerticalBar
                label="base"
                value={dim.baseline}
                color="rgba(232,217,184,0.44)"
                delayMs={180 + index * 70}
                left="22%"
              />
              <VerticalBar
                label="tb"
                value={dim.tracebase}
                color={INK.ember}
                delayMs={280 + index * 70}
                left="62%"
              />
            </div>
          </div>
        ))}
      </div>
    </article>
  );
}

function VerticalBar({
  label,
  value,
  color,
  delayMs,
  left,
}: {
  label: string;
  value: number;
  color: string;
  delayMs: number;
  left: string;
}) {
  return (
    <span className="absolute bottom-3 flex w-7 -translate-x-1/2 flex-col items-center gap-1" style={{ left }}>
      <span
        className="benchmark-vertical-fill block w-4 rounded-sm"
        style={{
          ["--vertical-target" as string]: `${Math.round(value * 72)}px`,
          ["--vertical-delay" as string]: `${delayMs}ms`,
          background: color,
        } as CSSProperties}
      />
      <span className="font-mono text-[8px] uppercase tracking-[0.12em]" style={{ color: "rgba(232,217,184,0.46)" }}>
        {label}
      </span>
    </span>
  );
}

function MechanismChart() {
  return (
    <article className="p-5 md:p-6" style={{ background: INK.inkDeep }}>
      <p className="font-mono text-[10px] uppercase tracking-[0.18em]" style={{ color: INK.sand }}>
        Where the savings came from
      </p>
      <div className="mt-5 flex h-4 overflow-hidden rounded-sm" style={{ background: "rgba(232,217,184,0.08)" }}>
        {S.mechanismBreakdown.map((segment, index) => (
          <span
            key={segment.label}
            className="benchmark-segment-fill h-full"
            style={{
              ["--segment-target" as string]: `${segment.value}%`,
              ["--segment-delay" as string]: `${180 + index * 110}ms`,
              background: ["#ff7a5c", "#e0b458", "#b84f38", "rgba(232,217,184,0.46)"][index],
            } as CSSProperties}
          />
        ))}
      </div>
      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        {S.mechanismBreakdown.map((segment, index) => (
          <div key={segment.label} className="flex items-center justify-between gap-3 border-t pt-3" style={{ borderColor: "rgba(232,217,184,0.07)" }}>
            <span className="text-[12px] font-light leading-snug" style={{ color: "rgba(232,217,184,0.68)" }}>
              {segment.label}
            </span>
            <span className="font-mono text-[11px] tabular-nums" style={{ color: index === 0 ? INK.ember : INK.sand }}>
              {segment.value}%
            </span>
          </div>
        ))}
      </div>
    </article>
  );
}

function BenchmarkCta() {
  return (
    <article className="flex flex-col justify-between gap-6 p-5 md:p-6" style={{ background: INK.inkDeep }}>
      <div>
        <p className="font-mono text-[10px] uppercase tracking-[0.18em]" style={{ color: INK.sand }}>
          Benchmark
        </p>
        <p className="mt-3 text-[13px] font-light leading-relaxed" style={{ color: "rgba(232,217,184,0.72)" }}>
          {S.benchmarkTasks} tasks x {S.pairedConditions} paired arms = {S.pairedRuns} agent runs. Official grader,
          same budget, same harness, no manual patching.
        </p>
      </div>
      <Link
        href="/whitepaper"
        className="inline-flex h-10 items-center justify-center rounded border px-4 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] transition-colors hover:bg-[rgba(255,122,92,0.12)]"
        style={{ borderColor: "rgba(255,122,92,0.38)", color: INK.ember }}
      >
        Read our benchmark
      </Link>
    </article>
  );
}
