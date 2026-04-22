import type { ReactNode } from "react";

/**
 * Observed vs estimated tile primitive. Deliberately prefix-free on
 * observed values; estimated tiles carry a visible `≈` glyph + the
 * underlying formula in a tooltip so no number on the dashboard can
 * pretend to be a causal measurement.
 */
export function MetricTile({
  label,
  value,
  note,
  estimate,
  formula,
  sampleSize,
  tone = "neutral",
}: {
  label: string;
  value: string | number | null;
  note?: string;
  estimate?: boolean;
  formula?: string;
  sampleSize?: number;
  tone?: "neutral" | "positive" | "muted";
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
  return (
    <article
      className="flex min-h-[140px] flex-col justify-between rounded-sm border p-4"
      style={{ borderColor: "var(--border)", background: "var(--surface)" }}
    >
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
    </article>
  );
}

function EstimateBadge({ tooltip }: { tooltip?: string }) {
  return (
    <span
      className="rounded-sm border px-2 py-[3px] font-mono text-[9px] uppercase tracking-[0.2em]"
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
