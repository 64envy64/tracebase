import type { ReactNode } from "react";
import Link from "next/link";

/**
 * Observed vs estimated tile primitive. Deliberately prefix-free on
 * observed values; estimated tiles carry a visible `≈` glyph + the
 * underlying formula in a tooltip so no number on the dashboard can
 * pretend to be a causal measurement.
 *
 * Pass `href` to make the whole tile a navigation target — the
 * keyboard outline and hover state come for free. Without `href`
 * the tile renders as a plain `<article>`.
 */
export function MetricTile({
  label,
  value,
  note,
  estimate,
  formula,
  sampleSize,
  tone = "neutral",
  href,
}: {
  label: string;
  value: string | number | null;
  note?: string;
  estimate?: boolean;
  formula?: string;
  sampleSize?: number;
  tone?: "neutral" | "positive" | "muted";
  /** Optional drill-in route — wraps the tile in a Next Link. */
  href?: string;
}) {
  const display =
    value === null
      ? "—"
      : typeof value === "number"
        ? value.toLocaleString()
        : value;
  const tooltip =
    estimate && formula
      ? `${formula}${typeof sampleSize === "number" ? ` · n=${sampleSize}` : ""}`
      : undefined;
  const valueColor =
    tone === "positive" ? "var(--accent)" : tone === "muted" ? "var(--text-tertiary)" : "var(--text)";

  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <p
          className="text-[10px] font-mono uppercase tracking-[0.22em]"
          style={{ color: "var(--text-tertiary)" }}
        >
          {label}
        </p>
        {estimate ? <EstimateBadge tooltip={tooltip} /> : null}
      </div>
      <div>
        <p
          className="text-[1.7rem] font-light tracking-[-0.03em]"
          style={{ color: valueColor }}
        >
          {estimate && value !== null ? (
            <span>
              <span aria-hidden className="mr-1" style={{ color: "var(--text-tertiary)" }}>
                ≈
              </span>
              {display}
            </span>
          ) : (
            display
          )}
        </p>
        {note ? (
          <p
            className="mt-2 text-[12px] font-light leading-relaxed"
            style={{ color: "var(--text-secondary)" }}
          >
            {note}
          </p>
        ) : null}
      </div>
    </>
  );

  const baseClasses =
    "flex min-h-[140px] flex-col justify-between rounded-lg border p-4 transition-[border-color,background-color]";
  const baseStyle = {
    borderColor: "var(--border)",
    background: "var(--surface)",
  };

  if (href) {
    return (
      <Link
        href={href}
        className={baseClasses + " group hover:border-[color:var(--text-tertiary)]"}
        style={baseStyle}
      >
        {body}
      </Link>
    );
  }
  return (
    <article className={baseClasses} style={baseStyle}>
      {body}
    </article>
  );
}

function EstimateBadge({ tooltip }: { tooltip?: string }) {
  return (
    <span
      className="rounded-md border px-2 py-[3px] font-mono text-[9px] uppercase tracking-[0.2em]"
      style={{ borderColor: "var(--border)", color: "var(--text-tertiary)" }}
      title={tooltip}
      aria-label={tooltip ? `estimate — ${tooltip}` : "estimate"}
    >
      estimate
    </span>
  );
}

export function MetricTileFooter({ children }: { children: ReactNode }) {
  return (
    <p
      className="text-[11px] font-light leading-relaxed"
      style={{ color: "var(--text-tertiary)" }}
    >
      {children}
    </p>
  );
}
