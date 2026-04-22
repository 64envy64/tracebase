import {
  buildAreaPath,
  buildLinePath,
  buildPoints,
} from "@/components/dashboard/lib/chartMath";

/**
 * Adaptive SVG timeseries — consumes the UsageMetrics shape shared
 * with the CLI. Each series is a named sequence of values aligned
 * 1:1 with the labels array (daily buckets).
 */
export interface TimeseriesPoint {
  /** ISO date string — e.g. "2026-04-22". */
  label: string;
}

export interface TimeseriesSeries {
  name: string;
  values: readonly number[];
  color: string;
}

export function Timeseries({
  labels,
  series,
  height = 160,
}: {
  labels: readonly string[];
  series: readonly TimeseriesSeries[];
  height?: number;
}) {
  const width = 640;
  const pad = 14;

  const allValues = series.flatMap((s) => s.values);
  const yMax = allValues.length > 0 ? Math.max(1, Math.max(...allValues)) : 1;
  const yMin = 0;

  return (
    <div className="space-y-3">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="daily timeseries"
        className="block h-[180px] w-full"
      >
        {/* baseline */}
        <line
          x1={pad}
          y1={height - pad}
          x2={width - pad}
          y2={height - pad}
          stroke="var(--border)"
          strokeWidth={1}
        />
        {series.map((s, idx) => {
          const points = buildPoints(s.values, width, height, pad, yMin, yMax);
          return (
            <g key={s.name}>
              <path
                d={buildAreaPath(points, height, pad)}
                fill={s.color}
                opacity={0.12 + 0.04 * idx}
              />
              <path
                d={buildLinePath(points)}
                fill="none"
                stroke={s.color}
                strokeWidth={1.75}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </g>
          );
        })}
      </svg>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {series.map((s) => (
          <div key={s.name} className="flex items-center gap-2 text-[11px]">
            <span
              aria-hidden
              className="inline-block h-[2px] w-3"
              style={{ background: s.color }}
            />
            <span style={{ color: "var(--text-secondary)" }} className="font-light">
              {s.name}
            </span>
          </div>
        ))}
        <span className="ml-auto text-[11px] font-mono" style={{ color: "var(--text-tertiary)" }}>
          {labels[0] ?? "—"} → {labels[labels.length - 1] ?? "—"}
        </span>
      </div>
    </div>
  );
}
