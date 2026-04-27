import type { CSSProperties } from "react";
import { INK } from "./tokens";

/* ============================================================ */
/*  Primitive marks                                              */
/* ============================================================ */

export function InkDrop({
  size = 14,
  color = INK.ember,
  className,
  style,
}: {
  size?: number;
  color?: string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      viewBox="0 0 20 24"
      width={size}
      height={size * 1.2}
      aria-hidden
      className={className}
      style={{ display: "inline-block", verticalAlign: "baseline", ...style }}
    >
      <path
        d="M 10 2 C 10 8, 18 12, 18 17 A 8 7 0 1 1 2 17 C 2 12, 10 8, 10 2 Z"
        fill={color}
      />
    </svg>
  );
}

/** Small octopus silhouette — used in nav, hero, inline lockups. */
export function MiniOcto({
  size = 40,
  stroke = INK.bone,
  accent = INK.ember,
  animated = false,
  className,
}: {
  size?: number;
  stroke?: string;
  accent?: string;
  animated?: boolean;
  className?: string;
}) {
  const sway = animated ? "tentacle-sway" : "";
  return (
    <svg
      viewBox="0 0 80 80"
      width={size}
      height={size}
      aria-hidden
      className={className}
      style={{ display: "block" }}
    >
      <g className={sway} style={{ ["--tentacle-delay" as string]: "0ms" }}>
        <path d="M 40 44 C 28 50, 18 56, 12 70" stroke={stroke} strokeWidth="2" fill="none" strokeLinecap="round" />
      </g>
      <g className={sway} style={{ ["--tentacle-delay" as string]: "400ms" }}>
        <path d="M 40 44 C 32 54, 28 64, 30 74" stroke={stroke} strokeWidth="2" fill="none" strokeLinecap="round" />
      </g>
      <g className={sway} style={{ ["--tentacle-delay" as string]: "800ms" }}>
        <path d="M 40 44 C 40 56, 38 68, 42 78" stroke={accent} strokeWidth="2.4" fill="none" strokeLinecap="round" />
      </g>
      <g className={sway} style={{ ["--tentacle-delay" as string]: "1200ms" }}>
        <path d="M 40 44 C 48 54, 52 64, 50 74" stroke={stroke} strokeWidth="2" fill="none" strokeLinecap="round" />
      </g>
      <g className={sway} style={{ ["--tentacle-delay" as string]: "1600ms" }}>
        <path d="M 40 44 C 52 50, 62 56, 68 70" stroke={stroke} strokeWidth="2" fill="none" strokeLinecap="round" />
      </g>
      <ellipse cx="40" cy="32" rx="18" ry="14" fill={INK.ink} stroke={stroke} strokeWidth="2" />
      <circle cx="34" cy="34" r="2" fill={stroke} />
      <circle cx="46" cy="34" r="2" fill={stroke} />
    </svg>
  );
}

/** tracebase[drop].ink wordmark. Responsive by font-size. */
export function TracebaseInkWordmark({
  size = 28,
  tone = "bone",
  emberTld = true,
  className,
}: {
  size?: number;
  tone?: "bone" | "ink";
  emberTld?: boolean;
  className?: string;
}) {
  const base = tone === "bone" ? INK.bone : INK.ink;
  const tld = emberTld ? INK.ember : base;
  return (
    <span
      className={className}
      style={{
        color: base,
        fontSize: size,
        fontWeight: 600,
        letterSpacing: `-${size / 48}px`,
        lineHeight: 1,
        display: "inline-flex",
        alignItems: "baseline",
        whiteSpace: "nowrap",
      }}
    >
      <span>tracebase</span>
      <span style={{ padding: `0 ${Math.max(2, size * 0.08)}px`, display: "inline-flex", alignItems: "center" }}>
        <InkDrop size={Math.max(6, size * 0.28)} color={tld} />
      </span>
      <span style={{ color: tld }}>ink</span>
    </span>
  );
}

/** Decorative hand-drawn divider. */
export function BrushDivider({
  color = INK.bone,
  accent = INK.ember,
  className,
  height = 20,
  opacity = 0.32,
}: {
  color?: string;
  accent?: string;
  className?: string;
  height?: number;
  opacity?: number;
}) {
  return (
    <svg
      viewBox="0 0 600 24"
      width="100%"
      height={height}
      preserveAspectRatio="none"
      aria-hidden
      className={className}
      style={{ display: "block" }}
    >
      <path
        d="M 4 14 Q 80 4, 160 14 Q 240 26, 320 12 Q 420 2, 500 14 Q 560 22, 596 12"
        stroke={color}
        strokeOpacity={opacity}
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
      />
      <circle cx="318" cy="12" r="3" fill={accent} />
    </svg>
  );
}

