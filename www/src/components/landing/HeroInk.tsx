"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { GetStartedButton } from "@/components/auth/GetStartedButton";
import { SWE_BENCH_SNAPSHOT } from "@/content/benchmarkStats";
import { InkUnderline } from "./brand/Marks";
import { INK } from "./brand/tokens";
import { WaitlistForm } from "./WaitlistForm";

type HeroMetric = { value: string; label: string; tone: "ember" | "bone" };

const HERO_METRICS: readonly HeroMetric[] = [
  { value: `+${SWE_BENCH_SNAPSHOT.accuracyGainPp} pp`, label: "accuracy", tone: "ember" },
  { value: `-${SWE_BENCH_SNAPSHOT.costReductionAvgPct}%`, label: "cost", tone: "bone" },
  { value: `-${SWE_BENCH_SNAPSHOT.stepReductionAvgPct}%`, label: "steps", tone: "bone" },
];

function HeroMetricStrip() {
  const [captionVisible, setCaptionVisible] = useState(false);

  return (
    <div
      className="hero-metric-strip mx-auto mt-8 w-full max-w-[34rem]"
      onClick={() => setCaptionVisible(true)}
      onPointerEnter={() => setCaptionVisible(true)}
      onPointerLeave={(event) => {
        if (!event.currentTarget.contains(document.activeElement)) {
          setCaptionVisible(false);
        }
      }}
      onMouseEnter={() => setCaptionVisible(true)}
      onMouseLeave={(event) => {
        if (!event.currentTarget.contains(document.activeElement)) {
          setCaptionVisible(false);
        }
      }}
      onFocusCapture={() => setCaptionVisible(true)}
      onBlurCapture={(event) => {
        const nextFocus = event.relatedTarget;
        if (!(nextFocus instanceof Node) || !event.currentTarget.contains(nextFocus)) {
          setCaptionVisible(false);
        }
      }}
    >
      <div
        className="hero-metric-grid grid grid-cols-3 overflow-hidden rounded-xl border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--accent)]"
        tabIndex={0}
        aria-label={`${SWE_BENCH_SNAPSHOT.benchmark}: accuracy up ${SWE_BENCH_SNAPSHOT.accuracyGainPp} percentage points, cost down ${SWE_BENCH_SNAPSHOT.costReductionAvgPct} percent, steps down ${SWE_BENCH_SNAPSHOT.stepReductionAvgPct} percent`}
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
            className="flex min-h-[68px] flex-col items-center justify-center gap-1 px-3 py-3"
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
        className="hero-metric-caption pointer-events-none mt-3 text-center font-mono text-[10px] uppercase tracking-[0.22em]"
        style={{
          color: INK.sand,
          opacity: captionVisible ? 1 : 0,
          transform: `translateY(${captionVisible ? 0 : 4}px)`,
        }}
      >
        {SWE_BENCH_SNAPSHOT.benchmark} / {SWE_BENCH_SNAPSHOT.attempted} tasks / {SWE_BENCH_SNAPSHOT.model}
      </p>
    </div>
  );
}

export function HeroInk() {
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    setRevealed(true);
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
            className="ink-rise font-hero-serif text-[clamp(2.65rem,6.3vw,5.35rem)] font-normal leading-[1.01] tracking-tight"
            style={{ color: INK.pearl, ["--ink-rise-delay" as string]: "80ms" }}
          >
            Agents that{" "}
            <span className="relative inline-block" style={{ color: INK.ember }}>
              learn
              <span
                aria-hidden
                className="pointer-events-none absolute left-0 right-0"
                style={{ bottom: "-0.18em" }}
              >
                <InkUnderline inView={revealed} delayMs={520} strokeWidth={4} />
              </span>
            </span>{" "}
            <br />
            from every run.
          </h1>

          <p
            className="ink-rise mx-auto mt-6 max-w-[38rem] text-[14px] font-light leading-relaxed sm:text-[15.5px]"
            style={{
              color: "rgba(232,217,184,0.74)",
              ["--ink-rise-delay" as string]: "220ms",
            }}
          >
            TraceBase turns solved work into shared memory, so every team and every agent carries
            what worked into the next run.
          </p>

          <div className="ink-rise" style={{ ["--ink-rise-delay" as string]: "340ms" }}>
            <HeroMetricStrip />
          </div>

          <div
            className="ink-rise mt-8 flex flex-wrap items-center justify-center gap-3"
            style={{ ["--ink-rise-delay" as string]: "460ms" }}
          >
            <GetStartedButton size="large" onMedia />
            <WaitlistForm size="large" onMedia />
          </div>
        </div>
      </div>
    </section>
  );
}

