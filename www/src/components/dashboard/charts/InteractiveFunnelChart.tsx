"use client";

import type { AttributionStage } from "@/components/dashboard/dashboardData";

export function InteractiveFunnelChart({
  rows,
  selectedIndex,
  onSelect,
}: {
  rows: readonly AttributionStage[];
  selectedIndex: number | null;
  onSelect: (index: number | null) => void;
}) {
  return (
    <div className="space-y-3">
      {rows.map((row, index) => {
        const active = selectedIndex === index;
        return (
          <button
            key={row.label}
            type="button"
            onClick={() => onSelect(active ? null : index)}
            className="w-full space-y-2 rounded-sm border border-transparent px-1 py-1.5 text-left transition-[background-color,border-color] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--accent)]"
            style={{
              borderColor: active ? "rgba(237,236,236,0.1)" : "transparent",
              background: active ? "var(--surface)" : "transparent",
            }}
            aria-pressed={active}
          >
            <div className="flex items-baseline justify-between gap-3 px-1">
              <div>
                <p className="text-sm font-light">{row.label}</p>
                <p
                  className="text-xs font-light leading-relaxed"
                  style={{ color: "var(--text-secondary)" }}
                >
                  {row.note}
                </p>
              </div>
              <span className="shrink-0 text-sm font-light tabular-nums">{row.value}</span>
            </div>
            <div
              className="h-2 overflow-hidden rounded-full"
              style={{ background: "rgba(255,255,255,0.06)" }}
            >
              <div
                className="h-full rounded-full transition-[width,opacity] duration-300"
                style={{
                  width: `${row.width}%`,
                  background: active ? "var(--signal)" : "var(--accent)",
                  opacity: active ? 1 : 0.85,
                }}
              />
            </div>
          </button>
        );
      })}
    </div>
  );
}
