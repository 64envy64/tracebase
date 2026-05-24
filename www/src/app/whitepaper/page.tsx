import Link from "next/link";
import type { Metadata } from "next";
import type { CSSProperties, ReactNode } from "react";
import { GitHubMark } from "@/components/ui/GitHubMark";
import { TracebaseInkWordmark } from "@/components/landing/brand/Marks";
import { SectionLabel } from "@/components/landing/brand/Primitives";
import { INK } from "@/components/landing/brand/tokens";
import { SWE_BENCH_SNAPSHOT as S } from "@/content/benchmarkStats";

export const metadata: Metadata = {
  title: "TraceBase Whitepaper - Repeated-Work Benchmark",
  description:
    `${S.runName}: ${S.pairedRuns} agent runs on ${S.benchmark}. ` +
    `+${S.accuracyGainPp} pp resolved rate, ${S.costReductionAvgPct}% lower cost, ` +
    `${S.stepReductionAvgPct}% fewer steps on high-confidence matches.`,
};

function NavBar() {
  return (
    <nav
      className="sticky top-0 z-50 border-b backdrop-blur-md"
      style={{ borderColor: "rgba(232,217,184,0.08)", background: "rgba(10,16,20,0.78)" }}
    >
      <div className="mx-auto flex max-w-[940px] items-center justify-between px-5 py-4 md:px-6">
        <Link href="/" className="inline-flex items-center">
          <TracebaseInkWordmark size={16} />
        </Link>
        <div className="flex items-center gap-5 text-[13px]" style={{ color: "rgba(232,217,184,0.66)" }}>
          <Link href="/" className="transition-colors hover:text-[var(--bone)]">
            Home
          </Link>
          <Link href="/docs" className="transition-colors hover:text-[var(--bone)]">
            Docs
          </Link>
          <Link href="/whitepaper" style={{ color: INK.bone }}>
            Whitepaper
          </Link>
          <a
            href="https://github.com/64envy64/tracebase"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-8 w-8 items-center justify-center rounded-full border transition-colors hover:text-[var(--bone)]"
            style={{ borderColor: "rgba(232,217,184,0.12)" }}
            aria-label="GitHub repository"
          >
            <GitHubMark className="h-[16px] w-[16px]" />
          </a>
        </div>
      </div>
    </nav>
  );
}

function Section({
  number,
  eyebrow,
  muted,
  accent,
  children,
}: {
  number?: string;
  eyebrow: string;
  muted: ReactNode;
  accent: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mt-16 md:mt-20">
      <div className="flex items-center gap-3">
        {number ? (
          <span className="font-mono text-[11px] tracking-[0.22em]" style={{ color: INK.sand }}>
            {number}
          </span>
        ) : null}
        <SectionLabel>{eyebrow}</SectionLabel>
      </div>
      <h2
        className="mt-3 font-hero-serif text-[clamp(1.65rem,3.2vw,2.35rem)] font-normal leading-[1.08]"
        style={{ color: INK.pearl }}
      >
        <span style={{ color: "rgba(232,217,184,0.5)" }}>{muted}</span>{" "}
        <span>{accent}</span>
      </h2>
      <div className="mt-6 space-y-4 text-[14px] font-light leading-relaxed md:text-[15px]" style={{ color: "rgba(232,217,184,0.78)" }}>
        {children}
      </div>
    </section>
  );
}

function InkCard({ eyebrow, children }: { eyebrow?: ReactNode; children: ReactNode }) {
  return (
    <div
      className="mt-6 overflow-hidden rounded-xl border"
      style={{ borderColor: "rgba(232,217,184,0.1)", background: INK.inkDeep }}
    >
      {eyebrow ? (
        <div className="border-b px-5 py-4 md:px-6" style={{ borderColor: "rgba(232,217,184,0.08)" }}>
          <SectionLabel>{eyebrow}</SectionLabel>
        </div>
      ) : null}
      <div className="px-5 py-5 md:px-6 md:py-6">{children}</div>
    </div>
  );
}

