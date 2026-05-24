"use client";

import { useEffect, useRef, useState } from "react";
import { INK } from "./tokens";

/* ============================================================ */
/*  InkIntro — brand curtain that plays on every full page load. */
/*                                                                */
/*  Drawing is driven by pure CSS @keyframes (.intro-* classes   */
/*  in globals.css) so the octopus starts inking-in as soon as   */
/*  the curtain paints. React only manages the lift trigger     */
/*  (translateY -100%) and the unmount.                          */
/*                                                                */
/*  No sessionStorage gating — the intro is the brand's "entry   */
/*  moment" and plays on every full page load so visitors always */
/*  see it. Client-side navigation inside the SPA does NOT       */
/*  remount the curtain because it lives on the root layout      */
/*  which stays stable across route changes.                     */
/*                                                                */
/*  Sequence (~3.6s):                                             */
/*    0–1300ms   draw       tentacles + head ink themselves in   */
/*    900–1480ms tagline    brand line + ember underline         */
/*    1480–2600ms hold      quiet beat                           */
/*    2600–3600ms lift      tentacles pull octopus up, curtain   */
/*                          translates off-screen                */
/*    3650ms     unmount                                          */
/*                                                                */
/*  prefers-reduced-motion: short-circuits to a 150ms fade-out   */
/*  so reduced-motion users still get the brand panel briefly    */
/*  without sustained motion.                                    */
/* ============================================================ */

/** Total visible duration of the intro before unmount, in ms. */
const HOLD_UNTIL_LIFT_MS = 2600;
const LIFT_DURATION_MS = 1000;
const UNMOUNT_MS = HOLD_UNTIL_LIFT_MS + LIFT_DURATION_MS + 50;

/** Tentacle geometry — shared with MiniOcto and the favicon so the brand
 *  silhouette is identical across nav, intro, preloader, and icon. */
const TENTACLES = [
  { d: "M 40 44 C 28 50, 18 56, 12 70", len: 70, accent: false, drawDelay: 0 },
  { d: "M 40 44 C 32 54, 28 64, 30 74", len: 62, accent: false, drawDelay: 100 },
  { d: "M 40 44 C 40 56, 38 68, 42 78", len: 60, accent: true, drawDelay: 200 },
  { d: "M 40 44 C 48 54, 52 64, 50 74", len: 62, accent: false, drawDelay: 300 },
  { d: "M 40 44 C 52 50, 62 56, 68 70", len: 70, accent: false, drawDelay: 400 },
] as const;

export function InkIntro() {
  const [lifted, setLifted] = useState(false);
  const [unmounted, setUnmounted] = useState(false);
  const restoredRef = useRef(false);

  useEffect(() => {
    let reduced = false;
    try {
      reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      reduced = false;
    }

    // Lock scroll so nothing peeks while the curtain plays.
    const prevOverflow = document.body.style.overflow;
    const prevHtmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    restoredRef.current = false;

    const restoreScroll = () => {
      if (restoredRef.current) return;
      restoredRef.current = true;
      document.body.style.overflow = prevOverflow;
      document.documentElement.style.overflow = prevHtmlOverflow;
    };

    // Reduced-motion: collapse to a 150ms fade-out so reduced-motion users
    // still get the brand panel briefly without sustained movement.
    const liftAt = reduced ? 150 : HOLD_UNTIL_LIFT_MS;
    const unmountAt = reduced ? 320 : UNMOUNT_MS;

    const t1 = window.setTimeout(() => setLifted(true), liftAt);
    const t2 = window.setTimeout(() => {
      restoreScroll();
      setUnmounted(true);
    }, unmountAt);

    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      restoreScroll();
    };
  }, []);

  if (unmounted) return null;

  return (
    <div
      className="tb-intro-root"
      aria-hidden
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10000,
        background: INK.ink,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        transform: lifted ? "translateY(-100%)" : "translateY(0)",
        transition: `transform ${LIFT_DURATION_MS}ms cubic-bezier(0.7, 0, 0.18, 1)`,
        pointerEvents: lifted ? "none" : "auto",
        willChange: "transform",
      }}
    >
      {/* Faint dotted texture — mirrors the hero backdrop. */}
      <svg
        width="100%"
        height="100%"
        aria-hidden
        style={{ position: "absolute", inset: 0, opacity: 0.05, pointerEvents: "none" }}
      >
        <defs>
          <pattern id="intro-dots" x="0" y="0" width="28" height="28" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="0.8" fill={INK.bone} />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#intro-dots)" />
      </svg>

      <div
        style={{
          position: "relative",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 22,
        }}
      >
        <IntroOcto lifting={lifted} />

        <div
          className="intro-tagline"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 10,
          }}
        >
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
          <span
            className="font-hero-serif"
            style={{
              color: INK.pearl,
              fontSize: "clamp(1.4rem, 3vw, 2rem)",
              fontWeight: 400,
              letterSpacing: "-0.01em",
              lineHeight: 1.1,
            }}
          >
            Agents that{" "}
            <span style={{ color: INK.ember, position: "relative", display: "inline-block" }}>
              learn
              <span
                aria-hidden
                className="intro-underline"
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  bottom: -6,
                  height: 3,
                  background: INK.ember,
                  borderRadius: 3,
                  transformOrigin: "left center",
                  opacity: 0.85,
                }}
              />
            </span>
            {" "}from every run.
          </span>
        </div>
      </div>

      {/* Thin progress underline at the bottom — fills left-to-right over   */}
      {/* the duration of the intro so the visitor sees a clear "loading"   */}
      {/* cue. Drawn in ember, ~1px tall, very subtle.                       */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: 2,
          background: "rgba(232,217,184,0.06)",
          overflow: "hidden",
        }}
      >
        <div
          className="intro-progress"
          style={{
            height: "100%",
            background: INK.ember,
            transformOrigin: "left center",
          }}
        />
      </div>
    </div>
  );
}

