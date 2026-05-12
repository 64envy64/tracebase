import type { ReactNode } from "react";

/**
 * Page header — large workspace/page title on the left, action pills
 * row on the right, optional muted subtitle under the title. The same
 * primitive backs every section page (Overview, Quickstart, Impact,
 * Installations, API keys) so the dashboard reads as one product
 * rather than five.
 *
 * Layout intentionally collapses to a vertical stack at narrow widths;
 * the action row drops below the title rather than wrapping into a
 * messy two-line header on mobile.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
      <div className="min-w-0">
        <h1 className="text-[1.8rem] font-normal tracking-[-0.03em] leading-tight md:text-[2rem]">
          {title}
        </h1>
        {subtitle ? (
          <p
            className="mt-1.5 text-[12px] font-light"
            style={{ color: "var(--text-tertiary)" }}
          >
            {subtitle}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </header>
  );
}
