import type { CSSProperties } from "react";
import { INK } from "./tokens";

/* ============================================================ */
/*  InkPreloader — the brand-native loading state.               */
/*                                                                */
/*  Reuses the MiniOcto silhouette geometry (oval head + 5       */
/*  tentacles) and animates a single bone "ink" pulse travelling */
/*  down each tentacle in sequence — left → right, with the      */
/*  middle ember tentacle carrying the brightest stroke. One     */
/*  full cycle is ~1.2s; the animation is GPU-cheap (just        */
/*  stroke-dashoffset) and loops smoothly without a hard restart.*/
/*                                                                */
/*  Two surfaces in one component:                                */
/*    `mode="fullscreen"` — fills the viewport on ink (used by    */
/*       `app/loading.tsx` as the App-Router Suspense fallback). */
/*    `mode="inline"` — renders at a fixed size, useful in a     */
/*       button or in-page placeholder.                          */
/*                                                                */
/*  Accessibility: announces "loading" via role=status, hides    */
/*  decorative SVG with aria-hidden. Respects prefers-reduced-   */
/*  motion (sustained dashoffset 0 — visible silhouette, no      */
/*  movement).                                                    */
/* ============================================================ */

type InkPreloaderProps = {
  mode?: "fullscreen" | "inline";
  size?: number;
  label?: string;
  className?: string;
};

/** Tentacle paths reused from MiniOcto so the preloader and the nav mark
 *  share a single source of truth for geometry. */
const TENTACLES = [
  { d: "M 40 44 C 28 50, 18 56, 12 70", len: 70, accent: false },
  { d: "M 40 44 C 32 54, 28 64, 30 74", len: 62, accent: false },
  { d: "M 40 44 C 40 56, 38 68, 42 78", len: 60, accent: true },
  { d: "M 40 44 C 48 54, 52 64, 50 74", len: 62, accent: false },
  { d: "M 40 44 C 52 50, 62 56, 68 70", len: 70, accent: false },
] as const;

/** Cycle = total animation duration. Each tentacle takes 1/5 of the cycle
 *  to draw, the next starts after a small offset so the cue reads as a
 *  travelling wave rather than five independent strokes. */
const CYCLE_MS = 1200;
const STAGGER_MS = 110;

export function InkPreloader({
  mode = "fullscreen",
  size = 88,
  label = "Loading tracebase",
  className,
}: InkPreloaderProps) {
  const wrapStyle: CSSProperties =
    mode === "fullscreen"
      ? {
          position: "fixed",
          inset: 0,
          background: INK.ink,
          color: INK.bone,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 9999,
        }
      : {
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        };

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={label}
      className={className}
      style={wrapStyle}
    >
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: mode === "fullscreen" ? 18 : 8 }}>
        <InkPreloaderMark size={size} />
        {mode === "fullscreen" ? (
          <span
            style={{
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: 10,
              letterSpacing: "0.32em",
              textTransform: "uppercase",
              color: INK.sand,
            }}
          >
            tracebase
            <span style={{ margin: "0 6px", color: "rgba(232,217,184,0.32)" }}>·</span>
            <span style={{ color: INK.ember }}>ink</span>
          </span>
        ) : null}
        <span
          style={{
            position: "absolute",
            width: 1,
            height: 1,
            overflow: "hidden",
            clipPath: "inset(50%)",
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </span>
      </div>
    </div>
  );
}

/* ============================================================ */
/*  InkPreloaderMark — the SVG itself. Pure geometry + CSS;      */
/*  no JS timers, no client-only state.                          */
/* ============================================================ */

function InkPreloaderMark({ size }: { size: number }) {
  return (
    <svg
      viewBox="0 0 80 80"
      width={size}
      height={size}
      aria-hidden
      style={{ display: "block" }}
    >
      {/* Soft halo behind the head — pulses with the same cycle so the
          drawing feels alive without ever shifting layout. */}
      <circle
        cx="40"
        cy="32"
        r="22"
        fill={INK.ember}
        opacity="0.06"
        className="ink-preloader-halo"
      />

      {/* Tentacles: each path animates its own stroke-dashoffset along the
          one shared keyframes track, with a per-tentacle delay so the cue
          reads as a continuous wave. Middle tentacle uses ember; the rest
          use bone. */}
      {TENTACLES.map((t, idx) => (
        <path
          key={idx}
          d={t.d}
          stroke={t.accent ? INK.ember : INK.bone}
          strokeWidth={t.accent ? 2.6 : 2.2}
          fill="none"
          strokeLinecap="round"
          className="ink-preloader-arm"
          style={{
            ["--ink-preloader-len" as string]: String(t.len),
            ["--ink-preloader-delay" as string]: `${idx * STAGGER_MS}ms`,
            ["--ink-preloader-cycle" as string]: `${CYCLE_MS}ms`,
          }}
        />
      ))}

      {/* Head — static. The animation is in the arms only, so the eye
          contact never breaks. */}
      <ellipse
        cx="40"
        cy="32"
        rx="18"
        ry="14"
        fill={INK.ink}
        stroke={INK.bone}
        strokeWidth="2"
      />
      <circle cx="34" cy="34" r="2" fill={INK.bone} />
      <circle cx="46" cy="34" r="2" fill={INK.bone} />
    </svg>
  );
}
