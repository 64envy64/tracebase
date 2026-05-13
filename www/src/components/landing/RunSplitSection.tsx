"use client";

import { useEffect, useState, type ReactNode } from "react";
import { InkSplatter } from "./brand/Marks";
import { CardEyebrow, Chip, CostBar, ResultBox, SectionLabel, StepRow } from "./brand/Primitives";
import { Reveal } from "./brand/Reveal";
import { type ChipTone, INK } from "./brand/tokens";
import { useInView } from "./brand/useInView";

/* ============================================================ */
/*  Sequence timing — single source of truth for animation       */
/*  choreography across prompt → steps → result → cost footer.   */
/*                                                                */
/*  Slowed ~60% from the initial pass so a first-time reader     */
/*  can actually parse what each step is doing on the right      */
/*  ("with tracebase") column. CSS animation durations           */
/*  (.step-reveal, .ink-rise) are unchanged — these JS numbers   */
/*  only stretch the PAUSES between events, never the keyframe   */
/*  itself, so motion stays smooth.                              */
/* ============================================================ */

const PROMPT_CHAR_MS = 22;       // typing speed, per character (was 12)
const STEP_STAGGER_MS = 160;     // gap between successive step reveals (was 90)
const STEP_DURATION_MS = 520;    // schedule buffer for last step to "land" (was 420)
const PAUSE_AFTER_PROMPT_MS = 360;  // (was 200)
const PAUSE_AFTER_STEPS_MS = 260;   // (was 180)
const RESULT_DURATION_MS = 720;  // schedule buffer for result to settle (was 680)
const PAUSE_AFTER_RESULT_MS = 380;  // (was 280)

/* ============================================================ */
/*  Types + data                                                  */
/* ============================================================ */

type ChipRef = { tone: ChipTone; label: string };

type RunStep = {
  n?: ReactNode;
  tool?: string;
  args?: ReactNode;
  note?: ReactNode;
  chips?: ChipRef[];
  counter?: string;
};

type RunResult = {
  tone: "success" | "danger" | "warning" | "info";
  title: string;
  body: ReactNode;
  trailing?: ReactNode;
};

type RunSide = {
  steps: RunStep[];
  result: RunResult;
  cost: string;
  segments: number;
  turns: string;
};

type Scenario = {
  id: string;
  prompt: string;
  without: RunSide;
  with: RunSide;
  maxSegments: number;
  savedPct: number;
  savedSteps: string;
};

