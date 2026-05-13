"use client";

import { useEffect, useState } from "react";
import { CopyCommand } from "@/components/CopyButton";
import { GetStartedButton } from "@/components/auth/GetStartedButton";
import { SWE_BENCH_SNAPSHOT } from "@/content/benchmarkStats";
import { InkDrop, InkUnderline } from "./brand/Marks";
import { INK } from "./brand/tokens";

/* ============================================================ */
/*  HeroMetricStrip — three numeric stat tiles taken straight    */
/*  from the published whitepaper snapshot. No marketing maths;  */
/*  numbers are pulled from benchmarkStats so the value stays    */
/*  in sync with the report card.                                */
/* ============================================================ */

type HeroMetric = { value: string; label: string; tone: "ember" | "bone" };

const HERO_METRICS: readonly HeroMetric[] = [
  { value: `+${SWE_BENCH_SNAPSHOT.accuracyGainPp} pp`, label: "accuracy", tone: "ember" },
  { value: `−${SWE_BENCH_SNAPSHOT.costReductionAvgPct}%`, label: "cost", tone: "bone" },
  { value: `−${SWE_BENCH_SNAPSHOT.stepReductionAvgPct}%`, label: "steps", tone: "bone" },
];

function HeroMetricStrip() {
  return (
    <div className="mx-auto mt-7 w-full max-w-[34rem]">
      <div
        className="grid grid-cols-3 overflow-hidden rounded-xl border"
        style={{
          borderColor: "rgba(232,217,184,0.12)",
          background: "rgba(6,10,13,0.55)",
          gap: 1,
          backgroundImage: "linear-gradient(rgba(232,217,184,0.08), rgba(232,217,184,0.08))",
        }}
      >
        {HERO_METRICS.map((m) => (
          <div
            key={m.label}
            className="flex flex-col items-center justify-center gap-1 px-3 py-3"
            style={{ background: INK.inkDeep }}
          >
            <span
              className="font-mono text-[10px] uppercase tracking-[0.22em]"
              style={{ color: INK.sand }}
            >
              {m.label}
            </span>
            <span
              className="font-mono text-[clamp(1.05rem,2vw,1.45rem)] font-semibold leading-none tracking-tight tabular-nums"
              style={{ color: m.tone === "ember" ? INK.ember : INK.bone }}
            >
              {m.value}
            </span>
          </div>
        ))}
      </div>
      <p
        className="mt-3 text-center font-mono text-[10px] uppercase tracking-[0.22em]"
        style={{ color: INK.sand }}
      >
        {SWE_BENCH_SNAPSHOT.benchmark} · {SWE_BENCH_SNAPSHOT.attempted} tasks · {SWE_BENCH_SNAPSHOT.model}
      </p>
    </div>
  );
}

/* ============================================================ */
/*  HeroInk — the opening moment.                                */
/*  No chips, no capability row. Just the headline, a brush      */
/*  stroke drawn under "ink", and a silhouette octopus whose     */
/*  arms draw themselves in once on mount.                       */
/* ============================================================ */

export function HeroInk() {
  // Trigger one-shot reveals after mount so the stroke-draw animations have
  // something to transition *to*. (Hero is above the fold — no observer.)
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setRevealed(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <section
      className="relative flex min-h-[100svh] flex-col justify-center overflow-hidden"
      style={{ background: INK.ink }}
      aria-label="Introduction"
    >
      <HeroBrandBackdrop revealed={revealed} />

      <div className="relative z-10 mx-auto flex w-full max-w-[1080px] flex-col items-center px-5 pb-24 pt-28 text-center sm:px-6 sm:pt-32 lg:pb-28 lg:pt-40">
        <div className="w-full max-w-[860px]">
          <h1
            className="ink-rise font-hero-serif text-[clamp(2.4rem,6vw,5rem)] font-normal leading-[1.02] tracking-tight"
            style={{ color: INK.pearl, ["--ink-rise-delay" as string]: "60ms" }}
          >
            Every run,
            <br className="sm:hidden" />
            <span className="hidden sm:inline"> </span>
            written in{" "}
            <span className="relative inline-block" style={{ color: INK.ember }}>
              ink
              <span
                aria-hidden
                className="pointer-events-none absolute left-0 right-0"
                style={{ bottom: "-0.18em" }}
              >
                <InkUnderline inView={revealed} delayMs={520} strokeWidth={4} />
              </span>
            </span>
            .
          </h1>

          <p
            className="ink-rise mx-auto mt-6 max-w-[32rem] text-[14px] font-light leading-relaxed sm:text-[15.5px]"
            style={{
              color: "rgba(232,217,184,0.74)",
              ["--ink-rise-delay" as string]: "220ms",
            }}
          >
            Memory layer for coding agents. Past solutions, file meaning, doom-loops — kept across runs. Drop-in MCP.
          </p>

          <div
            className="ink-rise"
            style={{ ["--ink-rise-delay" as string]: "320ms" }}
          >
            <HeroMetricStrip />
          </div>

          <div
            className="ink-rise mt-8 flex flex-wrap items-center justify-center gap-3"
            style={{ ["--ink-rise-delay" as string]: "440ms" }}
          >
            <GetStartedButton size="large" onMedia />
            <CopyCommand command="npx tracebase-ai init" onMedia />
          </div>
        </div>
      </div>
    </section>
  );
}