/* ============================================================ */
/*  IntroOcto — octopus mark. The drawing is 100% CSS-driven via */
/*  the `.intro-tentacle` / `.intro-head` / `.intro-eye` classes */
/*  in globals.css, so the silhouette starts assembling on the   */
/*  first paint without any JS lag.                              */
/* ============================================================ */

function IntroOcto({ lifting }: { lifting: boolean }) {
  return (
    <svg
      viewBox="0 0 80 100"
      width={132}
      height={165}
      aria-hidden
      style={{ display: "block" }}
    >
      <circle
        className="intro-halo"
        cx="40"
        cy="32"
        r="24"
        fill={INK.ember}
      />

      {TENTACLES.map((t, idx) => {
        // During lift: each tentacle reaches UPWARD and outward, as if it's
        // tugging the curtain off the page. Outer arms reach farther so the
        // silhouette reads as a stretched-up octopus, not a uniform scale.
        const outerness = Math.abs(idx - 2); // 0 (middle) → 2 (edges)
        const upPull = -10 - outerness * 4;
        const sideStretch = (idx - 2) * 3;
        return (
          <path
            key={idx}
            className="intro-tentacle"
            d={t.d}
            stroke={t.accent ? INK.ember : INK.bone}
            strokeWidth={t.accent ? 2.8 : 2.4}
            fill="none"
            strokeLinecap="round"
            style={{
              ["--intro-len" as string]: String(t.len),
              ["--intro-draw-delay" as string]: `${t.drawDelay}ms`,
              transform: lifting
                ? `translate(${sideStretch}px, ${upPull}px) scale(${1 + outerness * 0.05})`
                : "translate(0, 0) scale(1)",
              transformOrigin: "40px 44px",
              transition: `transform ${LIFT_DURATION_MS - 100}ms cubic-bezier(0.62, -0.05, 0.18, 1)`,
            }}
          />
        );
      })}

      {/* Head + eyes group — during lift, the head "follows" the tentacles
          upward with a slight rise. That's the visual of being pulled. */}
      <g
        style={{
          transform: lifting ? "translateY(-14px)" : "translateY(0)",
          transformOrigin: "40px 32px",
          transition: `transform ${LIFT_DURATION_MS - 100}ms cubic-bezier(0.62, -0.05, 0.18, 1)`,
        }}
      >
        <ellipse
          className="intro-head"
          cx="40"
          cy="32"
          rx="18"
          ry="14"
          fill={INK.ink}
          stroke={INK.bone}
          strokeWidth="2.4"
        />
        <circle className="intro-eye intro-eye-left" cx="34" cy="34" r="2.2" fill={INK.bone} />
        <circle className="intro-eye intro-eye-right" cx="46" cy="34" r="2.2" fill={INK.bone} />
      </g>
    </svg>
  );
}
