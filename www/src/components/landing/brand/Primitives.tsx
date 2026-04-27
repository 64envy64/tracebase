import type { CSSProperties, ReactNode } from "react";
import { CHIP_COLORS, type ChipTone, INK } from "./tokens";

/* ============================================================ */
/*  Chip — colored pill used in demos and capability headers     */
/* ============================================================ */

export function Chip({
  tone = "neutral",
  children,
  icon,
  uppercase = true,
  size = "md",
  className,
  style,
}: {
  tone?: ChipTone;
  children: ReactNode;
  icon?: ReactNode;
  uppercase?: boolean;
  size?: "sm" | "md";
  className?: string;
  style?: CSSProperties;
}) {
  const c = CHIP_COLORS[tone];
  const pad = size === "sm" ? "1px 6px" : "2px 8px";
  const fontSize = size === "sm" ? 9 : 10;
  return (
    <span
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: pad,
        borderRadius: 3,
        background: c.fill,
        color: c.text,
        border: `1px solid ${c.border}`,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize,
        letterSpacing: uppercase ? "0.14em" : "0.02em",
        textTransform: uppercase ? "uppercase" : "none",
        fontWeight: 600,
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {icon ? <span style={{ display: "inline-flex" }}>{icon}</span> : null}
      {children}
    </span>
  );
}

/* ============================================================ */
/*  CardEyebrow — the `05 FOLD · REACHING` lockup used across    */
/*  capability cards, the problem section, and the run-split     */
/*  header. Keeps number / chip / status visually identical.     */
/* ============================================================ */

export function CardEyebrow({
  number,
  chipLabel,
  chipTone,
  status,
  accent,
  numberColor,
  className,
}: {
  number?: string;
  chipLabel: string;
  chipTone: ChipTone;
  status?: string;
  /** Colour used for the `· status` tail. Defaults to ember. */
  accent?: string;
  /** Colour used for the leading number. Defaults to sand. */
  numberColor?: string;
  className?: string;
}) {
  const accentColor = accent ?? INK.ember;
  return (
    <div className={["flex items-center gap-3", className].filter(Boolean).join(" ")}>
      {number ? (
        <span
          className="font-mono text-[11px] tracking-[0.24em] transition-colors duration-300"
          style={{ color: numberColor ?? INK.sand }}
        >
          {number}
        </span>
      ) : null}
      <Chip tone={chipTone} size="sm">
        {chipLabel}
      </Chip>
      {status ? (
        <span
          className="font-mono text-[9px] uppercase tracking-[0.24em]"
          style={{ color: accentColor }}
        >
          · {status}
        </span>
      ) : null}
    </div>
  );
}

/* ============================================================ */
/*  Section eyebrow label — tiny mono uppercase                  */
/* ============================================================ */

export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p
      className={className}
      style={{
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 10,
        letterSpacing: "0.24em",
        textTransform: "uppercase",
        color: INK.sand,
      }}
    >
      {children}
    </p>
  );
}

/* ============================================================ */
/*  InkTile — flat bordered surface, replaces Card               */
/* ============================================================ */