/* ============================================================ */
/*  InkUnderline — single brush-stroke line that draws once       */
/*  under a word on reveal. Used in the closing CTA.              */
/* ============================================================ */

export function InkUnderline({
  inView,
  color = INK.ember,
  delayMs = 400,
  strokeWidth = 3,
  className,
}: {
  inView: boolean;
  color?: string;
  delayMs?: number;
  strokeWidth?: number;
  className?: string;
}) {
  // Path length is measured empirically from the curve below. Update in both
  // places if the path geometry changes.
  const pathLen = 320;
  return (
    <svg
      viewBox="0 0 320 18"
      preserveAspectRatio="none"
      aria-hidden
      className={className}
      style={{ display: "block", width: "100%", height: 18 }}
    >
      <path
        d="M 4 12 Q 80 2, 160 11 Q 240 20, 316 8"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        fill="none"
        className="tentacle-reach-path"
        data-reach={inView ? "on" : "off"}
        style={{
          ["--tentacle-reach-len" as string]: String(pathLen),
          transitionDelay: `${delayMs}ms`,
        }}
      />
    </svg>
  );
}

/* ============================================================ */
/*  CtaOcto — oversized signature mark with one-shot reveal.     */
/*  Same character as MiniOcto, but each arm draws stroke-in on  */
/*  inView (staggered), then rests static. No infinite sway.     */
/* ============================================================ */

const CTA_OCTO_TENTACLES = [
  { d: "M 100 108 C 72 128, 40 150, 16 184",  len: 190 },
  { d: "M 100 108 C 86 138, 74 166, 80 200",  len: 170 },
  { d: "M 100 108 C 100 140, 96 178, 104 212", len: 180 },
  { d: "M 100 108 C 116 138, 128 166, 124 200", len: 170 },
  { d: "M 100 108 C 130 128, 164 150, 188 184", len: 190 },
] as const;

export function CtaOcto({
  inView,
  size = 240,
  className,
  style,
}: {
  inView: boolean;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      viewBox="0 0 200 220"
      width={size}
      height={size * 1.1}
      aria-hidden
      className={className}
      style={{ display: "block", ...style }}
    >
      {/* Tentacles — draw once on reveal, staggered */}
      {CTA_OCTO_TENTACLES.map((t, idx) => {
        const isAccent = idx === 2;
        return (
          <path
            key={idx}
            d={t.d}
            stroke={isAccent ? INK.ember : INK.bone}
            strokeOpacity={isAccent ? 0.95 : 0.82}
            strokeWidth={isAccent ? 3 : 2.4}
            strokeLinecap="round"
            fill="none"
            className="tentacle-reach-path"
            data-reach={inView ? "on" : "off"}
            style={{
              ["--tentacle-reach-len" as string]: String(t.len),
              transitionDelay: `${200 + idx * 140}ms`,
              transitionDuration: "1.1s",
            }}
          />
        );
      })}

      {/* Head — sits on top of tentacle roots */}
      <g
        style={{
          opacity: inView ? 1 : 0,
          transform: inView ? "translateY(0)" : "translateY(-8px)",
          transition: "opacity 0.55s ease 80ms, transform 0.55s cubic-bezier(0.22, 1, 0.36, 1) 80ms",
          transformOrigin: "100px 96px",
        }}
      >
        <ellipse cx="100" cy="96" rx="44" ry="34" fill={INK.ink} stroke={INK.bone} strokeWidth="2.4" />
        <path
          d="M 72 82 Q 100 70, 128 82"
          stroke={INK.bone}
          strokeOpacity="0.4"
          strokeWidth="2"
          fill="none"
          strokeLinecap="round"
        />
        <circle cx="88" cy="97" r="3.2" fill={INK.bone} />
        <circle cx="88" cy="97" r="1.2" fill={INK.ink} />
        <circle cx="112" cy="97" r="3.2" fill={INK.bone} />
        <circle cx="112" cy="97" r="1.2" fill={INK.ink} />
      </g>

      {/* Ember drop at the signature tip — blooms once after the arms draw */}
      <circle
        cx="104"
        cy="212"
        r="4"
        fill={INK.ember}
        style={{
          opacity: inView ? 1 : 0,
          transform: inView ? "scale(1)" : "scale(0.2)",
          transformOrigin: "104px 212px",
          transition: "opacity 0.45s ease 900ms, transform 0.55s cubic-bezier(0.22, 1, 0.36, 1) 900ms",
        }}
      />
    </svg>
  );
}

