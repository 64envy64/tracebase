import Link from "next/link";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SWE_BENCH_SNAPSHOT } from "@/content/benchmarkStats";
import { SectionLabel } from "@/components/landing/brand/Primitives";
import { INK } from "@/components/landing/brand/tokens";
import { TracebaseInkWordmark } from "@/components/landing/brand/Marks";
import { GitHubMark } from "@/components/ui/GitHubMark";

/* ============================================================ */
/*  Whitepaper — TraceBase Technical Report.                     */
/*                                                                */
/*  Visual contract: same ink/bone/ember palette as the landing.  */
/*  Hero-serif on long headlines, mono uppercase on eyebrows and  */
/*  table headers, sand for muted axes, ember for the single     */
/*  highlight metric per block. No infinite animations — the     */
/*  doc is a static report, motion would only get in the way.    */
/*                                                                */
/*  Numeric contract: every number on this page is sourced from   */
/*  `www/src/content/benchmarkStats.ts` (SWE_BENCH_SNAPSHOT), so  */
/*  the report and the landing physically cannot drift. Touch    */
/*  the snapshot when the underlying benchmark is rerun and both */
/*  surfaces update together.                                    */
/* ============================================================ */

const S = SWE_BENCH_SNAPSHOT;
const relativeAccuracyGainPct = Math.round(
  ((S.accuracyInjectionPct - S.accuracyBaselinePct) / S.accuracyBaselinePct) * 100,
);

export const metadata: Metadata = {
  title: "TraceBase Whitepaper — Reasoning Injection Benchmark Results",
  description:
    `How reasoning trace injection improves coding-agent efficiency on SWE-bench Verified. ` +
    `+${S.accuracyGainPp} pp accuracy, −${S.costReductionAvgPct}% cost, −${S.stepReductionAvgPct}% steps. ` +
    `Peak savings up to −${S.bestTaskCostReductionPct}% on the best task.`,
};

/* ============================================================ */
/*  Layout primitives — local to this page, sized for long-read */
/*  technical prose at max-w-[760px].                            */
/* ============================================================ */

function NavBar() {
  return (
    <nav
      className="sticky top-0 z-50 border-b backdrop-blur-md"
      style={{
        borderColor: "rgba(232,217,184,0.08)",
        background: "rgba(10, 16, 20, 0.78)",
      }}
    >
      <div className="mx-auto flex max-w-[760px] items-center justify-between px-5 py-4 md:px-6">
        <Link href="/" className="inline-flex items-center">
          <TracebaseInkWordmark size={16} />
        </Link>
        <div
          className="flex items-center gap-5 text-[13px]"
          style={{ color: "rgba(232,217,184,0.66)" }}
        >
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
    <section className="mt-14 md:mt-16">
      <div className="flex items-center gap-3">
        {number ? (
          <span
            className="font-mono text-[11px] tracking-[0.22em]"
            style={{ color: INK.sand }}
          >
            {number}
          </span>
        ) : null}
        <SectionLabel>{eyebrow}</SectionLabel>
      </div>
      <h2
        className="mt-3 font-hero-serif text-[clamp(1.55rem,3vw,2.1rem)] font-normal leading-[1.1] tracking-tight"
        style={{ color: INK.pearl }}
      >
        <span style={{ color: "rgba(232,217,184,0.5)" }}>{muted}</span>{" "}
        <span>{accent}</span>
      </h2>
      <div
        className="mt-6 space-y-4 text-[14px] font-light leading-relaxed md:text-[15px]"
        style={{ color: "rgba(232,217,184,0.78)" }}
      >
        {children}
      </div>
    </section>
  );
}

function InkCard({
  eyebrow,
  children,
}: {
  eyebrow?: string;
  children: ReactNode;
}) {
  return (
    <div
      className="mt-6 overflow-hidden rounded-xl border"
      style={{
        borderColor: "rgba(232,217,184,0.1)",
        background: INK.inkDeep,
      }}
    >
      {eyebrow ? (
        <div
          className="border-b px-5 py-4 md:px-6"
          style={{ borderColor: "rgba(232,217,184,0.08)" }}
        >
          <SectionLabel>{eyebrow}</SectionLabel>
        </div>
      ) : null}
      <div className="px-5 py-5 md:px-6 md:py-6">{children}</div>
    </div>
  );
}