function ParamTable({ rows }: { rows: readonly (readonly [string, string])[] }) {
  return (
    <dl className="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.35fr)] gap-y-2.5 text-[13px] md:text-[13.5px]">
      {rows.map(([key, value]) => (
        <div key={key} className="contents">
          <dt style={{ color: INK.sand }}>{key}</dt>
          <dd style={{ color: INK.bone }}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function CodeBlock({ children }: { children: ReactNode }) {
  return (
    <div
      className="mt-4 overflow-x-auto rounded-xl border px-5 py-4 font-mono text-[12px] leading-relaxed"
      style={{ borderColor: "rgba(232,217,184,0.1)", background: INK.ink, color: "rgba(232,217,184,0.78)" }}
    >
      {children}
    </div>
  );
}

function HeroMetricGrid() {
  const cards = [
    { label: "resolved rate", value: `+${S.accuracyGainPp} pp`, note: `${S.accuracyBaselinePct}% -> ${S.accuracyInjectionPct}%` },
    { label: "avg cost", value: `-${S.costReductionAvgPct}%`, note: `high-confidence matches, n=${S.highConfidenceN}` },
    { label: "avg steps", value: `-${S.stepReductionAvgPct}%`, note: `${S.bestTaskStepsBefore} -> ${S.bestTaskStepsAfter} on best run` },
    { label: "regressions", value: `${S.regressions}`, note: `${S.newFixes} new fixes` },
  ];

  return (
    <div className="mt-8 grid gap-px overflow-hidden rounded-xl border sm:grid-cols-2 lg:grid-cols-4" style={{ borderColor: "rgba(232,217,184,0.12)", background: "rgba(232,217,184,0.08)" }}>
      {cards.map((card) => (
        <div key={card.label} className="min-h-[132px] p-5" style={{ background: INK.inkDeep }}>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em]" style={{ color: INK.sand }}>
            {card.label}
          </p>
          <p className="mt-4 font-mono text-[clamp(1.65rem,3vw,2.25rem)] font-semibold leading-none tabular-nums" style={{ color: card.label === "resolved rate" ? INK.ember : INK.pearl }}>
            {card.value}
          </p>
          <p className="mt-3 text-[12px] leading-snug" style={{ color: "rgba(232,217,184,0.58)" }}>
            {card.note}
          </p>
        </div>
      ))}
    </div>
  );
}

function ChartPanel() {
  return (
    <InkCard eyebrow="paired outcome chart">
      <div className="grid gap-7 md:grid-cols-[1fr_1fr]">
        <div>
          <p className="text-[13px] font-medium" style={{ color: INK.pearl }}>
            Resolved patches
          </p>
          <div className="mt-5 space-y-5">
            <Bar label={S.baselineLabel} value={S.accuracyBaselinePct} max={100} color="rgba(232,217,184,0.46)" delayMs={0} suffix="%" />
            <Bar label={S.augmentedLabel} value={S.accuracyInjectionPct} max={100} color={INK.ember} delayMs={130} suffix="%" />
          </div>
        </div>

        <div>
          <p className="text-[13px] font-medium" style={{ color: INK.pearl }}>
            Efficiency index
          </p>
          <div className="mt-5 space-y-5">
            <Bar label="Cost after TraceBase" value={100 - S.costReductionAvgPct} max={100} color={INK.amber} delayMs={260} suffix="/100" />
            <Bar label="Steps after TraceBase" value={100 - S.stepReductionAvgPct} max={100} color="rgba(232,217,184,0.62)" delayMs={390} suffix="/100" />
          </div>
        </div>
      </div>
    </InkCard>
  );
}

function Bar({
  label,
  value,
  max,
  color,
  delayMs,
  suffix,
}: {
  label: string;
  value: number;
  max: number;
  color: string;
  delayMs: number;
  suffix: string;
}) {
  const width = `${Math.max(4, Math.min(100, (value / max) * 100))}%`;
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-3 font-mono text-[10px] uppercase tracking-[0.16em]">
        <span style={{ color: INK.sand }}>{label}</span>
        <span style={{ color: INK.bone }}>{value}{suffix}</span>
      </div>
      <div className="h-3 overflow-hidden rounded-sm" style={{ background: "rgba(232,217,184,0.08)" }}>
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

function MethodologyFlow() {
  const steps = [
    ["01", "Start from real issues", `${S.benchmarkTasks} verified bug-fix tasks with executable tests.`],
    ["02", "Run baseline", "The agent solves with its normal tools and an empty memory layer."],
    ["03", "Store resolved work", "Successful runs are distilled into compact situation, mechanism, unlock, and verification notes."],
    ["04", "Run with TraceBase", "The same task distribution runs again with recall enabled and the same caps."],
    ["05", "Grade by tests", "A containerized grader marks the submitted patch resolved or unresolved."],
  ] as const;

  return (
    <div className="mt-6 grid gap-px overflow-hidden rounded-xl border md:grid-cols-5" style={{ borderColor: "rgba(232,217,184,0.1)", background: "rgba(232,217,184,0.08)" }}>
      {steps.map(([n, title, body]) => (
        <div key={n} className="min-h-[170px] p-5" style={{ background: INK.inkDeep }}>
          <p className="font-mono text-[11px] tracking-[0.22em]" style={{ color: INK.ember }}>{n}</p>
          <p className="mt-4 text-[14px] font-medium" style={{ color: INK.pearl }}>{title}</p>
          <p className="mt-3 text-[12.5px] font-light leading-relaxed" style={{ color: "rgba(232,217,184,0.66)" }}>{body}</p>
        </div>
      ))}
    </div>
  );
}

function MechanismStack() {
  return (
    <InkCard eyebrow="mechanism attribution">
      <div className="flex h-5 overflow-hidden rounded-sm" style={{ background: "rgba(232,217,184,0.08)" }}>
        {S.mechanismBreakdown.map((segment, index) => (
          <span
            key={segment.label}
            className="benchmark-segment-fill h-full"
            style={{
              ["--segment-target" as string]: `${segment.value}%`,
              ["--segment-delay" as string]: `${index * 120}ms`,
              background: ["#ff7a5c", "#e0b458", "#b84f38", "rgba(232,217,184,0.46)"][index],
            } as CSSProperties}
          />
        ))}
      </div>
      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        {S.mechanismBreakdown.map((segment, index) => (
          <div key={segment.label} className="flex items-center justify-between gap-4 border-t pt-3" style={{ borderColor: "rgba(232,217,184,0.07)" }}>
            <span className="text-[13px] font-light" style={{ color: "rgba(232,217,184,0.7)" }}>{segment.label}</span>
            <span className="font-mono text-[12px]" style={{ color: index === 0 ? INK.ember : INK.sand }}>{segment.value}%</span>
          </div>
        ))}
      </div>
      <p className="mt-5 text-[12px] leading-relaxed" style={{ color: INK.sand }}>
        Attribution is based on TraceBase event categories and paired trajectory inspection. It explains where the measured
        efficiency delta came from; it is not a separate accuracy claim.
      </p>
    </InkCard>
  );
}

function QualityScoringPanel() {
  return (
    <InkCard eyebrow="quality scoring">
      <div className="grid gap-8 lg:grid-cols-[0.92fr_1.08fr]">
        <div>
          <p className="text-[13px] font-medium" style={{ color: INK.pearl }}>
            What improved besides cost
          </p>
          <p className="mt-3 text-[13px] font-light leading-relaxed" style={{ color: "rgba(232,217,184,0.68)" }}>
            We filtered scored results to tasks where at least one arm produced a meaningful patch. Across those tasks,
            TraceBase improved every scored dimension: not just whether the agent got to an answer, but whether the answer
            fit the codebase.
          </p>
          <div className="mt-5 flex items-center gap-5 font-mono text-[10px] uppercase tracking-[0.14em]">
            <span className="inline-flex items-center gap-2" style={{ color: INK.sand }}>
              <span className="h-2 w-5 rounded-sm" style={{ background: "rgba(232,217,184,0.44)" }} />
              Baseline
            </span>
            <span className="inline-flex items-center gap-2" style={{ color: INK.ember }}>
              <span className="h-2 w-5 rounded-sm" style={{ background: INK.ember }} />
              TraceBase
            </span>
          </div>
        </div>

        <div className="space-y-4">
          {S.qualityDimensions.map((dim, index) => (
            <QualityRow key={dim.label} dim={dim} delayMs={index * 95} />
          ))}
        </div>
      </div>

      <div className="mt-8 grid gap-4 md:grid-cols-2">
        {S.qualityDimensions.map((dim) => (
          <div key={dim.label} className="border-t pt-4" style={{ borderColor: "rgba(232,217,184,0.07)" }}>
            <p className="text-[13px] font-semibold" style={{ color: INK.pearl }}>
              {dim.label} <span className="font-mono text-[11px]" style={{ color: INK.ember }}>{dim.lift}</span>
            </p>
            <p className="mt-2 text-[12.5px] font-light leading-relaxed" style={{ color: "rgba(232,217,184,0.66)" }}>
              {dim.explanation}
            </p>
          </div>
        ))}
      </div>
    </InkCard>
  );
}

function QualityRow({
  dim,
  delayMs,
}: {
  dim: (typeof S.qualityDimensions)[number];
  delayMs: number;
}) {
  const baselineWidth = `${Math.round(dim.baseline * 100)}%`;
  const tracebaseWidth = `${Math.round(dim.tracebase * 100)}%`;
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-4">
        <span className="text-[12px] font-medium" style={{ color: INK.pearl }}>
          {dim.label}
        </span>
        <span className="font-mono text-[11px] tabular-nums" style={{ color: INK.ember }}>
          {dim.lift}
        </span>
      </div>
      <div className="space-y-1.5">
        <div className="h-2 overflow-hidden rounded-sm" style={{ background: "rgba(232,217,184,0.08)" }}>
          <span
            className="benchmark-bar-fill block h-full rounded-sm"
            style={{
              ["--bar-target" as string]: baselineWidth,
              ["--bar-delay" as string]: `${delayMs}ms`,
              background: "rgba(232,217,184,0.44)",
            } as CSSProperties}
          />
        </div>
        <div className="h-2 overflow-hidden rounded-sm" style={{ background: "rgba(232,217,184,0.08)" }}>
          <span
            className="benchmark-bar-fill block h-full rounded-sm"
            style={{
              ["--bar-target" as string]: tracebaseWidth,
              ["--bar-delay" as string]: `${delayMs + 120}ms`,
              background: INK.ember,
            } as CSSProperties}
          />
        </div>
      </div>
    </div>
  );
}

export default function WhitepaperPage() {
  return (
    <div className="min-h-screen" style={{ background: INK.ink, color: INK.bone }}>
      <NavBar />

      <main className="mx-auto max-w-[940px] px-5 py-12 md:px-6 md:py-16">
        <header>
          <SectionLabel>TraceBase Technical Report - {S.reportVersion}</SectionLabel>
          <h1
            className="mt-3 max-w-[760px] font-hero-serif text-[clamp(2.2rem,5vw,4rem)] font-normal leading-[1.04]"
            style={{ color: INK.pearl }}
          >
            Coding agents do not need more context.{" "}
            <span style={{ color: INK.ember }}>They need remembered work.</span>
          </h1>
          <p className="mt-5 max-w-[680px] text-[14px] font-light leading-relaxed md:text-[15px]" style={{ color: "rgba(232,217,184,0.72)" }}>
            This report measures TraceBase as a repeated-work layer: the first run solves from scratch, the second run
            receives only compact memories from prior solved work. The question is not whether the model is smarter. The
            question is whether the agent stops paying for the same investigation twice.
          </p>
          <HeroMetricGrid />
        </header>

        <Section eyebrow="summary" muted="Measured benchmark." accent="Hard grader, clean lift.">
          <p>
            The benchmark uses <strong>{S.benchmarkTasks} SWE-bench Verified tasks</strong> and{" "}
            <strong>{S.pairedRuns} total agent runs</strong>: each task runs once as a baseline and once with TraceBase
            attached. Across the {S.completed} paired
            runs that completed cleanly, resolved rate moved from <strong>{S.accuracyBaselinePct}%</strong> to{" "}
            <strong>{S.accuracyInjectionPct}%</strong>, a +{S.accuracyGainPp} percentage-point gain. On high-confidence
            matches, the agent used <strong>{S.costReductionAvgPct}% less cost</strong> and{" "}
            <strong>{S.stepReductionAvgPct}% fewer steps</strong> on average.
          </p>
          <p>
            This is the benchmark TraceBase is built for: repeated engineering work where prior runs contain reusable
            mechanisms. The lift comes from shortening the investigation path, not from changing the model.
          </p>
          <ChartPanel />
        </Section>

        <Section number="01" eyebrow="benchmark design" muted="Real tasks." accent="Paired replay.">
          <p>
            The benchmark follows a simple paired design: real bug-fix tasks, identical agent settings, one changed
            variable. Instead of asking an LLM judge whether a patch looks good, the submitted patch is graded against
            the task&apos;s test oracle in an isolated container.
          </p>
          <InkCard eyebrow="evaluation parameters">
            <ParamTable
              rows={[
                ["Dataset", S.benchmark],
                ["Tasks", `${S.benchmarkTasks}`],
                ["Agent runs", `${S.pairedRuns} (${S.benchmarkTasks} baseline + ${S.benchmarkTasks} TraceBase)`],
                ["Completed pairs", `${S.completed}`],
                ["Harness", S.harness],
                ["Model control", S.modelDisclosure],
                ["Step cap", `${S.stepCap} tool steps per task`],
                ["Cost cap", `$${S.costCapUsd.toFixed(2)} per task`],
                ["Primary metric", "Official resolved / unresolved"],
                ["Efficiency metrics", "Steps and spend on paired completed runs"],
              ]}
            />
          </InkCard>
          <MethodologyFlow />
        </Section>

        <Section number="02" eyebrow="results" muted="The useful lift is not just tokens." accent="It is trajectory compression.">
          <p>
            TraceBase improved the resolved count by <strong>{S.newFixes} tasks</strong> with{" "}
            <strong>{S.regressions} regressions</strong>. The larger effect shows up in the trajectories: on matches
            where retrieval had enough confidence to inject, agents reached the patch faster and spent less time
            re-reading files or revisiting known dead ends.
          </p>
          <InkCard eyebrow="resolved rate">
            <table className="w-full text-[13px] md:text-[13.5px]">
              <thead>
                <tr style={{ color: INK.sand }}>
                  <th className="py-2 text-left font-mono text-[10px] uppercase tracking-[0.16em]">Condition</th>
                  <th className="py-2 text-right font-mono text-[10px] uppercase tracking-[0.16em]">Resolved</th>
                  <th className="py-2 text-right font-mono text-[10px] uppercase tracking-[0.16em]">Rate</th>
                  <th className="py-2 text-right font-mono text-[10px] uppercase tracking-[0.16em]">Delta</th>
                </tr>
              </thead>
              <tbody style={{ color: INK.bone }}>
                <tr style={{ borderTop: "1px solid rgba(232,217,184,0.05)" }}>
                  <td className="py-3">{S.baselineLabel}</td>
                  <td className="py-3 text-right font-mono tabular-nums">{S.baselineResolved} / {S.completed}</td>
                  <td className="py-3 text-right font-mono tabular-nums">{S.accuracyBaselinePct}%</td>
                  <td className="py-3 text-right font-mono" style={{ color: INK.sand }}>-</td>
                </tr>
                <tr style={{ borderTop: "1px solid rgba(232,217,184,0.05)", background: "rgba(255,122,92,0.04)" }}>
                  <td className="py-3 font-medium" style={{ color: INK.pearl }}>{S.augmentedLabel}</td>
                  <td className="py-3 text-right font-mono font-semibold tabular-nums" style={{ color: INK.pearl }}>{S.augmentedResolved} / {S.completed}</td>
                  <td className="py-3 text-right font-mono font-semibold tabular-nums" style={{ color: INK.pearl }}>{S.accuracyInjectionPct}%</td>
                  <td className="py-3 text-right font-mono font-semibold tabular-nums" style={{ color: INK.ember }}>+{S.accuracyGainPp} pp</td>
                </tr>
              </tbody>
            </table>
            <p className="mt-3 text-[12px]" style={{ color: INK.sand }}>
              Relative lift: +{S.relativeAccuracyGainPct}% over baseline. Absolute lift is the number we use in public copy.
            </p>
          </InkCard>

          <InkCard eyebrow={`efficiency on high-confidence matches (n=${S.highConfidenceN})`}>
            <table className="w-full text-[13px] md:text-[13.5px]">
              <thead>
                <tr style={{ color: INK.sand }}>
                  <th className="py-2 text-left font-mono text-[10px] uppercase tracking-[0.16em]">Metric</th>
                  <th className="py-2 text-right font-mono text-[10px] uppercase tracking-[0.16em]">Average</th>
                  <th className="py-2 text-right font-mono text-[10px] uppercase tracking-[0.16em]">Best run</th>
                </tr>
              </thead>
              <tbody style={{ color: INK.bone }}>
                <tr style={{ borderTop: "1px solid rgba(232,217,184,0.05)" }}>
                  <td className="py-3">Cost reduction</td>
                  <td className="py-3 text-right font-mono font-semibold tabular-nums" style={{ color: INK.ember }}>-{S.costReductionAvgPct}%</td>
                  <td className="py-3 text-right font-mono tabular-nums">-{S.bestTaskCostReductionPct}%</td>
                </tr>
                <tr style={{ borderTop: "1px solid rgba(232,217,184,0.05)" }}>
                  <td className="py-3">Step reduction</td>
                  <td className="py-3 text-right font-mono font-semibold tabular-nums" style={{ color: INK.ember }}>-{S.stepReductionAvgPct}%</td>
                  <td className="py-3 text-right font-mono tabular-nums">-{S.bestTaskStepReductionPct}%</td>
                </tr>
              </tbody>
            </table>
            <p className="mt-3 text-[12px]" style={{ color: INK.sand }}>
              {S.bestTaskLabel}: {S.bestTaskStepsBefore} {"->"} {S.bestTaskStepsAfter} steps.
            </p>
          </InkCard>
          <MechanismStack />
          <QualityScoringPanel />
        </Section>

        <Section number="03" eyebrow="why it works" muted="The agent already knows how to code." accent="It forgets what it learned.">
          <p>
            Most repeated-agent waste is not raw model weakness. It is missing local knowledge: which attempted fix failed,
            which file actually owned the bug, which verification command exposed the failure, and which compact patch shape
            finally worked. TraceBase stores those facts as reusable reasoning blocks and injects them only when retrieval is
            confident enough to be net-positive.
          </p>
          <InkCard eyebrow="memory payload">
            <CodeBlock>
              <p>{"situation: reconnect race after flaky network blip"}</p>
              <p>{"mechanism: stale sequence buffer accepts old open-event path"}</p>
              <p>{"unlock: dedupe by sequence id before reopening socket"}</p>
              <p>{"verification: failing case reproduced + relevant test module"}</p>
            </CodeBlock>
          </InkCard>
          <p>
            The key is that TraceBase does not shove an entire prior transcript into context. It serves a short hypothesis
            with evidence and asks the agent to verify it against the current code. That keeps the intervention small enough
            to save tokens and precise enough to shorten the search.
          </p>
        </Section>

        <Section number="04" eyebrow="architecture" muted="Recall is gated." accent="Bad memories are demoted.">
          <p>
            The store is project-scoped SQLite. Retrieval starts with fingerprint and FTS5/BM25, then combines structural,
            Jaccard, cosine, and freshness signals. The serving layer estimates expected net value before injection, and the
            lifecycle loop demotes blocks whose observed helpfulness falls below the threshold.
          </p>
          <InkCard eyebrow="serving path">
            <CodeBlock>
              <p>{"prompt -> candidate recall -> calibrated gate -> compact injection -> agent run -> outcome event"}</p>
              <p>{"outcome event -> helpfulness attribution -> weight update -> demote / keep / merge"}</p>
            </CodeBlock>
          </InkCard>
        </Section>

        <Section number="05" eyebrow="scope" muted="Where the lift applies." accent="Repeated work is the wedge.">
          <ul className="ml-5 list-disc space-y-2 text-[13.5px] md:text-[14px]">
            <li>The benchmark measures repeated engineering work: tasks where past resolved runs can provide reusable mechanism-level memory.</li>
            <li>Efficiency averages are reported on high-confidence matches, where TraceBase had enough evidence to inject.</li>
            <li>The measured benchmark is {S.benchmarkTasks} tasks / {S.pairedRuns} agent runs. The claim is scoped to repeated engineering work.</li>
            <li>Memory is injected as a hypothesis. The agent still has to verify the current code before editing.</li>
            <li>Cost savings vary with model pricing, tool-output volume, and how repetitive the team&apos;s work actually is.</li>
          </ul>
        </Section>

        <Section number="06" eyebrow="method" muted="How the benchmark was run." accent="One changed variable.">
          <p>
            Each task was evaluated as a pair. The baseline arm ran with the standard agent stack and an empty TraceBase
            store. The TraceBase arm ran with the same model settings, tool budget, timeout, and containerized test
            environment, with memory recall enabled before the agent started editing.
          </p>
          <InkCard eyebrow="comparison contract">
            <ParamTable
              rows={[
                ["Task source", "Verified bug-fix tasks with executable tests"],
                ["Arms", "Baseline agent vs. TraceBase attached"],
                ["Controls", "Same model settings, tool budget, timeout, and grader"],
                ["Memory input", "Only compact memories distilled from resolved work"],
                ["Primary outcome", "Patch passes the task's test oracle"],
                ["Efficiency outcome", "Tool steps and spend on matched completed pairs"],
              ]}
            />
          </InkCard>
          <p>
            That keeps the comparison clean: TraceBase does not receive the answer key, does not change the model, and
            does not alter the grading harness. It changes only what the agent remembers before it starts the next run.
          </p>
        </Section>

        <footer className="mt-20 border-t pb-12 pt-8 text-center text-[11px]" style={{ borderColor: "rgba(232,217,184,0.08)", color: "rgba(232,217,184,0.42)" }}>
          <div className="flex items-center justify-center gap-4">
            <span>TraceBase - MIT License</span>
            <a
              href="https://github.com/64envy64/tracebase"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-8 w-8 items-center justify-center rounded-full border transition-colors hover:text-[var(--bone)]"
              style={{ borderColor: "rgba(232,217,184,0.1)" }}
              aria-label="GitHub repository"
            >
              <GitHubMark className="h-4 w-4" />
            </a>
            <a href="https://www.npmjs.com/package/tracebase-ai" target="_blank" rel="noopener noreferrer" className="transition-colors hover:text-[var(--bone)]">
              npm
            </a>
          </div>
          <p className="mt-2">2026 TraceBase</p>
        </footer>
      </main>
    </div>
  );
}
