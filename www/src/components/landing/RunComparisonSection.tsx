import Link from "next/link";
import { SWE_BENCH_SNAPSHOT as S } from "@/content/benchmarkStats";

export function RunComparisonSection() {
  return (
    <section className="scroll-mt-20 py-12 md:py-14" id="evidence" aria-labelledby="evidence-heading">
      <p className="mb-2 text-[10px] font-mono uppercase tracking-[0.18em]" style={{ color: "var(--text-tertiary)" }}>
        Benchmark signal
      </p>
      <h2 id="evidence-heading" className="max-w-[52rem] text-[clamp(1.35rem,3.2vw,2.35rem)] font-light leading-[1.06] tracking-tight">
        Higher resolve rate and lower run cost when agent work repeats — same models, same integration surface.
      </h2>

      <div
        className="mt-8 overflow-hidden border"
        style={{
          borderColor: "var(--border)",
          background: "var(--border)",
        }}
      >
        <div className="grid gap-px lg:grid-cols-3">
          <article className="p-5 md:p-6" style={{ background: "var(--bg)" }}>
            <p className="font-mono text-[clamp(2rem,4.5vw,2.75rem)] font-medium leading-none tracking-[-0.04em]">
              +{S.accuracyGainPp} pp
            </p>
            <p className="mt-4 text-[10px] font-mono font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--text)" }}>
              Resolve rate
            </p>
            <p className="mt-3 text-[12px] font-light leading-snug md:text-[13px]" style={{ color: "var(--text-secondary)" }}>
              {S.benchmark}, {S.model}: {S.accuracyBaselinePct}% → {S.accuracyInjectionPct}%. +{S.newFixes} fixes, {S.regressions} regressions.
            </p>
          </article>

          <article className="p-5 md:p-6" style={{ background: "var(--bg)" }}>
            <p className="font-mono text-[clamp(2rem,4.5vw,2.75rem)] font-medium leading-none tracking-[-0.04em]">
              {S.costReductionAvgPct}%
            </p>
            <p className="mt-1 font-mono text-[11px]" style={{ color: "var(--text-tertiary)" }}>
              avg · cost down
            </p>
            <p className="mt-4 text-[10px] font-mono font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--text)" }}>
              Unit economics
            </p>
            <p className="mt-3 text-[12px] font-light leading-snug md:text-[13px]" style={{ color: "var(--text-secondary)" }}>
              Strong-match runs (n={S.highConfidenceN}). Peaks −{S.costReductionPeakPct}% cost, −{S.stepReductionPeakPct}% steps.
            </p>
          </article>

          <article className="p-5 md:p-6" style={{ background: "var(--bg)" }}>
            <p className="font-mono text-[clamp(2rem,4.5vw,2.75rem)] font-medium leading-none tracking-[-0.04em]">
              {S.retrievalSignalCount}
            </p>
            <p className="mt-1 font-mono text-[11px]" style={{ color: "var(--text-tertiary)" }}>
              signals · {S.patternFields}-field patterns
            </p>
            <p className="mt-4 text-[10px] font-mono font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--text)" }}>
              Retrieval layer
            </p>
            <p className="mt-3 text-[12px] font-light leading-snug md:text-[13px]" style={{ color: "var(--text-secondary)" }}>
              Multi-signal match, weights adapt with traffic — optional semantic channel.
            </p>
          </article>
        </div>

        <div className="border-t px-5 py-4 md:px-6" style={{ borderColor: "var(--border)", background: "var(--bg)" }}>
          <p className="text-[9px] font-mono uppercase tracking-[0.16em]" style={{ color: "var(--text-tertiary)" }}>
            Benchmarks
          </p>
          <p className="mt-2 font-mono text-[11px] font-medium leading-snug tracking-tight md:text-[12px]">
            {S.benchmark} · {S.completed}/{S.attempted} tasks · {S.model} · {S.harness}
          </p>
        </div>

        <div className="border-t px-5 py-4 md:px-6" style={{ borderColor: "var(--border)", background: "var(--bg)" }}>
          <p className="text-[9px] font-mono uppercase tracking-[0.16em]" style={{ color: "var(--text-tertiary)" }}>
            Whitepaper
          </p>
          <Link
            href="/whitepaper"
            className="mt-2 inline-block text-[12px] font-light underline decoration-white/18 underline-offset-[4px] transition-colors hover:text-[var(--text)] md:text-[13px]"
            style={{ color: "var(--text-secondary)" }}
          >
            Methodology, tables, limits.
          </Link>
        </div>
      </div>
    </section>
  );
}