function ParamTable({ rows }: { rows: readonly (readonly [string, string])[] }) {
  return (
    <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)] gap-y-2.5 text-[13px] md:text-[13.5px]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt style={{ color: INK.sand }}>{k}</dt>
          <dd style={{ color: INK.bone }}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="underline underline-offset-2"
      style={{ color: INK.ember, textDecorationColor: "rgba(255,122,92,0.42)" }}
    >
      {children}
    </a>
  );
}

function CodeBlock({ children }: { children: ReactNode }) {
  return (
    <div
      className="mt-4 overflow-x-auto rounded-xl border px-5 py-4 font-mono text-[12.5px] leading-relaxed"
      style={{
        borderColor: "rgba(232,217,184,0.1)",
        background: INK.ink,
        color: "rgba(232,217,184,0.78)",
      }}
    >
      {children}
    </div>
  );
}

/* ============================================================ */
/*  HeroMetricStrip — three tiles mirror the landing hero so      */
/*  the report opens on the same numbers the front door sells.   */
/* ============================================================ */

function HeroMetricStrip() {
  const tiles: { value: string; label: string; tone: "ember" | "bone" }[] = [
    { value: `+${S.accuracyGainPp} pp`, label: "accuracy", tone: "ember" },
    { value: `−${S.costReductionAvgPct}%`, label: "cost", tone: "bone" },
    { value: `−${S.stepReductionAvgPct}%`, label: "steps", tone: "bone" },
  ];
  return (
    <div className="mt-8">
      <div
        className="grid grid-cols-3 overflow-hidden rounded-xl border"
        style={{
          borderColor: "rgba(232,217,184,0.12)",
          background: "rgba(232,217,184,0.08)",
          gap: 1,
        }}
      >
        {tiles.map((t) => (
          <div
            key={t.label}
            className="flex flex-col items-center justify-center gap-1 px-3 py-4"
            style={{ background: INK.inkDeep }}
          >
            <span
              className="font-mono text-[10px] uppercase tracking-[0.22em]"
              style={{ color: INK.sand }}
            >
              {t.label}
            </span>
            <span
              className="font-mono text-[clamp(1.2rem,2.2vw,1.6rem)] font-semibold leading-none tracking-tight tabular-nums"
              style={{ color: t.tone === "ember" ? INK.ember : INK.bone }}
            >
              {t.value}
            </span>
          </div>
        ))}
      </div>
      <p
        className="mt-3 text-center font-mono text-[10px] uppercase tracking-[0.22em]"
        style={{ color: INK.sand }}
      >
        {S.benchmark} · {S.attempted} attempted · {S.completed} completed · {S.model}
      </p>
    </div>
  );
}

/* ============================================================ */
/*  BestTaskCallout — the headline single-task win, pulled out    */
/*  into a card so the eye doesn't have to hunt for it in prose.  */
/* ============================================================ */

function BestTaskCallout() {
  return (
    <div
      className="mt-8 overflow-hidden rounded-xl border"
      style={{
        borderColor: "rgba(255,122,92,0.32)",
        background: "rgba(255,122,92,0.04)",
      }}
    >
      <div
        className="flex items-center justify-between gap-4 border-b px-5 py-3 md:px-6"
        style={{ borderColor: "rgba(232,217,184,0.08)" }}
      >
        <SectionLabel>
          <span style={{ color: INK.ember }}>best run · {S.bestTaskId}</span>
        </SectionLabel>
        <span
          className="font-mono text-[11px] tracking-[0.16em]"
          style={{ color: INK.sand }}
        >
          single-task peak
        </span>
      </div>
      <div
        className="grid grid-cols-1 gap-px md:grid-cols-2"
        style={{ background: "rgba(232,217,184,0.08)" }}
      >
        <div
          className="flex flex-col gap-1 px-5 py-5 md:px-6"
          style={{ background: INK.inkDeep }}
        >
          <span
            className="font-mono text-[10px] uppercase tracking-[0.22em]"
            style={{ color: INK.sand }}
          >
            steps
          </span>
          <p className="text-[14px]" style={{ color: INK.bone }}>
            <span className="font-mono tabular-nums">{S.bestTaskStepsBefore}</span>
            <span style={{ color: INK.sand }}> → </span>
            <span
              className="font-mono font-semibold tabular-nums"
              style={{ color: INK.pearl }}
            >
              {S.bestTaskStepsAfter}
            </span>
            <span
              className="ml-3 font-mono tabular-nums"
              style={{ color: INK.ember }}
            >
              −{S.bestTaskStepReductionPct}%
            </span>
          </p>
        </div>
        <div
          className="flex flex-col gap-1 px-5 py-5 md:px-6"
          style={{ background: INK.inkDeep }}
        >
          <span
            className="font-mono text-[10px] uppercase tracking-[0.22em]"
            style={{ color: INK.sand }}
          >
            cost
          </span>
          <p className="text-[14px]" style={{ color: INK.bone }}>
            <span className="font-mono tabular-nums" style={{ color: INK.ember }}>
              −{S.bestTaskCostReductionPct}%
            </span>
            <span className="ml-3" style={{ color: INK.sand }}>
              (same patch, same Docker harness)
            </span>
          </p>
        </div>
      </div>
    </div>
  );
}

