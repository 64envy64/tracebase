"use client";

import { useState, type KeyboardEvent, type PointerEvent } from "react";
import { useRouter } from "next/navigation";
import { SWE_BENCH_SNAPSHOT } from "@/content/benchmarkStats";
import { Reveal } from "./brand/Reveal";
import { INK } from "./brand/tokens";

/* ============================================================ */
/*  BenchmarkTease — the airy, single-sentence replacement for   */
/*  the full benchmark grid. The heading fades in on scroll      */
/*  (Reveal applies the shared .ink-rise animation). Hovering    */
/*  anywhere on the heading area floats a cursor-following       */
/*  "See how we did it" tooltip — same interaction shape as the  */
/*  HeroMetricStrip — and clicking deep-links to /whitepaper.    */
/*                                                                */
/*  Empty vertical room is intentional. The previous grid was    */
/*  dense by design; this section is meant to breathe.           */
/* ============================================================ */

export function BenchmarkTease() {
  const router = useRouter();
  const [hover, setHover] = useState({ visible: false, x: 0, y: 0 });

  const goToWhitepaper = () => {
    router.push("/whitepaper");
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setHover({
      visible: true,
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      goToWhitepaper();
    }
  };

  return (
    <section
      id="evidence"
      aria-labelledby="benchmark-tease-heading"
      className="scroll-mt-20 py-28 md:py-44"
    >
      <Reveal>
        <div
          className="group relative mx-auto max-w-[60rem] cursor-pointer text-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-8 focus-visible:outline-[var(--accent)]"
          onClick={goToWhitepaper}
          onPointerMove={onPointerMove}
          onPointerEnter={onPointerMove}
          onPointerLeave={() => setHover((prev) => ({ ...prev, visible: false }))}
          onKeyDown={onKeyDown}
          role="link"
          tabIndex={0}
          aria-label="See how TraceBase cut agent token bills nearly in half"
        >
          <h2
            id="benchmark-tease-heading"
            className="font-hero-serif text-[clamp(2.2rem,5.4vw,4.4rem)] font-normal leading-[1.05] tracking-tight transition-colors duration-300 group-hover:text-[color:var(--accent)]"
            style={{ color: INK.pearl }}
          >
            We cut your agents&rsquo; token bill nearly in half.
          </h2>

          <div
            className="pointer-events-none absolute z-20 hidden flex-col gap-0.5 rounded border px-3 py-2 shadow-[0_10px_30px_rgba(0,0,0,0.28)] transition-opacity duration-[220ms] ease-out sm:flex"
            style={{
              left: hover.x,
              top: hover.y,
              opacity: hover.visible ? 1 : 0,
              transform: `translate(-50%, calc(-100% - 14px)) translateY(${hover.visible ? "0" : "4px"})`,
              transitionProperty: "opacity, transform",
              color: INK.ink,
              background: INK.pearl,
              borderColor: "rgba(245,236,214,0.72)",
            }}
          >
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em]">
              See how we did it
            </span>
            <span
              className="font-mono text-[9px] uppercase tracking-[0.16em]"
              style={{ color: "rgba(10,16,20,0.62)" }}
            >
              {SWE_BENCH_SNAPSHOT.runName}
            </span>
          </div>
        </div>
      </Reveal>
    </section>
  );
}
