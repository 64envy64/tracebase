"use client";

import { useEffect, useMemo, useState } from "react";
import { GitHubMark } from "@/components/ui/GitHubMark";

const REPO_URL = "https://github.com/64envy64/tracebase";
const FALLBACK_STARS = 48;

type GitHubStarButtonProps = {
  className?: string;
  compact?: boolean;
  fullWidth?: boolean;
};

type StarsResponse = {
  stars?: unknown;
};

function StarGlyph({ className = "h-3 w-3" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden className={`${className} shrink-0`}>
      <path d="M8 1.1 9.9 5l4.3.62-3.1 3.03.73 4.28L8 10.9l-3.84 2.03.74-4.28L1.8 5.62 6.1 5 8 1.1Z" />
    </svg>
  );
}

function formatStars(stars: number) {
  if (stars >= 10000) return `${Math.round(stars / 1000)}k`;
  if (stars >= 1000) return `${(stars / 1000).toFixed(1)}k`;
  return new Intl.NumberFormat("en-US").format(stars);
}

export function GitHubStarButton({ className = "", compact = false, fullWidth = false }: GitHubStarButtonProps) {
  const [stars, setStars] = useState(FALLBACK_STARS);

  useEffect(() => {
    let active = true;

    fetch("/api/github-stars", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: StarsResponse | null) => {
        if (!active || typeof data?.stars !== "number" || !Number.isFinite(data.stars)) return;
        setStars(data.stars);
      })
      .catch(() => {
        // The fallback keeps the CTA stable if GitHub rate-limits or the edge is offline.
      });

    return () => {
      active = false;
    };
  }, []);

  const label = useMemo(() => formatStars(stars), [stars]);
  const labelClass = compact ? "sr-only" : "inline";

  return (
    <a
      href={REPO_URL}
      className={[
        "group inline-flex h-10 items-center justify-center gap-2 rounded-full border border-white/10 bg-white/[0.035] px-3 text-[12px] font-medium tracking-tight text-[var(--text-secondary)] shadow-[inset_0_1px_0_rgba(255,255,255,0.045)] transition-colors hover:border-[rgba(232,217,184,0.24)] hover:bg-white/[0.06] hover:text-[var(--text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]",
        fullWidth ? "w-full" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Star TraceBase on GitHub, ${label} stars`}
    >
      <GitHubMark className="h-[17px] w-[17px] text-[rgba(232,217,184,0.76)] transition-colors group-hover:text-[var(--bone)]" />
      <span className={labelClass}>Star us on GitHub</span>
      <span
        className="inline-flex h-6 items-center gap-1 rounded-full border border-[rgba(232,217,184,0.12)] bg-[rgba(232,217,184,0.055)] px-2 font-mono text-[11px] leading-none text-[var(--bone)]"
        aria-label={`${label} GitHub stars`}
      >
        <StarGlyph />
        {label}
      </span>
    </a>
  );
}