/** Cluster of ink dots — replaces gradient flourishes. */
export function InkSplatter({
  size = 56,
  color = INK.bone,
  opacity = 0.2,
  className,
  style,
}: {
  size?: number;
  color?: string;
  opacity?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      viewBox="0 0 80 80"
      width={size}
      height={size}
      aria-hidden
      className={className}
      style={{ display: "block", opacity, ...style }}
    >
      <circle cx="38" cy="40" r="18" fill={color} />
      <circle cx="60" cy="28" r="7" fill={color} />
      <circle cx="66" cy="50" r="4" fill={color} />
      <circle cx="26" cy="60" r="3.5" fill={color} />
      <circle cx="52" cy="62" r="2.5" fill={color} />
      <circle cx="18" cy="30" r="2" fill={color} />
    </svg>
  );
}

/**
 * Section-to-section interstitial: short brand statement centred between two
 * brush lines, a heartbeat ink drop in the middle, and ink-splatters flanking.
 * Replaces the plain BrushDivider between major sections.
 */
export function InkInterstitial({ label, className }: { label: string; className?: string }) {
  return (
    <div
      className={className}
      aria-hidden
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(40px, 1fr) auto minmax(40px, 1fr)",
        alignItems: "center",
        gap: 18,
        padding: "24px 0",
      }}
    >
      <div style={{ position: "relative", height: 18 }}>
        <InkSplatter
          size={30}
          opacity={0.18}
          style={{ position: "absolute", left: 0, top: "-6px" }}
        />
        <div
          style={{
            position: "absolute",
            top: 8,
            left: 40,
            right: 0,
            height: 1,
            background:
              "linear-gradient(to right, rgba(232,217,184,0) 0%, rgba(232,217,184,0.22) 60%, rgba(232,217,184,0.32) 100%)",
          }}
        />
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 10,
          letterSpacing: "0.28em",
          textTransform: "uppercase",
          color: INK.sand,
          whiteSpace: "nowrap",
        }}
      >
        <InkDrop size={8} className="ink-pulse" />
        <span>{label}</span>
        <InkDrop size={8} className="ink-pulse" style={{ animationDelay: "-1.2s" }} />
      </div>
      <div style={{ position: "relative", height: 18 }}>
        <div
          style={{
            position: "absolute",
            top: 8,
            left: 0,
            right: 40,
            height: 1,
            background:
              "linear-gradient(to left, rgba(232,217,184,0) 0%, rgba(232,217,184,0.22) 60%, rgba(232,217,184,0.32) 100%)",
          }}
        />
        <InkSplatter
          size={30}
          opacity={0.18}
          style={{ position: "absolute", right: 0, top: "-6px" }}
        />
      </div>
    </div>
  );
}

/* ============================================================ */
/*  PrimaryOcto — the official brand mark at hero-scale.         */
/*  Same character as MiniOcto (oval head, two eyes, soft brow), */
/*  but its five arms all emerge from a single chin-anchor and   */
/*  reach out to the right to five vertically-spaced targets     */
/*  that match the capability cards stacked beside it.           */
/* ============================================================ */

/** Single anchor every tentacle grows from — chin of the head. */
const PRIMARY_ANCHOR = { x: 200, y: 252 };
const PRIMARY_HEAD = { cx: 200, cy: 198, rx: 76, ry: 64 };

/**
 * Paths: each begins at the chin-anchor and curves out to the right at a
 * different vertical height. No ember dots — the arm itself is the signal.
 */
const PRIMARY_PATHS = [
  { d: "M 200 252 C 260 210, 320 140, 450 88",  len: 460, endX: 450, endY: 88  },
  { d: "M 200 252 C 270 230, 330 180, 470 168", len: 380, endX: 470, endY: 168 },
  { d: "M 200 252 C 280 252, 360 252, 480 252", len: 320, endX: 480, endY: 252 },
  { d: "M 200 252 C 270 274, 330 322, 470 336", len: 380, endX: 470, endY: 336 },
  { d: "M 200 252 C 260 292, 320 362, 450 416", len: 460, endX: 450, endY: 416 },
] as const;

