import type { ReactNode } from "react";

/**
 * The dashboard's single card primitive — three-band structure:
 *
 *   ┌─────────────────────────────────────────────┐
 *   │ header  (icon · actor · meta)   [actions]   │   <- HeaderRow
 *   ├─────────────────────────────────────────────┤
 *   │ body (inset, slightly darker background)    │   <- Body
 *   │                                             │
 *   ├─────────────────────────────────────────────┤
 *   │ footer (muted explanatory note)             │   <- Footer (optional)
 *   └─────────────────────────────────────────────┘
 *
 * Used by Overview activity cards, Quickstart agent cards, API-keys
 * issue rows, and any other section that wants the same rhythm.
 * Keeping it tightly typed (three named slots, no children prop on
 * the root) is what stops the look drifting per-view.
 */
export function SectionCard({
  header,
  body,
  footer,
  inset = true,
  className = "",
}: {
  header?: ReactNode;
  body?: ReactNode;
  footer?: ReactNode;
  /**
   * When true (default), the body sits on a slightly darker inset
   * background — the Creed-style code-block treatment. Set false
   * for plain cards (e.g. a single-paragraph empty state).
   */
  inset?: boolean;
  className?: string;
}) {
  return (
    <article
      className={"overflow-hidden rounded-lg border " + className}
      style={{ borderColor: "var(--border)", background: "var(--surface)" }}
    >
      {header ? (
        <header
          className="flex items-center justify-between gap-3 border-b px-4 py-3"
          style={{ borderColor: "var(--border)" }}
        >
          {header}
        </header>
      ) : null}
      {body ? (
        <div
          className="px-4 py-4"
          style={inset ? { background: "rgba(255,255,255,0.015)" } : undefined}
        >
          {body}
        </div>
      ) : null}
      {footer ? (
        <footer
          className="border-t px-4 py-3 text-[12px] font-light leading-relaxed"
          style={{ borderColor: "var(--border)", color: "var(--text-secondary)" }}
        >
          {footer}
        </footer>
      ) : null}
    </article>
  );
}

/**
 * CardHeaderRow — the canonical left-side (avatar/icon + actor +
 * meta-text) plus right-side (action buttons) layout used inside
 * `SectionCard`'s header slot. Kept separate so views with custom
 * header content can opt out.
 */
export function CardHeaderRow({
  icon,
  actor,
  meta,
  actions,
}: {
  icon?: ReactNode;
  actor: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <>
      <div className="flex min-w-0 items-center gap-2.5">
        {icon ? (
          <span
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full"
            style={{ background: "rgba(255,255,255,0.04)", color: "var(--text)" }}
            aria-hidden
          >
            {icon}
          </span>
        ) : null}
        <p className="min-w-0 truncate text-[13px] font-normal tracking-tight">
          {actor}
          {meta ? (
            <span
              className="ml-2 font-light"
              style={{ color: "var(--text-tertiary)" }}
            >
              {meta}
            </span>
          ) : null}
        </p>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
    </>
  );
}
