"use client";

import { useCallback, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DashboardSeries } from "@/components/dashboard/dashboardData";
import { buildAreaPath, buildLinePath, buildPoints } from "@/components/dashboard/lib/chartMath";
import { SERIES_COLORS } from "@/components/dashboard/charts/chartPalette";

const WIDTH = 680;
const HEIGHT = 220;
const PAD = 22;
const Y_TICKS = 4;

export function InteractiveLineChart({
  labels,
  series,
}: {
  labels: readonly string[];
  series: readonly DashboardSeries[];
}) {
  const clipId = useId().replace(/:/g, "");
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<{
    index: number;
    left: number;
    top: number;
  } | null>(null);

  const values = series.flatMap((item) => item.values);
  const max = Math.max(...values);
  const min = Math.min(...values);

  const seriesPoints = useMemo(
    () =>
      series.map((entry) => ({
        entry,
        points: buildPoints(entry.values, WIDTH, HEIGHT, PAD, min, max),
      })),
    [series, min, max],
  );

  const pickIndex = useCallback(
    (svgX: number) => {
      const inner = WIDTH - PAD * 2;
      const t = (svgX - PAD) / Math.max(inner, 1);
      const clamped = Math.max(0, Math.min(1, t));
      const idx = Math.round(clamped * (labels.length - 1));
      return Math.max(0, Math.min(labels.length - 1, idx));
    },
    [labels.length],
  );

  const handlePointer = (e: React.PointerEvent<SVGSVGElement>) => {
    const el = svgRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const scaleX = WIDTH / rect.width;
    const svgX = (e.clientX - rect.left) * scaleX;
    const idx = pickIndex(svgX);
    const left = Math.min(
      Math.max(16, e.clientX - 130),
      typeof window !== "undefined" ? window.innerWidth - 280 : e.clientX,
    );
    const top = Math.min(e.clientY + 18, typeof window !== "undefined" ? window.innerHeight - 160 : e.clientY);
    setHover({ index: idx, left, top });
  };

  const handleLeave = () => setHover(null);

  const hx = hover ? (seriesPoints[0]?.points[hover.index]?.x ?? PAD) : null;

  const tooltip =
    hover && typeof document !== "undefined" ? (
      createPortal(
        <div
          className="pointer-events-none fixed z-[100] w-[min(260px,calc(100vw-32px))] rounded-sm border px-3 py-2 text-xs font-light shadow-lg"
          style={{
            borderColor: "var(--border)",
            background: "var(--bg)",
            color: "var(--text)",
            left: hover.left,
            top: hover.top,
          }}
          role="tooltip"
        >
          <p className="font-mono text-[10px] uppercase tracking-[0.16em]" style={{ color: "var(--text-tertiary)" }}>
            {labels[hover.index]}
          </p>
          <ul className="mt-2 space-y-1.5">
            {series.map((s) => (
              <li key={s.label} className="flex justify-between gap-4 tabular-nums">
                <span style={{ color: SERIES_COLORS[s.tone].label }}>{s.label}</span>
                <span>{s.values[hover.index]?.toFixed(1)}k</span>
              </li>
            ))}
          </ul>
        </div>,
        document.body,
      )
    ) : null;

  return (
    <div className="relative min-w-0 space-y-3">
      {tooltip}

      <div
        className="rounded-sm border"
        style={{
          borderColor: "var(--border)",
          background: "rgba(255,255,255,0.012)",
        }}
      >
        <svg
          ref={svgRef}
          aria-label="Efficiency trend — hover or drag to inspect"
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="h-[min(200px,38vh)] w-full cursor-crosshair touch-none select-none"
          role="img"
          onPointerMove={handlePointer}
          onPointerDown={handlePointer}
          onPointerLeave={handleLeave}
          onPointerCancel={handleLeave}
        >
          <defs>
            <clipPath id={clipId}>
              <rect x={PAD} y={PAD} width={WIDTH - PAD * 2} height={HEIGHT - PAD - 24} />
            </clipPath>
          </defs>

          {Array.from({ length: Y_TICKS + 1 }).map((_, index) => {
            const y = 20 + ((HEIGHT - 48) / Y_TICKS) * index;
            return (
              <line
                key={`grid-${y}`}
                x1={PAD}
                x2={WIDTH - PAD}
                y1={y}
                y2={y}
                stroke="rgba(237,236,236,0.06)"
                strokeDasharray="4 8"
              />
            );
          })}

          {labels.map((label, index) => {
            const x = PAD + (index * (WIDTH - PAD * 2)) / Math.max(labels.length - 1, 1);
            return (
              <text
                key={label}
                x={x}
                y={HEIGHT - 8}
                textAnchor={
                  index === 0 ? "start" : index === labels.length - 1 ? "end" : "middle"
                }
                fill="rgba(237,236,236,0.28)"
                fontSize="10"
                letterSpacing="0.14em"
                style={{ textTransform: "uppercase" }}
              >
                {label}
              </text>
            );
          })}

          <g clipPath={`url(#${clipId})`}>
            {seriesPoints.map(({ entry, points }) => {
              const colors = SERIES_COLORS[entry.tone];
              return (
                <g key={entry.label}>
                  <path d={buildAreaPath(points, HEIGHT, PAD)} fill={colors.fill} />
                  <path
                    d={buildLinePath(points)}
                    fill="none"
                    stroke={colors.line}
                    strokeWidth={entry.tone === "optimized" ? "2.5" : "2"}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </g>
              );
            })}

            {hover !== null &&
              seriesPoints.map(({ entry, points }) => {
                const colors = SERIES_COLORS[entry.tone];
                const pt = points[hover.index];
                if (!pt) return null;
                return (
                  <circle
                    key={`dot-${entry.label}`}
                    cx={pt.x}
                    cy={pt.y}
                    r={entry.tone === "optimized" ? 5 : 4}
                    fill={colors.line}
                    stroke="var(--bg)"
                    strokeWidth="2"
                  />
                );
              })}

            {hover !== null && hx !== null ? (
              <line
                x1={hx}
                x2={hx}
                y1={PAD}
                y2={HEIGHT - 28}
                stroke="rgba(237,236,236,0.2)"
                strokeWidth="1"
              />
            ) : null}
          </g>

          {Array.from({ length: Y_TICKS + 1 }).map((_, index) => {
            const value = max - ((max - min) / Y_TICKS) * index;
            const y = 24 + ((HEIGHT - 52) / Y_TICKS) * index;
            return (
              <text
                key={`axis-${value}`}
                x={WIDTH - PAD + 4}
                y={y - 2}
                textAnchor="end"
                fill="rgba(237,236,236,0.28)"
                fontSize="10"
                pointerEvents="none"
              >
                {Math.round(value)}k
              </text>
            );
          })}

          <rect
            x={0}
            y={0}
            width={WIDTH}
            height={HEIGHT}
            fill="transparent"
            style={{ cursor: "crosshair" }}
          />
        </svg>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        {series.map((entry) => {
          const colors = SERIES_COLORS[entry.tone];
          const first = entry.values[0];
          const last = entry.values[entry.values.length - 1];
          const change = ((last - first) / first) * 100;
          const hi = hover?.index ?? entry.values.length - 1;
          const at = entry.values[hi] ?? last;

          return (
            <div
              key={entry.label}
              className="rounded-sm border px-3 py-2.5"
              style={{ borderColor: "var(--border)" }}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full" style={{ background: colors.line }} />
                  <span className="text-xs font-light" style={{ color: colors.label }}>
                    {entry.label}
                  </span>
                </div>
                <span
                  className="text-[10px] font-mono uppercase tracking-[0.14em]"
                  style={{ color: "var(--text-tertiary)" }}
                >
                  {change <= 0 ? `${change.toFixed(0)}%` : `+${change.toFixed(0)}%`}
                </span>
              </div>
              <p className="mt-1.5 text-lg font-extralight tabular-nums">{at.toFixed(1)}k</p>
              <p className="mt-0.5 text-[10px] font-light" style={{ color: "var(--text-tertiary)" }}>
                Week {labels[hi] ?? "—"}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