export function PrimaryOcto({
  activeIndex = null,
  revealedUpTo = 0,
  labels,
}: {
  activeIndex?: number | null;
  revealedUpTo?: number;
  labels?: readonly string[];
}) {
  return (
    <svg
      viewBox="0 0 520 500"
      aria-hidden
      style={{ display: "block", width: "100%", height: "auto" }}
    >
      <defs>
        <pattern id="primary-dots" x="0" y="0" width="18" height="18" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="0.7" fill={INK.bone} />
        </pattern>
      </defs>
      <rect width="520" height="500" fill="url(#primary-dots)" opacity="0.05" />

      {/* Tentacles — drawn first so the head sits over their roots. */}
      {PRIMARY_PATHS.map((t, idx) => {
        const isActive = activeIndex === idx;
        const isReached = idx <= revealedUpTo;
        const color = isActive ? INK.ember : INK.bone;
        return (
          <g key={idx}>
            <path
              d={t.d}
              stroke={color}
              strokeOpacity={isActive ? 1 : isReached ? 0.78 : 0.18}
              strokeWidth={isActive ? 3.6 : 2.6}
              strokeLinecap="round"
              fill="none"
              className="tentacle-reach-path"
              data-reach={isReached ? "on" : "off"}
              style={{
                ["--tentacle-reach-len" as string]: String(t.len),
              }}
            />
            {[0.5, 0.78].map((p, i) => {
              const cx = PRIMARY_ANCHOR.x + (t.endX - PRIMARY_ANCHOR.x) * p;
              const cy = PRIMARY_ANCHOR.y + (t.endY - PRIMARY_ANCHOR.y) * p;
              return (
                <circle
                  key={i}
                  cx={cx}
                  cy={cy}
                  r={isActive ? 2 : 1.6}
                  fill={color}
                  opacity={isReached ? (isActive ? 0.85 : 0.55) : 0}
                  style={{ transition: "opacity 0.4s ease, r 0.3s ease" }}
                />
              );
            })}
            {labels ? (
              <text
                x={t.endX + 12}
                y={t.endY + 4}
                fontSize="10.5"
                fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                letterSpacing="1.8"
                fill={isActive ? INK.ember : isReached ? INK.sand : "rgba(232,217,184,0.22)"}
                style={{ transition: "fill 0.35s ease" }}
              >
                {labels[idx]}
              </text>
            ) : null}
          </g>
        );
      })}

      {/* Head — identical character to MiniOcto, just bigger. */}
      <g>
        <ellipse
          cx={PRIMARY_HEAD.cx}
          cy={PRIMARY_HEAD.cy}
          rx={PRIMARY_HEAD.rx}
          ry={PRIMARY_HEAD.ry}
          fill={INK.ink}
          stroke={INK.bone}
          strokeWidth="3"
        />
        {/* Brow */}
        <path
          d={`M ${PRIMARY_HEAD.cx - 46} ${PRIMARY_HEAD.cy - 24} Q ${PRIMARY_HEAD.cx} ${PRIMARY_HEAD.cy - 38}, ${PRIMARY_HEAD.cx + 46} ${PRIMARY_HEAD.cy - 24}`}
          stroke={INK.bone}
          strokeOpacity="0.4"
          strokeWidth="2"
          fill="none"
          strokeLinecap="round"
        />
        {/* Eyes — MiniOcto style: small dots with no sclera. */}
        <circle cx={PRIMARY_HEAD.cx - 20} cy={PRIMARY_HEAD.cy + 2} r="4.5" fill={INK.bone} />
        <circle cx={PRIMARY_HEAD.cx - 20} cy={PRIMARY_HEAD.cy + 2} r="1.6" fill={INK.ink} />
        <circle cx={PRIMARY_HEAD.cx + 20} cy={PRIMARY_HEAD.cy + 2} r="4.5" fill={INK.bone} />
        <circle cx={PRIMARY_HEAD.cx + 20} cy={PRIMARY_HEAD.cy + 2} r="1.6" fill={INK.ink} />
      </g>
    </svg>
  );
}