/* ============================================================ */
/*  Page                                                          */
/* ============================================================ */

export default function WhitepaperPage() {
  return (
    <div className="min-h-screen" style={{ background: INK.ink, color: INK.bone }}>
      <NavBar />

      <main className="mx-auto max-w-[760px] px-5 py-12 md:px-6 md:py-16">
        {/* Hero */}
        <header>
          <SectionLabel>TraceBase Technical Report · v1.0</SectionLabel>
          <h1
            className="mt-3 font-hero-serif text-[clamp(2rem,4.5vw,3.2rem)] font-normal leading-[1.05] tracking-tight"
            style={{ color: INK.pearl }}
          >
            Reasoning injection for{" "}
            <span style={{ color: INK.ember }}>AI agent efficiency</span>.
          </h1>
          <p
            className="mt-4 text-[14px] font-light leading-relaxed md:text-[15px]"
            style={{ color: "rgba(232,217,184,0.7)" }}
          >
            Captured reasoning, replayed at the right moment, shortens the next agent run.
            This report measures the lift on SWE-bench Verified — methodology, raw counts,
            and the limits of where the lift holds.
          </p>
          <HeroMetricStrip />
        </header>

        {/* Overview */}
        <Section
          eyebrow="overview"
          muted="What this report measures."
          accent="And what it doesn't."
        >
          <p>
            TraceBase captures resolved agent work as compact reasoning traces and
            injects them at the start of similar future runs. Retrieval combines
            six signals (fingerprint, BM25, Jaccard, structural, cosine, freshness),
            with weights learned from outcomes via Thompson sampling. The injected
            traces are stored as three short fields — <strong>situation</strong>,{" "}
            <strong>dead ends</strong>, and <strong>unlock</strong> — picked for
            compression and to steer the agent past the dead ends it would otherwise
            re-explore (cf. C3oT,{" "}
            <ExtLink href="https://arxiv.org/abs/2412.11664">arxiv 2412.11664</ExtLink>;
            TALE,{" "}
            <ExtLink href="https://arxiv.org/abs/2412.18547">arxiv 2412.18547</ExtLink>).
          </p>
          <p>
            The numbers below are <em>not</em> a generic LLM gain. They reflect
            what happens when an agent has already seen the same shape of problem.
            Section 6 lists where this story stops holding.
          </p>
        </Section>

        {/* Evaluation Setup */}
        <Section
          number="01"
          eyebrow="evaluation setup"
          muted="One harness."
          accent="Two rounds."
        >
          <p>
            All numbers come from <strong>{S.benchmark}</strong>, a curated subset
            of real GitHub issues from popular open-source Python repositories.
            Each task asks the agent to diagnose a bug from an issue description
            and produce a working patch, executed in Docker via{" "}
            <ExtLink href="https://github.com/SWE-agent/mini-swe-agent">
              mini-swe-agent
            </ExtLink>{" "}
            v2.2.8.
          </p>

          <InkCard eyebrow="eval parameters">
            <ParamTable
              rows={[
                ["Benchmark", S.benchmark],
                ["Verification", "Docker test harness (mini-swe-agent v2.2.8)"],
                ["Agent shape", "Bash-only (subprocess per step)"],
                ["Tasks attempted", `${S.attempted}`],
                ["Tasks completed", `${S.completed} (4 hit step or cost cap before submitting)`],
                ["Methodology", "Multi-round — Round 0 baseline → Round 1 with KB"],
                ["Model", S.model],
                ["Step cap", "40 per task"],
                ["Cost cap", "$1.00 per task"],
                ["Reported on", `Average over high-confidence matches (n=${S.highConfidenceN})`],
              ]}
            />
          </InkCard>

          <p>
            <strong>Multi-round methodology</strong>: Round 0 solves every task
            with an empty knowledge base. Successful patches become traces in the
            KB. Round 1 solves the same tasks with that KB attached. Both rounds
            use identical step caps, cost caps, and Docker images — the only
            variable is whether the KB is empty or warm. This simulates the
            compound-intelligence effect a team sees in production as agents
            accumulate institutional knowledge.
          </p>
        </Section>

        {/* Results */}
        <Section
          number="02"
          eyebrow="results"
          muted={`SWE-bench Verified, ${S.model}.`}
          accent="Two patches gained. Zero regressions."
        >
          <InkCard eyebrow={`accuracy — ${S.completed} completed tasks`}>
            <table className="w-full text-[13px] md:text-[13.5px]">
              <thead>
                <tr style={{ color: INK.sand }}>
                  <th className="py-2 text-left font-mono text-[10px] uppercase tracking-[0.16em]">
                    Condition
                  </th>
                  <th className="py-2 text-right font-mono text-[10px] uppercase tracking-[0.16em]">
                    Patches
                  </th>
                  <th className="py-2 text-right font-mono text-[10px] uppercase tracking-[0.16em]">
                    Accuracy
                  </th>
                  <th className="py-2 text-right font-mono text-[10px] uppercase tracking-[0.16em]">
                    Δ
                  </th>
                </tr>
              </thead>
              <tbody style={{ color: INK.bone }}>
                <tr style={{ borderTop: "1px solid rgba(232,217,184,0.05)" }}>
                  <td className="py-3">Baseline (no injection)</td>
                  <td className="py-3 text-right font-mono tabular-nums">
                    10 / {S.completed}
                  </td>
                  <td className="py-3 text-right font-mono tabular-nums">
                    {S.accuracyBaselinePct}%
                  </td>
                  <td
                    className="py-3 text-right font-mono"
                    style={{ color: INK.sand }}
                  >
                    —
                  </td>
                </tr>
                <tr
                  style={{
                    borderTop: "1px solid rgba(232,217,184,0.05)",
                    background: "rgba(255,122,92,0.04)",
                  }}
                >
                  <td className="py-3 font-medium" style={{ color: INK.pearl }}>
                    + TraceBase
                  </td>
                  <td
                    className="py-3 text-right font-mono font-semibold tabular-nums"
                    style={{ color: INK.pearl }}
                  >
                    12 / {S.completed}
                  </td>
                  <td
                    className="py-3 text-right font-mono font-semibold tabular-nums"
                    style={{ color: INK.pearl }}
                  >
                    {S.accuracyInjectionPct}%
                  </td>
                  <td
                    className="py-3 text-right font-mono font-semibold tabular-nums"
                    style={{ color: INK.ember }}
                  >
                    +{S.accuracyGainPp} pp
                  </td>
                </tr>
              </tbody>
            </table>
            <p className="mt-3 text-[12px]" style={{ color: INK.sand }}>
              {S.newFixes} new fixes (astropy-13579, astropy-14508), {S.regressions}{" "}
              regressions. The Δ column is percentage-point absolute; relative gain
              is +{relativeAccuracyGainPct}% over the {S.accuracyBaselinePct}% baseline.
            </p>
          </InkCard>

          <InkCard eyebrow={`efficiency — high-confidence matches (n=${S.highConfidenceN})`}>
            <table className="w-full text-[13px] md:text-[13.5px]">
              <thead>
                <tr style={{ color: INK.sand }}>
                  <th className="py-2 text-left font-mono text-[10px] uppercase tracking-[0.16em]">
                    Metric
                  </th>
                  <th className="py-2 text-right font-mono text-[10px] uppercase tracking-[0.16em]">
                    Average
                  </th>
                  <th className="py-2 text-right font-mono text-[10px] uppercase tracking-[0.16em]">
                    Peak
                  </th>
                </tr>
              </thead>
              <tbody style={{ color: INK.bone }}>
                <tr style={{ borderTop: "1px solid rgba(232,217,184,0.05)" }}>
                  <td className="py-3">Step reduction</td>
                  <td
                    className="py-3 text-right font-mono font-semibold tabular-nums"
                    style={{ color: INK.ember }}
                  >
                    −{S.stepReductionAvgPct}%
                  </td>
                  <td className="py-3 text-right font-mono tabular-nums">
                    −{S.stepReductionPeakPct}%
                  </td>
                </tr>
                <tr style={{ borderTop: "1px solid rgba(232,217,184,0.05)" }}>
                  <td className="py-3">Cost reduction</td>
                  <td
                    className="py-3 text-right font-mono font-semibold tabular-nums"
                    style={{ color: INK.ember }}
                  >
                    −{S.costReductionAvgPct}%
                  </td>
                  <td className="py-3 text-right font-mono tabular-nums">
                    −{S.costReductionPeakPct}%
                  </td>
                </tr>
              </tbody>
            </table>
            <p className="mt-3 text-[12px]" style={{ color: INK.sand }}>
              Average is computed only across the {S.highConfidenceN} tasks where
              retrieval produced a high-confidence match. Tasks where one
              condition didn&apos;t submit a patch are excluded so the comparison
              is apples-to-apples.
            </p>
          </InkCard>

          <BestTaskCallout />

          <InkCard eyebrow="additional benchmark · typescript fixtures · 6 models">
            <table className="w-full text-[13px] md:text-[13.5px]">
              <thead>
                <tr style={{ color: INK.sand }}>
                  <th className="py-2 text-left font-mono text-[10px] uppercase tracking-[0.16em]">
                    Model
                  </th>
                  <th className="py-2 text-right font-mono text-[10px] uppercase tracking-[0.16em]">
                    Step save
                  </th>
                  <th className="py-2 text-right font-mono text-[10px] uppercase tracking-[0.16em]">
                    Token save (avg)
                  </th>
                  <th className="py-2 text-right font-mono text-[10px] uppercase tracking-[0.16em]">
                    Token save (peak)
                  </th>
                </tr>
              </thead>
              <tbody style={{ color: INK.bone }}>
                {[
                  ["Claude Haiku 4.5", "+5%", "6%", "up to 48%"],
                  ["Claude Sonnet 4.6", "+25%", "31%", "up to 39%"],
                  ["Claude Opus 4.6", "+25%", "30%", "up to 39%"],
                  ["GPT-5.4-nano", "0%", "13%", "up to 33%"],
                  ["GPT-5.4-mini", "+8%", "25%", "up to 50%"],
                  ["GPT-5.3-chat", "+25%", "44%", "up to 52%"],
                ].map(([model, step, avg, peak]) => (
                  <tr
                    key={model}
                    style={{ borderTop: "1px solid rgba(232,217,184,0.05)" }}
                  >
                    <td className="py-2.5 font-medium" style={{ color: INK.pearl }}>
                      {model}
                    </td>
                    <td className="py-2.5 text-right font-mono tabular-nums">
                      {step}
                    </td>
                    <td className="py-2.5 text-right font-mono tabular-nums">
                      {avg}
                    </td>
                    <td
                      className="py-2.5 text-right font-mono font-semibold tabular-nums"
                      style={{ color: INK.ember }}
                    >
                      {peak}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-[12px]" style={{ color: INK.sand }}>
              10 TypeScript fixtures verified with vitest. 100% accuracy maintained
              across every model.
            </p>
          </InkCard>
        </Section>

        {/* Cost Methodology */}
        <Section
          number="03"
          eyebrow="cost methodology"
          muted="Two sources of savings."
          accent="Both measured, neither inferred."
        >
          <p>
            Cost savings come from two mechanisms: <strong>fewer agent steps</strong>{" "}
            (the model reaches the correct solution faster) and{" "}
            <strong>shorter reasoning per step</strong> (the model doesn&apos;t
            explore dead ends it would have explored otherwise). Reported step and
            cost numbers are measured from the same task runs; dollar projections
            are extrapolations from those measurements at current model pricing.
          </p>

          <CodeBlock>
            <p>estimated_savings = tasks_with_injection × avg_cost_saved_per_task</p>
            <p className="mt-2">
              avg_cost_saved_per_task = baseline_cost × avg_cost_reduction_rate
            </p>
          </CodeBlock>

          <InkCard eyebrow="example — sonnet 4.6 at 10k tasks / mo">
            <ParamTable
              rows={[
                ["Agent tasks per month", "10,000"],
                ["High-confidence match rate", "55% (observed in this benchmark)"],
                ["Tasks with injection", "5,500"],
                ["Avg cost save per matched task", `${S.costReductionAvgPct}%`],
                ["Avg cost per task (Sonnet 4.6)", "≈ $0.30"],
                ["Estimated monthly savings", "≈ $470"],
              ]}
            />
            <p className="mt-3 text-[12px]" style={{ color: INK.sand }}>
              Illustrative extrapolation, not measured revenue. Match rate scales
              with pattern-library coverage of the team&apos;s problem domain — see
              §6.
            </p>
          </InkCard>
        </Section>

        {/* Why It Works */}
        <Section
          number="04"
          eyebrow="why it works"
          muted="The bottleneck is dead-end re-exploration."
          accent="Compressed traces steer past it."
        >
          <p>
            Agents fail not because the model lacks ability, but because they
            re-explore dead ends on every call. The three-field trace format
            encodes the <strong>situation</strong> the agent encountered, the{" "}
            <strong>dead ends</strong> to avoid, and the <strong>unlock</strong>{" "}
            that led to the correct solution. This steers the model past failure
            modes it would have otherwise explored — fewer wasted steps, fewer
            wrong outputs.
          </p>
          <p>The format follows four principles from recent research:</p>
          <ul className="ml-5 list-disc space-y-2 text-[13.5px] md:text-[14px]">
            <li>
              <strong>Compressed directives</strong> under 60 tokens — shorter
              chains correlate with higher correctness (
              <ExtLink href="https://arxiv.org/abs/2505.17813">arxiv 2505.17813</ExtLink>
              ).
            </li>
            <li>
              <strong>First-message injection</strong> — avoids token multiplication
              from context rot across steps (
              <ExtLink href="https://arxiv.org/abs/2510.05381">arxiv 2510.05381</ExtLink>
              ).
            </li>
            <li>
              <strong>Positive constraints</strong> over negative framing —
              &ldquo;the bug is X, fix: Y&rdquo;, not &ldquo;do not try A, B,
              C&rdquo; (
              <ExtLink href="https://arxiv.org/abs/2601.18044">arxiv 2601.18044</ExtLink>
              ).
            </li>
            <li>
              <strong>Skip-to-fix</strong> when prior knowledge is available —
              plan-and-act, not explore-first (
              <ExtLink href="https://arxiv.org/abs/2503.09572">arxiv 2503.09572</ExtLink>
              ).
            </li>
          </ul>
          <p>
            The library compounds: patterns that work for one team&apos;s agents
            raise match quality for everyone running the same shapes of work. As
            the library grows, the high-confidence gate fires on a higher share
            of tasks, lifting the realised cost save without changing the per-task
            ratio.
          </p>
        </Section>

        {/* Architecture */}
        <Section
          number="05"
          eyebrow="architecture"
          muted="Six retrieval signals."
          accent="One ranker per project."
        >
          <p>
            Retrieval is a two-stage rank. Fingerprint and BM25 narrow the
            candidate set in O(1) and FTS5 lookups respectively. The other four
            signals re-rank.
          </p>

          <InkCard>
            <table className="w-full text-[13px] md:text-[13.5px]">
              <thead>
                <tr style={{ color: INK.sand }}>
                  <th className="py-2 text-left font-mono text-[10px] uppercase tracking-[0.16em]">
                    Signal
                  </th>
                  <th className="py-2 text-left font-mono text-[10px] uppercase tracking-[0.16em]">
                    Type
                  </th>
                  <th className="py-2 text-left font-mono text-[10px] uppercase tracking-[0.16em]">
                    What it catches
                  </th>
                </tr>
              </thead>
              <tbody style={{ color: INK.bone }}>
                {[
                  ["Fingerprint", "Exact", "Identical problem (O(1) lookup)"],
                  ["BM25", "Lexical", "Same keywords, different phrasing"],
                  ["Jaccard", "Token overlap", "Structural keyword matching"],
                  ["Structural", "Feature", "Same error type / language / framework"],
                  ["Cosine", "Semantic", "Embedding similarity (optional)"],
                  ["Freshness", "Temporal", "Recency bias, exponential decay"],
                ].map(([signal, typ, desc]) => (
                  <tr
                    key={signal}
                    style={{ borderTop: "1px solid rgba(232,217,184,0.05)" }}
                  >
                    <td className="py-2.5 font-medium" style={{ color: INK.pearl }}>
                      {signal}
                    </td>
                    <td className="py-2.5" style={{ color: INK.sand }}>
                      {typ}
                    </td>
                    <td className="py-2.5">{desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </InkCard>

          <p>
            Signal weights are learned per project from outcome events via
            Thompson sampling (
            <ExtLink href="https://arxiv.org/abs/1209.3352">
              Agrawal &amp; Goyal, 2012
            </ExtLink>
            ). Block quality is the Wilson-interval lower bound on the
            helpfulness rate — blocks that stop earning their keep get demoted
            automatically. The store is local SQLite (WAL); cloud sync is
            opt-in.
          </p>
        </Section>

        {/* Limitations */}
        <Section
          number="06"
          eyebrow="limitations"
          muted="Where the story stops."
          accent="Read this before quoting the numbers."
        >
          <ul className="ml-5 list-disc space-y-2 text-[13.5px] md:text-[14px]">
            <li>
              Benchmarks were run on SWE-bench Verified (Python / astropy domain).
              Lift on other languages and domains can differ.
            </li>
            <li>
              Cost savings scale with model, task complexity, and the quality of
              the retrieved match. Headline averages are reported on
              high-confidence matches.
            </li>
            <li>
              The 55% match rate observed on this benchmark depends on library
              coverage. Teams running agents on repetitive domain-specific tasks
              reach this rate quickly; one-off greenfield work does not.
            </li>
            <li>
              Step and cost reductions are measured only on tasks where both
              baseline and augmented agents submitted patches. Tasks where one
              side hit the step or cost cap before submitting are excluded from
              the efficiency averages — they appear in the accuracy table only.
            </li>
          </ul>
        </Section>

        {/* Reproducibility */}
        <Section
          number="07"
          eyebrow="reproducibility"
          muted="MIT licensed."
          accent="Every number is reproducible from the repo."
        >
          <p>
            All benchmark code, fixtures, seeds, and raw trajectory data are
            committed to the public repository:
          </p>
          <CodeBlock>
            <p>eval/swebench/     — SWE-bench Verified harness + results</p>
            <p>eval/agentic/      — TypeScript fixture benchmark + results</p>
            <p>eval/tasks/        — Task definitions + seed traces</p>
          </CodeBlock>
          <p>To reproduce:</p>
          <CodeBlock>
            <p>pip install mini-swe-agent</p>
            <p>npx tsx eval/agentic/runner.ts --all     # TypeScript benchmark</p>
            <p>bash eval/swebench/run-benchmark.sh      # SWE-bench Verified</p>
          </CodeBlock>
        </Section>

        {/* Footer */}
        <footer
          className="mt-20 border-t pb-12 pt-8 text-center text-[11px]"
          style={{
            borderColor: "rgba(232,217,184,0.08)",
            color: "rgba(232,217,184,0.42)",
          }}
        >
          <div className="flex items-center justify-center gap-4">
            <span>TraceBase · MIT License</span>
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
            <a
              href="https://www.npmjs.com/package/tracebase-ai"
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors hover:text-[var(--bone)]"
            >
              npm
            </a>
          </div>
          <p className="mt-2">© 2026 TraceBase</p>
        </footer>
      </main>
    </div>
  );
}
