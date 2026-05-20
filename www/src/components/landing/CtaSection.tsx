"use client";

import { GetStartedButton } from "@/components/auth/GetStartedButton";
import { CtaOcto, InkSplatter, InkUnderline } from "./brand/Marks";
import { SectionLabel } from "./brand/Primitives";
import { INK } from "./brand/tokens";
import { useInView } from "./brand/useInView";
import { WaitlistForm } from "./WaitlistForm";

/* ============================================================ */
/*  CtaSection — full-bleed closing moment.                      */
/*  No card wrap. One-shot ink reveal when the section enters    */
/*  view: the octopus draws its arms, then an ember brush-stroke */
/*  underlines the final clause of the headline.                 */
/* ============================================================ */

export function CtaSection() {
  const [ref, inView] = useInView<HTMLDivElement>({ threshold: 0.25 });

  return (
    <section
      ref={ref}
      id="cta"
      aria-labelledby="cta-heading"
      className="relative scroll-mt-20 py-20 md:py-28"
      style={{ color: INK.bone }}
    >
      {/* Ambient ink punctuation — no card, just flourishes drifting in space */}
      <InkSplatter
        size={140}
        opacity={0.04}
        className="pointer-events-none absolute hidden md:block"
        style={{ left: "-3rem", top: "1rem" }}
      />
      <InkSplatter
        size={90}
        opacity={0.04}
        className="pointer-events-none absolute"
        style={{ right: "-1.5rem", bottom: "-1rem" }}
      />

      <div className="relative grid gap-12 md:grid-cols-[minmax(0,1fr)_minmax(220px,320px)] md:items-center md:gap-16">
        <div className="flex min-w-0 flex-col gap-5 md:gap-6">
          <SectionLabel>pick up the pen</SectionLabel>

          <h2
            id="cta-heading"
            className="font-hero-serif text-[clamp(2rem,4.5vw,3.75rem)] font-normal leading-[1.02] tracking-tight"
            style={{ color: INK.pearl }}
          >
            Stop paying for the same{" "}
            <span className="relative inline-block">
              <span>reasoning twice.</span>
              <span
                aria-hidden
                className="absolute left-0 right-0"
                style={{ bottom: "-0.35em" }}
              >
                <InkUnderline inView={inView} />
              </span>
            </span>
          </h2>

          <p
            className="max-w-[36rem] text-[14px] font-light leading-relaxed md:text-[15px]"
            style={{ color: "rgba(232,217,184,0.72)" }}
          >
            One memory layer for every team and every agent. Self-serve install for individuals; custom runtime for production traffic. Open source today — MIT, self-hosted, ships out of the box.
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <GetStartedButton size="large" />
            <WaitlistForm size="large" />
          </div>

          <p
            className="mt-1 font-mono text-[10.5px] uppercase tracking-[0.22em]"
            style={{ color: INK.sand }}
          >
            v0.8 · may 2026 · no cloud required
          </p>
        </div>

        <div className="flex items-center justify-center md:justify-end">
          <div
            className="relative"
            style={{
              opacity: inView ? 1 : 0.25,
              transition: "opacity 0.6s cubic-bezier(0.22, 1, 0.36, 1) 80ms",
            }}
          >
            <CtaOcto inView={inView} size={260} />
          </div>
        </div>
      </div>
    </section>
  );
}
