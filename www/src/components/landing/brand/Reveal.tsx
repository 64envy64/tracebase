"use client";

import type { CSSProperties, ReactNode } from "react";
import { useInView } from "./useInView";

/* ============================================================ */
/*  Reveal — applies the shared `ink-rise` animation once the    */
/*  element enters the viewport. Use around section headings     */
/*  and tile grids to animate them in along the page scroll.     */
/* ============================================================ */

export function Reveal({
  children,
  delayMs = 0,
  as: Tag = "div",
  className,
  style,
  threshold = 0.15,
}: {
  children: ReactNode;
  delayMs?: number;
  as?: "div" | "section" | "article" | "header";
  className?: string;
  style?: CSSProperties;
  threshold?: number;
}) {
  const [ref, inView] = useInView<HTMLDivElement>({
    threshold,
    rootMargin: "0px 0px -10% 0px",
  });

  const mergedStyle: CSSProperties = {
    opacity: inView ? 1 : 0,
    ["--ink-rise-delay" as string]: `${delayMs}ms`,
    ...style,
  };

  return (
    <Tag
      ref={ref as React.Ref<HTMLDivElement>}
      className={[inView ? "ink-rise" : undefined, className].filter(Boolean).join(" ")}
      style={mergedStyle}
    >
      {children}
    </Tag>
  );
}
