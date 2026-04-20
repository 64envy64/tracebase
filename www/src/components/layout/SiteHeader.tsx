import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";

export type SiteNavItem = {
  href: string;
  label: string;
  current?: boolean;
  external?: boolean;
};

export function SiteHeader({
  navItems,
  end,
}: {
  navItems: readonly SiteNavItem[];
  end?: ReactNode;
}) {
  return (
    <header
      className="fixed top-0 z-50 w-full border-b"
      style={{ borderColor: "var(--border)", background: "var(--bg)" }}
    >
      <div className="mx-auto flex h-12 max-w-[1080px] items-center justify-between gap-6 px-6">
        <Link href="/" className="flex shrink-0 items-center gap-2">
          <Image src="/logo.svg" alt="TraceBase" width={20} height={20} className="h-5 w-5" />
          <span className="text-base font-semibold tracking-tight" style={{ color: "var(--text)" }}>
            TraceBase
          </span>
        </Link>

        <div className="flex min-w-0 flex-1 items-center justify-end gap-6 sm:gap-8">
          <nav className="flex flex-wrap items-center justify-end gap-x-6 gap-y-2 sm:gap-x-8" aria-label="Primary">
            {navItems.map((item) => {
              const className = [
                "text-xs font-light transition-[color]",
                item.current
                  ? "[color:var(--text)]"
                  : "[color:var(--text-secondary)] hover:[color:var(--text)]",
              ].join(" ");

              if (item.external) {
                return (
                  <a
                    key={item.href}
                    href={item.href}
                    className={className}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {item.label}
                  </a>
                );
              }

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={className}
                  aria-current={item.current ? "page" : undefined}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
          {end ? <div className="flex shrink-0 items-center gap-3">{end}</div> : null}
        </div>
      </div>
    </header>
  );
}
