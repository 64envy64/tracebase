/**
 * Funnel stage-bar primitive. Adaptive widths = share of the widest
 * non-zero stage (usually `eligibleRuns`). DRY: takes the raw
 * UsageMetrics observed counts; the Impact view never recomputes.
 */
export interface FunnelStage {
  label: string;
  value: number;
  hint?: string;
}

export function Funnel({ stages }: { stages: readonly FunnelStage[] }) {
  const widest = stages.reduce((max, s) => Math.max(max, s.value), 0);
  return (
    <div className="flex flex-col gap-3">
      {stages.map((stage, i) => {
        const width = widest > 0 ? Math.max(4, (stage.value / widest) * 100) : 4;
        const prev = i > 0 ? stages[i - 1]?.value : undefined;
        const dropPct =
          prev && prev > 0 ? Math.round(100 - (stage.value / prev) * 100) : null;
        return (
          <div key={stage.label} className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-3 text-[12px]">
              <span style={{ color: "var(--text)" }} className="font-light">
                {stage.label}
              </span>
              <span className="tabular-nums" style={{ color: "var(--text-secondary)" }}>
                {stage.value.toLocaleString()}
                {dropPct !== null && dropPct > 0 ? (
                  <span className="ml-2 text-[11px]" style={{ color: "var(--text-tertiary)" }}>
                    −{dropPct}%
                  </span>
                ) : null}
              </span>
            </div>
            <div
              className="h-2 overflow-hidden rounded-sm"
              style={{ background: "rgba(255,255,255,0.04)" }}
            >
              <div
                className="h-full rounded-sm transition-[width]"
                style={{
                  width: `${width}%`,
                  background: "var(--accent)",
                  opacity: widest > 0 ? 0.85 : 0.3,
                }}
              />
            </div>
            {stage.hint ? (
              <p
                className="text-[11px] font-light leading-relaxed"
                style={{ color: "var(--text-tertiary)" }}
              >
                {stage.hint}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
