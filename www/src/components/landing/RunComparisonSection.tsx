"use client";

import Link from "next/link";
import { type ReactNode, useEffect, useState } from "react";

const COLD_STEPS = [
  "Every incident starts cold—no ranked priors in the prompt",
  "Model explores from scratch; more drafts, more retries",
  "Accuracy is whatever the model guesses this time",
  "You pay the full token cost again on the next ticket",
] as const;

const WARM_STEPS = [
  "Recall pulls ranked traces before tokens hit the model",
  "Top match is injected as a compact, grounded hint",
  "Completion path shortens—fewer speculative tokens",
  "storeTrace writes the win back for the next incident",
] as const;

function StepNotifications({
  steps,
  active,
  pinned,
  onPick,
  accent,
  label,
}: {
  steps: readonly string[];
  active: number;
  pinned: number | null;
  onPick: (index: number | null) => void;
  accent: boolean;
  label: string;
}) {
  const shown = pinned ?? active;
  const prev = (shown - 1 + steps.length) % steps.length;

  return (
    <div className="w-full">
      <p className="sr-only">{label}</p>
      <div className="relative min-h-[4.75rem] w-full">
        <div
          className="pointer-events-none absolute inset-x-0 top-1.5 z-0 rounded-[18px] border px-3 py-2 text-[10px] font-light leading-snug"
          style={{
            borderColor: "rgba(255,255,255,0.06)",
            color: "rgba(237,236,236,0.35)",
            background: "rgba(255,255,255,0.018)",
            opacity: 0.9,
            transform: "translateY(6px) scale(0.98)",
          }}
          aria-hidden
        >
          {steps[prev]}
        </div>

        <output
          key={shown}
          className="hero-toast-in relative z-10 block w-full rounded-[18px] border px-3 py-3 text-[11px] font-light leading-snug shadow-[0_18px_40px_rgba(0,0,0,0.26)]"
          style={{
            borderColor: accent ? "rgba(177,255,109,0.26)" : "rgba(255,255,255,0.12)",
            color: "rgba(237,236,236,0.92)",
            background: accent ? "rgba(255,255,255,0.03)" : "rgba(255,255,255,0.028)",
            backdropFilter: "blur(10px)",
            WebkitBackdropFilter: "blur(10px)",
          }}
          aria-live="polite"
        >
          {steps[shown]}
        </output>
      </div>

      <div className="mt-4 flex gap-1.5" role="tablist" aria-label={label}>
        {steps.map((_, i) => {
          const on = shown === i;

          return (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={on}
              aria-label={`${label} ${i + 1} of ${steps.length}`}
              onClick={() => onPick(pinned === i ? null : i)}
              className="h-1 min-h-[4px] min-w-0 flex-1 rounded-full transition-[background-color,box-shadow,transform] duration-500 ease-out hover:brightness-125 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
              style={{
                background: on
                  ? accent
                    ? "var(--accent)"
                    : "rgba(237,236,236,0.55)"
                  : "rgba(255,255,255,0.1)",
                outlineColor: accent ? "var(--accent)" : "rgba(237,236,236,0.46)",
                boxShadow: on && accent ? "0 0 14px rgba(177,255,109,0.28)" : on ? "0 0 12px rgba(237,236,236,0.1)" : "none",
                transform: on ? "scaleY(1.25)" : "scaleY(1)",
              }}
            />
          );
        })}
      </div>

      <div className="mt-3 min-h-[2.75rem]">
        <p
          className={`text-[10px] font-light leading-snug ${pinned === null ? "invisible" : ""}`}
          style={{ color: "rgba(237,236,236,0.38)" }}
          aria-hidden={pinned === null}
        >
          Tap the active bar to resume auto.
        </p>
      </div>
    </div>
  );
}

function ComparisonTop({
  eyebrow,
  accent,
  gridClass,
  children,
}: {
  eyebrow: string;
  accent: boolean;
  gridClass: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`flex min-h-0 flex-col p-6 md:p-8 ${gridClass}`}
      style={{ background: "var(--bg)" }}
    >
      <p className="text-[10px] font-mono uppercase tracking-[0.18em]" style={{ color: accent ? "rgba(177,255,109,0.58)" : "var(--text-tertiary)" }}>
        {eyebrow}
      </p>
      <div className="mt-auto pt-10">{children}</div>
    </div>
  );
}