const SCENARIOS: readonly Scenario[] = [
  {
    id: "ws-reconnect-race",
    prompt: "Fix WebSocket reconnect race — clients drop messages after a flaky network blip.",
    without: {
      steps: [
        { n: "08", tool: "Read", args: <code>src/realtime/ws_client.ts</code> },
        { n: "09", tool: "Grep", args: <code>/reconnect|backoff/</code> },
        { n: "10", tool: "Read", args: <code>src/realtime/socket_pool.ts</code> },
        { n: "11", note: "Retry with exponential backoff — first attempt." },
        { n: "12", tool: "Test", args: <code>npm test realtime</code>, note: "Two specs still flake under jitter." },
        { n: "13", tool: "Read", args: <code>src/realtime/ws_client.ts</code> },
        { n: "14", tool: "Grep", args: <code>/addEventListener\(&quot;open&quot;/</code> },
        { n: "15", note: "Second attempt — guard flag on reconnect." },
        { n: "16", tool: "Test", args: <code>npm test realtime</code>, note: "One green, two still flake." },
      ],
      result: {
        tone: "warning",
        title: "Partial",
        body: "16 steps in, two specs still flaking. Same region of code touched three times.",
      },
      cost: "$2.85",
      segments: 16,
      turns: "16 steps",
    },
    with: {
      steps: [
        {
          n: "1",
          tool: "Recall",
          args: <code>shape = reconnect flap</code>,
          chips: [{ tone: "ember", label: "trace · matched #5204" }],
        },
        {
          n: "2",
          tool: "Read",
          args: <code>src/realtime/ws_client.ts</code>,
          chips: [{ tone: "sand", label: "gist · cached (8.1kb saved)" }],
        },
        {
          n: "3",
          tool: "Edit",
          args: <code>ws_client.ts + seq_buffer.ts</code>,
          chips: [{ tone: "amber", label: "tool · skipped 3 re-greps" }],
        },
        {
          n: "4",
          tool: "Test",
          args: <code>npm test realtime</code>,
          chips: [{ tone: "coral", label: "loop · clear" }],
        },
      ],
      result: {
        tone: "success",
        title: "Resolved",
        body: "Backoff + seq-id dedupe applied. Reconnect stable across simulated jitter.",
        trailing: <Chip tone="ember">trace saved · #6102</Chip>,
      },
      cost: "$0.92",
      segments: 5,
      turns: "4 steps",
    },
    maxSegments: 16,
    savedPct: 68,
    savedSteps: "4 of 16",
  },
] as const;

/* ============================================================ */
/*  Section root                                                  */
/* ============================================================ */

export function RunSplitSection() {
  return (
    <section id="runs" className="scroll-mt-20 py-12 md:py-20" style={{ color: INK.bone }}>
      <div className="mx-auto max-w-[1080px] px-5 sm:px-6">
        <Reveal>
          <RunSplitHeader />
        </Reveal>
        <div className="flex flex-col gap-12 md:gap-16">
          {SCENARIOS.map((s) => (
            <ScenarioBlock key={s.id} scenario={s} />
          ))}
        </div>
      </div>
    </section>
  );
}

function RunSplitHeader() {
  return (
    <header className="mb-10 max-w-[44rem] md:mb-12">
      <CardEyebrow chipLabel="Split" chipTone="ember" status="live" />
      <h2
        className="mt-4 font-hero-serif text-[clamp(1.9rem,4vw,3.2rem)] font-normal leading-[1.04] tracking-tight"
        style={{ color: INK.pearl }}
      >
        <span style={{ color: "rgba(232,217,184,0.48)" }}>Same problem.</span>{" "}
        Two runs, <span style={{ color: INK.ember }}>written side by side</span>.
      </h2>
      <p
        className="mt-5 max-w-[36rem] text-[14px] font-light leading-relaxed md:text-[15px]"
        style={{ color: "rgba(232,217,184,0.68)" }}
      >
        Same prompt, same model, same tools. Left — no memory. Right — tracebase attached.
      </p>
    </header>
  );
}

/* ============================================================ */
/*  Scenario block — the sequenced comparison.                   */
/*                                                                */
/*  Sequence, once the block enters view:                         */
/*    1. prompt types out                                         */
/*    2. steps appear one after another in both columns           */
/*    3. each column's result appears when its steps are done     */
/*    4. the cost footer resolves after the slower side finishes  */
/* ============================================================ */

type Timings = {
  stepsStartMs: number;
  withoutResultMs: number;
  withResultMs: number;
  costFooterMs: number;
};

function computeTimings(scenario: Scenario): Timings {
  const typingDoneMs = scenario.prompt.length * PROMPT_CHAR_MS;
  const stepsStartMs = typingDoneMs + PAUSE_AFTER_PROMPT_MS;

  const lastStep = (count: number) =>
    stepsStartMs + Math.max(0, count - 1) * STEP_STAGGER_MS + STEP_DURATION_MS;

  const withoutResultMs = lastStep(scenario.without.steps.length) + PAUSE_AFTER_STEPS_MS;
  const withResultMs = lastStep(scenario.with.steps.length) + PAUSE_AFTER_STEPS_MS;
  const costFooterMs =
    Math.max(withoutResultMs, withResultMs) + RESULT_DURATION_MS + PAUSE_AFTER_RESULT_MS;

  return { stepsStartMs, withoutResultMs, withResultMs, costFooterMs };
}

function ScenarioBlock({ scenario }: { scenario: Scenario }) {
  const [ref, inView] = useInView<HTMLDivElement>({ threshold: 0.15 });
  const t = computeTimings(scenario);

  return (
    <article
      ref={ref}
      aria-label={scenario.prompt}
      className="relative overflow-hidden rounded-xl border"
      style={{ borderColor: "rgba(232,217,184,0.12)", background: INK.inkDeep }}
    >
      <InkSplatter
        size={84}
        opacity={0.07}
        className="pointer-events-none absolute"
        style={{ right: -16, top: -18 }}
      />
      <PromptHeader id={scenario.id} prompt={scenario.prompt} inView={inView} />

      <div className="grid gap-px" style={{ background: "rgba(232,217,184,0.08)", gridTemplateColumns: "1fr" }}>
        <div className="grid gap-px md:grid-cols-2" style={{ background: "rgba(232,217,184,0.08)" }}>
          <RunPanel
            title="without"
            subtitle={scenario.without.turns}
            cost={scenario.without.cost}
            costTone="danger"
            steps={scenario.without.steps}
            result={scenario.without.result}
            inView={inView}
            stepsStartMs={t.stepsStartMs}
            resultDelayMs={t.withoutResultMs}
          />
          <RunPanel
            title="with tracebase"
            subtitle={scenario.with.turns}
            cost={scenario.with.cost}
            costTone="success"
            steps={scenario.with.steps}
            result={scenario.with.result}
            inView={inView}
            stepsStartMs={t.stepsStartMs}
            resultDelayMs={t.withResultMs}
            emphasize
          />
        </div>

        <CostFooter scenario={scenario} inView={inView} baseDelayMs={t.costFooterMs} />
      </div>
    </article>
  );
}

/* ============================================================ */
/*  PromptHeader — typewriter. Types one char at a time once     */
/*  the block enters view. Caret stays as a steady runtime      */
/*  indicator; the sequence downstream hinges on deterministic  */
/*  typing duration, not on a callback.                          */
/* ============================================================ */

function PromptHeader({ id, prompt, inView }: { id: string; prompt: string; inView: boolean }) {
  const [typed, setTyped] = useState(0);

  useEffect(() => {
    // useInView is reveal-once: inView only flips false → true. Start typing
    // when that happens; the initial typed=0 state covers the pre-reveal case.
    if (!inView) return;
    let i = 0;
    const id = window.setInterval(() => {
      i += 1;
      setTyped(i);
      if (i >= prompt.length) window.clearInterval(id);
    }, PROMPT_CHAR_MS);
    return () => window.clearInterval(id);
  }, [inView, prompt]);

  return (
    <header className="px-5 py-5 md:px-7 md:py-6" style={{ background: INK.ink }}>
      <div
        id={`scenario-${id}`}
        className="flex items-start gap-3 font-mono text-[14px] leading-relaxed md:text-[15px]"
        style={{
          color: INK.pearl,
          opacity: inView ? 1 : 0,
          transition: "opacity 360ms cubic-bezier(0.22, 1, 0.36, 1) 80ms",
        }}
      >
        <span style={{ color: INK.ember, fontWeight: 700 }}>&gt;</span>
        <span style={{ flex: 1, minWidth: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {prompt.slice(0, typed)}
          <span
            className="ink-caret"
            style={{
              display: "inline-block",
              width: 8,
              height: 16,
              marginLeft: typed > 0 ? 2 : 0,
              background: INK.ember,
              verticalAlign: "-2px",
            }}
          />
        </span>
      </div>
    </header>
  );
}

/* ============================================================ */
/*  RunPanel — header, steps, result. Everything sequenced off   */
/*  the shared stepsStartMs + a per-side resultDelayMs.          */
/* ============================================================ */

function RunPanel({
  title,
  subtitle,
  cost,
  costTone,
  steps,
  result,
  inView,
  stepsStartMs,
  resultDelayMs,
  emphasize = false,
}: {
  title: string;
  subtitle: string;
  cost: string;
  costTone: "danger" | "success";
  steps: RunStep[];
  result: RunResult;
  inView: boolean;
  stepsStartMs: number;
  resultDelayMs: number;
  /** When true, the panel renders a 2px ember stripe on its left edge and
   *  every step-row trace chip pulses with a slow ember halo — visual cue
   *  that this is the column where Tracebase intervened. */
  emphasize?: boolean;
}) {
  // Panel header sits just before the first step lands so the column frame is
  // visible as work starts happening inside it.
  const headerDelayMs = Math.max(0, stepsStartMs - 160);

  return (
    <div
      className="flex min-w-0 flex-col gap-4 px-5 py-5 md:px-6 md:py-6"
      style={{
        background: INK.inkDeep,
        // Static (non-pulsing) ember stripe along the left edge of the
        // "with tracebase" column. Inset box-shadow rather than a border
        // so it doesn't shift the panel's content box width vs. the
        // sibling panel.
        boxShadow: emphasize ? "inset 2px 0 0 0 rgba(255,122,92,0.5)" : undefined,
      }}
    >
      <RiseBlock inView={inView} delayMs={headerDelayMs}>
        <div className="flex items-baseline justify-between gap-3">
          <SectionLabel>{title}</SectionLabel>
          <span
            className="font-mono text-[20px] font-semibold tracking-tight md:text-[22px]"
            style={{ color: costTone === "danger" ? "#ef8a74" : INK.ember }}
          >
            {cost}
          </span>
        </div>
        <div className="mt-1 flex items-center justify-between gap-3 text-[11px]" style={{ color: INK.sand }}>
          <span className="font-mono uppercase tracking-[0.16em]">{subtitle}</span>
        </div>
      </RiseBlock>

      <div className="flex flex-col">
        {steps.map((step, i) => (
          <StepRow
            key={i}
            n={step.n}
            tool={step.tool}
            args={step.args}
            note={step.note}
            trailing={renderStepTrailing(step, emphasize)}
            inView={inView}
            delayMs={stepsStartMs + i * STEP_STAGGER_MS}
          />
        ))}
      </div>

      <RiseBlock inView={inView} delayMs={resultDelayMs}>
        <ResultBox tone={result.tone} title={result.title} trailing={result.trailing}>
          {result.body}
        </ResultBox>
      </RiseBlock>
    </div>
  );
}

/** Shared primitive: animates child into view via .ink-rise once inView flips. */
function RiseBlock({
  children,
  inView,
  delayMs,
}: {
  children: ReactNode;
  inView: boolean;
  delayMs: number;
}) {
  return (
    <div
      className={inView ? "ink-rise" : undefined}
      style={{
        ["--ink-rise-delay" as string]: `${delayMs}ms`,
        // When inView is false we force opacity 0 inline so the block is hidden
        // up front. Once inView is true we hand control to the animation's
        // `both` fill-mode so there is no inline override mid-sequence.
        ...(inView ? {} : { opacity: 0 }),
      }}
    >
      {children}
    </div>
  );
}

function renderStepTrailing(step: RunStep, emphasize: boolean): ReactNode {
  if (step.chips && step.chips.length > 0) {
    return step.chips.map((c, i) => (
      // The .ink-chip-glow class adds a slow looped halo (box-shadow only,
      // never resizes the chip), which is how we signal "tracebase touched
      // this row" on the emphasized column without baking colour into the
      // chip itself. Chips mount in sequence as steps reveal, so their
      // glow cycles naturally stagger by mount time — no manual --delay
      // tuning needed.
      <Chip key={i} tone={c.tone} size="sm" className={emphasize ? "ink-chip-glow" : undefined}>
        {c.label}
      </Chip>
    ));
  }
  if (step.counter) {
    return (
      <span style={{ color: INK.sand, fontSize: 11, fontFamily: "ui-monospace, monospace" }}>
        {step.counter}
      </span>
    );
  }
  return null;
}

/* ============================================================ */
/*  Cost footer — dual bar + headline savings                    */
/* ============================================================ */

function CostFooter({
  scenario,
  inView,
  baseDelayMs,
}: {
  scenario: Scenario;
  inView: boolean;
  baseDelayMs: number;
}) {
  return (
    <div
      className="grid gap-6 px-5 py-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-center md:gap-10 md:px-7 md:py-6"
      style={{ background: INK.ink }}
    >
      <RiseBlock inView={inView} delayMs={baseDelayMs}>
        <div className="flex flex-col gap-3">
          <SectionLabel>per-run cost</SectionLabel>
          <div className="flex flex-col gap-2.5">
            <CostBar
              label="without"
              value={scenario.without.cost}
              maxSegments={scenario.maxSegments}
              segments={scenario.without.segments}
              tone="danger"
              struck
              inView={inView}
              delayMs={baseDelayMs}
            />
            <CostBar
              label="with tracebase"
              value={scenario.with.cost}
              maxSegments={scenario.maxSegments}
              segments={scenario.with.segments}
              tone="success"
              inView={inView}
              delayMs={baseDelayMs + 220}
            />
          </div>
        </div>
      </RiseBlock>
      <RiseBlock inView={inView} delayMs={baseDelayMs + 120}>
        <div className="flex items-end justify-end gap-5 md:flex-col md:items-end md:gap-2" style={{ color: INK.ember }}>
          <div className="flex flex-col items-end">
            <span
              className="font-mono text-[10px] uppercase tracking-[0.2em]"
              style={{ color: INK.sand }}
            >
              saved
            </span>
            <span className="font-mono text-[clamp(2rem,5vw,3.2rem)] font-semibold leading-none tracking-tight">
              −{scenario.savedPct}%
            </span>
          </div>
          <div className="flex flex-col items-end">
            <span
              className="font-mono text-[10px] uppercase tracking-[0.2em]"
              style={{ color: INK.sand }}
            >
              resolved in
            </span>
            <span className="font-mono text-[14px] font-medium" style={{ color: INK.bone }}>
              {scenario.savedSteps}
            </span>
          </div>
        </div>
      </RiseBlock>
    </div>
  );
}