/* ============================================================ */
/*  HeroBrandBackdrop — grid, splatter, and an inked octopus     */
/*  whose tentacles draw themselves in once on mount.            */
/* ============================================================ */

function HeroBrandBackdrop({ revealed }: { revealed: boolean }) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {/* Faint dotted grid */}
      <svg width="100%" height="100%" className="absolute inset-0" style={{ opacity: 0.05 }}>
        <defs>
          <pattern id="hero-dots" x="0" y="0" width="28" height="28" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="0.8" fill={INK.bone} />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#hero-dots)" />
      </svg>

      <HeroSignatureOcto revealed={revealed} />

      {/* Top-left ink splatter (pure ink, no glow) */}
      <svg
        viewBox="0 0 200 200"
        className="absolute"
        style={{ left: "-30px", top: "8%", width: "200px", height: "200px", opacity: 0.14 }}
      >
        <circle cx="80" cy="86" r="42" fill={INK.bone} />
        <circle cx="128" cy="70" r="14" fill={INK.bone} />
        <circle cx="140" cy="110" r="8" fill={INK.bone} />
        <circle cx="56" cy="138" r="6" fill={INK.bone} />
        <circle cx="100" cy="50" r="4" fill={INK.bone} />
      </svg>

      {/* Small ember drop accent */}
      <InkDrop
        size={10}
        color={INK.ember}
        className="ink-pulse absolute"
        style={{ top: "18%", right: "12%", opacity: 0.7 }}
      />
    </div>
  );
}

/* ============================================================ */
/*  HeroSignatureOcto — bottom-right silhouette whose arms draw  */
/*  themselves in on mount. Mirrors the CtaOcto motion.          */
/* ============================================================ */

const HERO_TENTACLES = [
  { d: "M 300 260 C 220 290, 150 330, 80 420",  len: 260 },
  { d: "M 300 260 C 248 310, 210 370, 200 450", len: 230 },
  { d: "M 300 260 C 300 330, 292 400, 306 470", len: 220 },
  { d: "M 300 260 C 352 310, 390 370, 400 450", len: 230 },
  { d: "M 300 260 C 380 290, 450 330, 520 420", len: 260 },
] as const;

function HeroSignatureOcto({ revealed }: { revealed: boolean }) {
  return (
    <svg
      viewBox="0 0 600 600"
      className="absolute"
      style={{
        right: "-120px",
        bottom: "-160px",
        width: "min(720px, 70vw)",
        height: "auto",
        opacity: 0.18,
      }}
    >
      {HERO_TENTACLES.map((t, idx) => (
        <path
          key={idx}
          d={t.d}
          stroke={idx === 2 ? INK.ember : INK.bone}
          strokeOpacity={idx === 2 ? 0.55 : 0.9}
          strokeWidth={idx === 2 ? 3 : 2.6}
          strokeLinecap="round"
          fill="none"
          className="tentacle-reach-path"
          data-reach={revealed ? "on" : "off"}
          style={{
            ["--tentacle-reach-len" as string]: String(t.len),
            transitionDelay: `${220 + idx * 150}ms`,
            transitionDuration: "1.2s",
          }}
        />
      ))}
      <ellipse
        cx="300"
        cy="200"
        rx="110"
        ry="88"
        fill="none"
        stroke={INK.bone}
        strokeWidth="3"
        style={{
          opacity: revealed ? 1 : 0,
          transform: revealed ? "translateY(0)" : "translateY(-10px)",
          transformOrigin: "300px 200px",
          transition: "opacity 0.7s ease 80ms, transform 0.7s cubic-bezier(0.22, 1, 0.36, 1) 80ms",
        }}
      />
      <circle
        cx="300"
        cy="260"
        r="5"
        fill={INK.ember}
        opacity="0.55"
        style={{
          transform: revealed ? "scale(1)" : "scale(0)",
          transformOrigin: "300px 260px",
          transition: "transform 0.5s cubic-bezier(0.22, 1, 0.36, 1) 1100ms",
        }}
      />
    </svg>
  );
}