function HeroBrandBackdrop({ revealed }: { revealed: boolean }) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <svg width="100%" height="100%" className="absolute inset-0" style={{ opacity: 0.05 }}>
        <defs>
          <pattern id="hero-dots" x="0" y="0" width="28" height="28" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="0.8" fill={INK.bone} />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#hero-dots)" />
      </svg>

      <HeroEmergingArms revealed={revealed} />
      <HeroMemoryArtifacts />
    </div>
  );
}

type HeroArm = {
  d: string;
  len: number;
  color: string;
  width: number;
  opacity: number;
  dotOpacity: number;
  delayMs: number;
  durationMs: number;
  driftX: string;
  driftY: string;
  dots: string;
};

const HERO_EMERGING_ARMS: readonly HeroArm[] = [
  {
    d: "M -90 710 C 120 585, 250 505, 410 450",
    len: 600,
    color: INK.bone,
    width: 2.2,
    opacity: 0.18,
    dotOpacity: 0.24,
    delayMs: 100,
    durationMs: 9400,
    driftX: "10px",
    driftY: "-8px",
    dots: "1 18",
  },
  {
    d: "M 1360 690 C 1110 610, 940 520, 780 450",
    len: 640,
    color: INK.bone,
    width: 2,
    opacity: 0.16,
    dotOpacity: 0.2,
    delayMs: 380,
    durationMs: 11800,
    driftX: "-14px",
    driftY: "10px",
    dots: "1 21",
  },
  {
    d: "M 1120 -90 C 1038 126, 990 248, 895 360",
    len: 560,
    color: INK.bone,
    width: 1.8,
    opacity: 0.15,
    dotOpacity: 0.21,
    delayMs: 740,
    durationMs: 10400,
    driftX: "-8px",
    driftY: "12px",
    dots: "1 17",
  },
  {
    d: "M 215 -100 C 240 100, 320 230, 470 324",
    len: 520,
    color: INK.bone,
    width: 1.7,
    opacity: 0.12,
    dotOpacity: 0.18,
    delayMs: 1060,
    durationMs: 12800,
    driftX: "9px",
    driftY: "11px",
    dots: "1 19",
  },
  {
    d: "M 635 840 C 625 690, 634 570, 646 475",
    len: 390,
    color: INK.ember,
    width: 2.2,
    opacity: 0.18,
    dotOpacity: 0.28,
    delayMs: 1280,
    durationMs: 8800,
    driftX: "5px",
    driftY: "-13px",
    dots: "1 16",
  },
  {
    d: "M 1350 250 C 1125 270, 990 325, 850 395",
    len: 560,
    color: INK.bone,
    width: 1.7,
    opacity: 0.13,
    dotOpacity: 0.18,
    delayMs: 1540,
    durationMs: 11200,
    driftX: "-12px",
    driftY: "-6px",
    dots: "1 22",
  },
  {
    d: "M -130 320 C 95 300, 260 340, 410 396",
    len: 560,
    color: INK.bone,
    width: 1.6,
    opacity: 0.13,
    dotOpacity: 0.18,
    delayMs: 1880,
    durationMs: 10800,
    driftX: "12px",
    driftY: "7px",
    dots: "1 20",
  },
];

function HeroEmergingArms({ revealed }: { revealed: boolean }) {
  return (
    <svg
      viewBox="0 0 1280 760"
      preserveAspectRatio="xMidYMid slice"
      className="absolute inset-0 h-full w-full"
      style={{
        opacity: 0.9,
        WebkitMaskImage:
          "radial-gradient(ellipse at 50% 47%, transparent 0%, transparent 28%, rgba(0,0,0,0.35) 49%, #000 78%)",
        maskImage:
          "radial-gradient(ellipse at 50% 47%, transparent 0%, transparent 28%, rgba(0,0,0,0.35) 49%, #000 78%)",
      }}
    >
      {HERO_EMERGING_ARMS.map((arm, idx) => {
        const driftStyle = {
          ["--hero-arm-x" as string]: arm.driftX,
          ["--hero-arm-y" as string]: arm.driftY,
          ["--hero-arm-duration" as string]: `${arm.durationMs}ms`,
          animationDelay: `${arm.delayMs}ms`,
        } as CSSProperties;

        return (
          <g key={idx}>
            <path
              d={arm.d}
              stroke={arm.color}
              strokeOpacity={arm.opacity}
              strokeWidth={arm.width}
              strokeLinecap="round"
              fill="none"
              vectorEffect="non-scaling-stroke"
              className="tentacle-reach-path hero-arm-drift"
              data-reach={revealed ? "on" : "off"}
              style={{
                ...driftStyle,
                ["--tentacle-reach-len" as string]: String(arm.len),
                transitionDelay: `${220 + arm.delayMs}ms`,
                transitionDuration: "1.35s",
              }}
            />
            <path
              d={arm.d}
              stroke={arm.color}
              strokeOpacity={revealed ? arm.dotOpacity : 0}
              strokeWidth={arm.width + 1.1}
              strokeLinecap="round"
              strokeDasharray={arm.dots}
              fill="none"
              vectorEffect="non-scaling-stroke"
              className="hero-arm-dot-path hero-arm-drift"
              style={{
                ...driftStyle,
                transition: `stroke-opacity 700ms ease ${520 + arm.delayMs}ms`,
              }}
            />
          </g>
        );
      })}
    </svg>
  );
}

