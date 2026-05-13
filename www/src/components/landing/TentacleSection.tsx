"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  FoldMockup,
  GistMockup,
  GuardMockup,
  LoopMockup,
  RecallMockup,
} from "./_demo-fixtures/capability-mockups";
import { PrimaryOcto } from "./brand/Marks";
import { CardEyebrow, Chip, SectionLabel } from "./brand/Primitives";
import { CAPABILITIES, type CapabilityId, INK } from "./brand/tokens";

/* ============================================================ */
/*  Static mockup dispatcher — replaces the heavier              */
/*  CapabilityDemo that previously cycled through trace rows on  */
/*  a self-scheduling timer chain. The sticky-octopus scroll     */
/*  choreography around the cards stays exactly as before; only  */
/*  the inner demo is swapped for a single static frame with     */
/*  one looped highlight pulse, so the section is calmer and     */
/*  every row lands in one scroll without waiting for cycles.    */
/* ============================================================ */

const CAP_MOCKUP_BY_ID: Record<CapabilityId, () => ReactNode> = {
  recall: RecallMockup,
  gist: GistMockup,
  loop: LoopMockup,
  guard: GuardMockup,
  fold: FoldMockup,
};

/* ============================================================ */
/*  Section — sticky octopus on the left reaches toward each     */
/*  capability card as it scrolls into view.                     */
/* ============================================================ */