function ComparisonBottom({
  title,
  body,
  footer,
  gridClass,
}: {
  title: string;
  body: string;
  footer: ReactNode;
  gridClass: string;
}) {
  return (
    <div className={`border-t px-6 py-6 md:px-8 md:py-7 ${gridClass}`} style={{ background: "var(--bg)", borderColor: "var(--border)" }}>
      <h3 className="text-[1.45rem] font-light tracking-tight md:text-[1.7rem]">{title}</h3>
      <p className="mt-3 max-w-[34rem] text-sm font-light leading-relaxed" style={{ color: "var(--text-secondary)" }}>
        {body}
      </p>
      <div className="mt-5 text-xs font-light leading-relaxed" style={{ color: "rgba(237,236,236,0.46)" }}>
        {footer}
      </div>
    </div>
  );
}

export function RunComparisonSection() {
  const [coldIdx, setColdIdx] = useState(0);
  const [warmIdx, setWarmIdx] = useState(0);
  const [coldPinned, setColdPinned] = useState<number | null>(null);
  const [warmPinned, setWarmPinned] = useState<number | null>(null);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    let coldTimer: ReturnType<typeof setInterval> | undefined;
    let warmTimer: ReturnType<typeof setInterval> | undefined;

    const sync = () => {
      if (coldTimer) clearInterval(coldTimer);
      if (warmTimer) clearInterval(warmTimer);
      coldTimer = undefined;
      warmTimer = undefined;

      if (mq.matches) return;

      coldTimer = setInterval(() => setColdIdx((i) => (i + 1) % COLD_STEPS.length), 3200);
      warmTimer = setInterval(() => setWarmIdx((i) => (i + 1) % WARM_STEPS.length), 3000);
    };

    sync();
    mq.addEventListener("change", sync);

    return () => {
      mq.removeEventListener("change", sync);
      if (coldTimer) clearInterval(coldTimer);
      if (warmTimer) clearInterval(warmTimer);
    };
  }, []);

  const gridShell = "grid grid-cols-1 gap-px lg:grid-cols-2 lg:grid-rows-[auto_auto]";

  return (
    <section className="scroll-mt-20 py-20 md:py-24" id="compare">
      <div className="mb-10 max-w-[760px] md:mb-12">
        <p className="mb-5 text-xs font-light tracking-[0.22em] uppercase" style={{ color: "var(--text-tertiary)" }}>
          Before / After
        </p>
        <h2 className="text-[clamp(1.85rem,4vw,3.15rem)] font-light leading-[1.02] tracking-tight">
          Same model.
          <br />
          Different run profile.
        </h2>
        <p className="mt-5 max-w-2xl text-sm font-light leading-relaxed" style={{ color: "var(--text-secondary)" }}>
          TraceBase does not change the model choice. It changes what the model starts with and what the next run gets
          back after a fix has already shipped.
        </p>
      </div>

      <div
        className="overflow-hidden border"
        style={{
          borderColor: "var(--border)",
          background: "rgba(255,255,255,0.02)",
        }}
      >
        <div className={gridShell} style={{ background: "var(--border)" }}>
          <ComparisonTop eyebrow="Same model, no layer" accent={false} gridClass="lg:col-start-1 lg:row-start-1">
            <StepNotifications
              steps={COLD_STEPS}
              active={coldIdx}
              pinned={coldPinned}
              onPick={setColdPinned}
              accent={false}
              label="Cold path steps"
            />
          </ComparisonTop>

          <ComparisonBottom
            gridClass="lg:col-start-1 lg:row-start-2"
            title="Cold path every time"
            body="No recall path means every repeat case still pays for fresh exploration. The model can solve it, but it does not start from what already worked."
            footer="No prior context is injected before the call."
          />

          <ComparisonTop eyebrow="With TraceBase" accent gridClass="lg:col-start-2 lg:row-start-1">
            <StepNotifications
              steps={WARM_STEPS}
              active={warmIdx}
              pinned={warmPinned}
              onPick={setWarmPinned}
              accent
              label="TraceBase flow steps"
            />
          </ComparisonTop>

          <ComparisonBottom
            gridClass="lg:col-start-2 lg:row-start-2"
            title="Priors before the answer"
            body="Recall surfaces strong matches before tokens hit the model, then successful runs are written back so the next repeat case starts grounded instead of blank."
            footer={
              <>
                Benchmarks and methodology in the{" "}
                <Link href="/whitepaper" className="underline decoration-white/20 underline-offset-2 transition-colors hover:text-[var(--text)]">
                  whitepaper
                </Link>
                .
              </>
            }
          />
        </div>
      </div>
    </section>
  );
}