export function InkTile({
  children,
  className,
  style,
  variant = "default",
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  variant?: "default" | "flush";
}) {
  return (
    <div
      className={className}
      style={{
        background: INK.inkDeep,
        border: "1px solid rgba(232,217,184,0.12)",
        borderRadius: 10,
        padding: variant === "flush" ? 0 : undefined,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/* ============================================================ */
/*  StepRow — a single row of an agent trace (shared by demos    */
/*  and RunSplit). Numbered, optional tool name, args, trailing  */
/*  capability chip.                                             */
/* ============================================================ */

export type StepRowProps = {
  n?: ReactNode;
  tool?: string;
  args?: ReactNode;
  note?: ReactNode;
  /** Free trailing slot: Chip, stack of Chips, plain counter ("×3"), etc. */
  trailing?: ReactNode;
  muted?: boolean;
  delayMs?: number;
  inView?: boolean;
};

export function StepRow({ n, tool, args, note, trailing, muted, delayMs = 0, inView = true }: StepRowProps) {
  const opacity = muted ? 0.58 : 1;
  return (
    <div
      className={inView ? "step-reveal" : undefined}
      style={{
        ["--step-delay" as string]: `${delayMs}ms`,
        opacity: inView ? opacity : 0,
        display: "grid",
        gridTemplateColumns: "28px minmax(0, 1fr) auto",
        alignItems: "baseline",
        gap: 10,
        padding: "7px 0",
        borderBottom: "1px solid rgba(232,217,184,0.06)",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 12.5,
        lineHeight: 1.45,
        color: INK.bone,
      }}
    >
      <span style={{ color: INK.sand, fontSize: 11 }}>{n}</span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "baseline" }}>
          {tool ? <span style={{ color: INK.pearl, fontWeight: 600 }}>{tool}</span> : null}
          {args ? <span style={{ color: "rgba(232,217,184,0.66)" }}>{args}</span> : null}
        </span>
        {note ? (
          <span
            style={{
              color: "rgba(232,217,184,0.48)",
              fontStyle: "italic",
              display: "block",
              marginTop: 3,
              fontSize: 11.5,
              lineHeight: 1.4,
            }}
          >
            {note}
          </span>
        ) : null}
      </span>
      <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
        {trailing}
      </span>
    </div>
  );
}

/* ============================================================ */
/*  ResultBox — the terminal-status callout ("Resolved",         */
/*  "Budget exhausted", "Loop detected" etc.)                    */
/* ============================================================ */

export type ResultTone = "success" | "danger" | "warning" | "info";

export function ResultBox({
  tone,
  title,
  children,
  trailing,
}: {
  tone: ResultTone;
  title: string;
  children?: ReactNode;
  trailing?: ReactNode;
}) {
  const palette = {
    success: { border: "rgba(255,122,92,0.42)", fill: "rgba(255,122,92,0.08)", text: INK.ember },
    danger: { border: "rgba(184,79,56,0.48)", fill: "rgba(184,79,56,0.10)", text: "#ef8a74" },
    warning: { border: "rgba(224,180,88,0.44)", fill: "rgba(224,180,88,0.08)", text: INK.amber },
    info: { border: "rgba(232,217,184,0.28)", fill: "rgba(232,217,184,0.05)", text: INK.sand },
  }[tone];
  return (
    <div
      style={{
        border: `1px solid ${palette.border}`,
        background: palette.fill,
        borderRadius: 8,
        padding: "12px 14px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: 999,
              background: palette.text,
              boxShadow: `0 0 0 3px ${palette.fill}`,
            }}
          />
          <span
            style={{
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: 11,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              fontWeight: 700,
              color: palette.text,
            }}
          >
            {title}
          </span>
        </div>
        {trailing ? <div>{trailing}</div> : null}
      </div>
      {children ? (
        <div
          style={{
            fontSize: 12.5,
            lineHeight: 1.5,
            color: "rgba(232,217,184,0.82)",
          }}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

/* ============================================================ */
/*  CostBar — stepped horizontal bar used in RunSplit bottom     */
/* ============================================================ */

export function CostBar({
  label,
  value,
  maxSegments,
  segments,
  tone,
  struck,
  inView = true,
  delayMs = 0,
}: {
  label: string;
  value: string;
  maxSegments: number;
  segments: number;
  tone: "danger" | "success";
  struck?: boolean;
  inView?: boolean;
  delayMs?: number;
}) {
  const color = tone === "danger" ? "#ef8a74" : INK.ember;
  const bg = tone === "danger" ? "rgba(184,79,56,0.16)" : "rgba(255,122,92,0.14)";
  const fillRatio = Math.max(0, Math.min(1, segments / maxSegments));
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "90px minmax(0, 1fr) auto",
        alignItems: "center",
        gap: 14,
      }}
    >
      <span
        style={{
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 11,
          color: INK.sand,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
        }}
      >
        {label}
      </span>
      <div
        style={{
          position: "relative",
          height: 14,
          borderRadius: 2,
          background: "rgba(232,217,184,0.05)",
          overflow: "hidden",
        }}
      >
        <div
          className={inView ? "ink-fill" : undefined}
          style={{
            ["--ink-fill-end" as string]: String(fillRatio),
            ["--ink-fill-delay" as string]: `${delayMs}ms`,
            position: "absolute",
            inset: 0,
            background: `repeating-linear-gradient(90deg, ${color} 0 ${(1 / maxSegments) * 100 - 1.5}%, ${bg} ${(1 / maxSegments) * 100 - 1.5}% ${(1 / maxSegments) * 100}%)`,
            transformOrigin: "left center",
            transform: inView ? undefined : "scaleX(0)",
          }}
        />
      </div>
      <span
        style={{
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 14,
          fontWeight: 600,
          color: struck ? "rgba(232,217,184,0.4)" : INK.bone,
          textDecoration: struck ? "line-through" : "none",
        }}
      >
        {value}
      </span>
    </div>
  );
}