type HeroArtifact = {
  label: string;
  widths: readonly string[];
  style: CSSProperties;
  delayMs: number;
  durationMs: number;
  pullX: string;
  pullY: string;
  endX: string;
  endY: string;
  accent?: "ember" | "bone";
};

const HERO_MEMORY_ARTIFACTS: readonly HeroArtifact[] = [
  {
    label: "memory",
    widths: ["72%", "48%", "62%"],
    style: { left: "7%", top: "28%", width: "138px" },
    delayMs: 900,
    durationMs: 11800,
    pullX: "48px",
    pullY: "-18px",
    endX: "78px",
    endY: "-42px",
  },
  {
    label: "prior fix",
    widths: ["64%", "82%", "40%"],
    style: { right: "8%", top: "26%", width: "152px" },
    delayMs: 2400,
    durationMs: 13200,
    pullX: "-54px",
    pullY: "24px",
    endX: "-90px",
    endY: "50px",
    accent: "ember",
  },
  {
    label: "fact",
    widths: ["54%", "76%", "58%"],
    style: { left: "15%", bottom: "17%", width: "146px" },
    delayMs: 4200,
    durationMs: 12400,
    pullX: "58px",
    pullY: "-30px",
    endX: "92px",
    endY: "-62px",
  },
  {
    label: "context",
    widths: ["68%", "44%", "80%"],
    style: { right: "16%", bottom: "20%", width: "140px" },
    delayMs: 5700,
    durationMs: 11000,
    pullX: "-44px",
    pullY: "-18px",
    endX: "-76px",
    endY: "-48px",
  },
];

function HeroMemoryArtifacts() {
  return (
    <div className="absolute inset-0 hidden sm:block">
      {HERO_MEMORY_ARTIFACTS.map((artifact) => (
        <HeroMemoryCard key={artifact.label} artifact={artifact} />
      ))}
    </div>
  );
}

function HeroMemoryCard({ artifact }: { artifact: HeroArtifact }) {
  return (
    <div
      className="hero-memory-artifact absolute rounded-lg border px-3 py-2"
      style={{
        ...artifact.style,
        borderColor:
          artifact.accent === "ember" ? "rgba(255,113,85,0.18)" : "rgba(232,217,184,0.12)",
        background: "rgba(5,9,12,0.42)",
        boxShadow: "0 18px 55px rgba(0,0,0,0.22)",
        backdropFilter: "blur(5px)",
        WebkitBackdropFilter: "blur(5px)",
        ["--hero-memory-delay" as string]: `${artifact.delayMs}ms`,
        ["--hero-memory-duration" as string]: `${artifact.durationMs}ms`,
        ["--pull-x" as string]: artifact.pullX,
        ["--pull-y" as string]: artifact.pullY,
        ["--pull-end-x" as string]: artifact.endX,
        ["--pull-end-y" as string]: artifact.endY,
      }}
    >
      <div
        className="mb-2 font-mono text-[8px] uppercase tracking-[0.22em]"
        style={{ color: artifact.accent === "ember" ? "rgba(255,113,85,0.58)" : "rgba(232,217,184,0.46)" }}
      >
        {artifact.label}
      </div>
      <div className="space-y-1.5">
        {artifact.widths.map((width, idx) => (
          <span
            key={`${artifact.label}-${idx}`}
            className="hero-memory-line block h-[3px] rounded-full"
            style={{
              width,
              background:
                idx === 0 && artifact.accent === "ember"
                  ? "rgba(255,113,85,0.2)"
                  : "rgba(232,217,184,0.18)",
              animationDelay: `${artifact.delayMs + idx * 240}ms`,
            }}
          />
        ))}
      </div>
    </div>
  );
}