export function TentacleSection() {
  const rowRefs = useRef<Array<HTMLElement | null>>([]);
  // If IntersectionObserver is unavailable, fall back to all-revealed state.
  const hasIO = typeof window !== "undefined" && typeof IntersectionObserver !== "undefined";
  const [activeIndex, setActiveIndex] = useState<number>(() => (hasIO ? 0 : CAPABILITIES.length - 1));
  const [revealedUpTo, setRevealedUpTo] = useState<number>(() => (hasIO ? -1 : CAPABILITIES.length - 1));

  const setRef = useCallback((idx: number) => (el: HTMLElement | null) => {
    rowRefs.current[idx] = el;
  }, []);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        let best: { idx: number; ratio: number } | null = null;
        entries.forEach((entry) => {
          const idx = Number(entry.target.getAttribute("data-cap-idx"));
          if (entry.isIntersecting) {
            setRevealedUpTo((prev) => Math.max(prev, idx));
            if (!best || entry.intersectionRatio > best.ratio) {
              best = { idx, ratio: entry.intersectionRatio };
            }
          }
        });
        if (best !== null) {
          setActiveIndex((best as { idx: number; ratio: number }).idx);
        }
      },
      {
        threshold: [0.25, 0.55, 0.8],
        rootMargin: "-30% 0px -30% 0px",
      },
    );

    rowRefs.current.forEach((el) => {
      if (el) observer.observe(el);
    });

    return () => observer.disconnect();
  }, []);

  return (
    <section
      id="capabilities"
      aria-labelledby="capabilities-heading"
      className="scroll-mt-20 py-16 md:py-24"
      style={{ color: INK.bone }}
    >
      <div className="mx-auto max-w-[1180px] px-5 sm:px-6">
        <SectionHeader />

        <div className="grid gap-10 lg:grid-cols-[minmax(0,0.42fr)_minmax(0,0.58fr)] lg:gap-12">
          <aside className="hidden lg:block">
            <div className="sticky top-24 flex flex-col gap-6">
              <div
                className="relative overflow-hidden rounded-xl border"
                style={{
                  borderColor: "rgba(232,217,184,0.1)",
                  background: INK.inkDeep,
                }}
              >
                <PrimaryOcto
                  activeIndex={activeIndex}
                  revealedUpTo={revealedUpTo}
                />
              </div>
              <ActiveLegend activeIndex={activeIndex} />
            </div>
          </aside>

          <ol className="flex flex-col gap-5 md:gap-6">
            {CAPABILITIES.map((cap, idx) => (
              <li key={cap.id} ref={setRef(idx)} data-cap-idx={idx} className="scroll-mt-24">
                <CapabilityCard cap={cap} active={idx === activeIndex} />
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}

function SectionHeader() {
  return (
    <div className="mb-10 max-w-[44rem] md:mb-14">
      <SectionLabel>the runtime</SectionLabel>
      <h2
        id="capabilities-heading"
        className="mt-3 font-hero-serif text-[clamp(1.9rem,4vw,3.2rem)] font-normal leading-[1.04] tracking-tight"
        style={{ color: INK.pearl }}
      >
        Five arms.{" "}
        <span style={{ color: "rgba(232,217,184,0.48)" }}>One memory.</span>
      </h2>
      <p
        className="mt-5 max-w-[36rem] text-[14px] font-light leading-relaxed md:text-[15px]"
        style={{ color: "rgba(232,217,184,0.68)" }}
      >
        Each arm catches a specific failure mode agents hit at runtime. Scroll — the octopus reaches for each one in turn.
      </p>
    </div>
  );
}

function ActiveLegend({ activeIndex }: { activeIndex: number }) {
  const cap = CAPABILITIES[activeIndex];
  if (!cap) return null;
  return (
    <div
      className="rounded-xl border px-5 py-5"
      style={{ borderColor: "rgba(232,217,184,0.1)", background: INK.inkDeep }}
    >
      <div className="flex items-center gap-3">
        <span className="font-mono text-[11px] tracking-[0.22em]" style={{ color: INK.ember }}>
          {cap.number}
        </span>
        <Chip tone={cap.tone} size="sm">
          {cap.name}
        </Chip>
      </div>
      <p
        className="mt-3 font-mono text-[11px] uppercase tracking-[0.18em]"
        style={{ color: INK.sand }}
      >
        now reaching
      </p>
      <p
        className="mt-1 text-[14px] font-medium tracking-tight"
        style={{ color: INK.pearl }}
      >
        {cap.title}
      </p>
      <p className="mt-2 text-[12.5px] font-light leading-relaxed" style={{ color: "rgba(232,217,184,0.68)" }}>
        {cap.line}
      </p>
    </div>
  );
}

function CapabilityCard({
  cap,
  active,
}: {
  cap: (typeof CAPABILITIES)[number];
  active: boolean;
}) {
  return (
    <article
      id={`cap-${cap.id}`}
      className="overflow-hidden rounded-xl border transition-[border-color,background-color] duration-300"
      style={{
        borderColor: active ? "rgba(255,122,92,0.4)" : "rgba(232,217,184,0.1)",
        background: INK.inkDeep,
      }}
    >
      <div className="flex flex-col">
        <header
          className="flex items-start justify-between gap-4 border-b px-6 py-5 md:px-7"
          style={{ borderColor: "rgba(232,217,184,0.08)" }}
        >
          <div className="flex min-w-0 flex-col gap-2.5">
            <CardEyebrow
              number={cap.number}
              chipLabel={cap.name}
              chipTone={cap.tone}
              status={active ? "reaching" : undefined}
              numberColor={active ? INK.ember : INK.sand}
            />
            <h3
              className="font-hero-serif text-[clamp(1.3rem,2vw,1.7rem)] font-normal leading-[1.08] tracking-tight"
              style={{ color: INK.pearl }}
            >
              {cap.title}
            </h3>
            <p
              className="max-w-[40ch] text-[13.5px] font-light leading-relaxed"
              style={{ color: "rgba(232,217,184,0.7)" }}
            >
              {cap.line}
            </p>
          </div>
        </header>
        {/*
          Static mockup body. The mockup brings its own padded shell, so
          we render it flush (no surrounding padding here) to preserve
          the inset-screen feel of the upstream MockupShell — same look
          as the CapabilityGrid cards, dropped into the scroll-driven
          octopus layout.
        */}
        <CapabilityCardBody cap={cap} />
      </div>
    </article>
  );
}

function CapabilityCardBody({ cap }: { cap: (typeof CAPABILITIES)[number] }) {
  const Mockup = CAP_MOCKUP_BY_ID[cap.id as CapabilityId];
  return <Mockup />;
}
