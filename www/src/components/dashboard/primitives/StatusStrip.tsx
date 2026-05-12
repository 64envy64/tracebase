import type { ReactNode } from "react";

/**
 * Status strip — the dark-pill row of small counters + a navigational
 * arrow, sized to sit immediately under a page title. Used to give
 * a tight summary of the page's headline numbers + an Open-elsewhere
 * shortcut, without taking up a whole metric tile row.
 *
 *   [+12 helpful] [−2 misses] · 30 runs › Open impact view
 *
 * The signed counters take green/red tone automatically; everything
 * else is plain text, deliberately. The point is to read the
 * headline counts at a glance, not to be the metric surface itself.
 */
export interface StatusCounter {
  /** Numeric value to display. */
  value: number;
  /** Label after the value. */
  label: string;
  /** "positive" = green accent, "negative" = soft red, "neutral" = default. */
  tone?: "positive" | "negative" | "neutral";
  /** When true, prefixes the value with + (positive) or − (negative). */
  signed?: boolean;
}

export function StatusStrip({
  counters,
  note,
  actionRight,
}: {
  counters: readonly StatusCounter[];
  note?: ReactNode;
  actionRight?: ReactNode;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3 py-2 text-[12px]"
      style={{ borderColor: "var(--border)", background: "var(--surface)" }}
    >
      {counters.map((c, i) => (
        <span
          key={i}
          className="font-mono tabular-nums"
          style={{ color: toneColor(c.tone, c.value) }}
        >
          {c.signed ? signedPrefix(c.value, c.tone) : ""}
          {Math.abs(c.value)}
          {" "}
          <span className="font-sans font-light" style={{ color: toneLabelColor(c.tone) }}>
            {c.label}
          </span>
        </span>
      ))}
      {note ? (
        <>
          <span style={{ color: "var(--text-tertiary)" }} aria-hidden>
            ·
          </span>
          <span style={{ color: "var(--text-secondary)" }}>{note}</span>
        </>
      ) : null}
      {actionRight ? (
        <>
          <span
            className="ml-auto"
            style={{ color: "var(--text-tertiary)" }}
            aria-hidden
          >
            ›
          </span>
          {actionRight}
        </>
      ) : null}
    </div>
  );
}

function toneColor(tone: StatusCounter["tone"], value: number): string {
  if (tone === "positive") return "var(--accent)";
  if (tone === "negative") return "#f4a8a8";
  if (value > 0) return "var(--text)";
  return "var(--text-tertiary)";
}

function toneLabelColor(tone: StatusCounter["tone"]): string {
  if (tone === "positive") return "var(--accent)";
  if (tone === "negative") return "#f4a8a8";
  return "var(--text-secondary)";
}

function signedPrefix(value: number, tone: StatusCounter["tone"]): string {
  if (tone === "negative") return "−";
  if (tone === "positive") return value === 0 ? "+" : "+";
  if (value < 0) return "−";
  return "+";
}
