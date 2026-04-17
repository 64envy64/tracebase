import type { ReactNode } from "react";

export function Panel({
  eyebrow,
  title,
  description,
  children,
  id,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section
      id={id}
      className="min-w-0 rounded-sm border p-4 sm:p-5"
      style={{
        borderColor: "var(--border)",
        background: "var(--surface)",
      }}
      aria-labelledby={id ? `${id}-title` : undefined}
    >
      <header className="mb-6 flex flex-col gap-3">
        <p
          className="text-[11px] font-mono uppercase tracking-[0.22em]"
          style={{ color: "var(--text-tertiary)" }}
        >
          {eyebrow}
        </p>
        <div className="max-w-2xl">
          <h2 id={id ? `${id}-title` : undefined} className="text-base font-normal tracking-tight">
            {title}
          </h2>
          <p
            className="mt-2 text-xs font-light leading-relaxed"
            style={{ color: "var(--text-secondary)" }}
          >
            {description}
          </p>
        </div>
      </header>
      {children}
    </section>
  );
}
