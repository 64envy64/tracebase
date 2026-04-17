"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogoutButton } from "@/components/auth/LogoutButton";

type NavItem =
  | { href: string; label: string; external?: false }
  | { href: string; label: string; external: true };

const PRIMARY_NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/whitepaper", label: "Whitepaper" },
  { href: "/", label: "Home" },
];

const SECONDARY_NAV: NavItem[] = [
  { href: "https://github.com/64envy64/tracebase", label: "GitHub", external: true },
];

function navActive(pathname: string, href: string) {
  if (href === "/dashboard") {
    return pathname === "/dashboard" || pathname.startsWith("/dashboard/");
  }
  return pathname === href;
}

export function DashboardSidebar() {
  const pathname = usePathname();

  return (
    <aside
      className="sticky top-0 hidden h-screen w-[232px] shrink-0 border-r md:flex md:flex-col"
      style={{ borderColor: "var(--border)", background: "var(--bg)" }}
      aria-label="App navigation"
    >
      <div className="flex flex-1 flex-col gap-8 overflow-y-auto px-4 py-6">
        <Link href="/" className="flex items-center gap-2.5 px-1">
          <Image src="/logo.svg" alt="" width={20} height={20} className="h-5 w-5" />
          <span className="text-sm font-light tracking-wide" style={{ color: "var(--text)" }}>
            tracebase
          </span>
        </Link>

        <nav className="flex flex-col gap-1" aria-label="Workspace">
          {PRIMARY_NAV.map((item) => {
            const active = navActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-sm border-l-2 border-transparent py-2 pl-[10px] pr-3 text-sm font-light transition-[background-color,color,border-color]"
                style={{
                  background: active ? "var(--surface)" : "transparent",
                  color: active ? "var(--text)" : "var(--text-secondary)",
                  borderLeftColor: active ? "var(--accent)" : "transparent",
                }}
                aria-current={active ? "page" : undefined}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="min-h-4 flex-1" aria-hidden />

        <nav className="flex flex-col gap-1 border-t pt-6" style={{ borderColor: "var(--border)" }} aria-label="External">
          {SECONDARY_NAV.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="rounded-sm px-3 py-2 text-sm font-light transition-[color] [color:var(--text-secondary)] hover:[color:var(--text)]"
              target="_blank"
              rel="noopener noreferrer"
            >
              {item.label}
            </a>
          ))}
        </nav>
      </div>

      <div className="flex flex-col gap-3 border-t px-4 py-5" style={{ borderColor: "var(--border)" }}>
        <span
          className="inline-flex w-fit rounded-sm border px-2.5 py-1.5 text-[11px] font-mono uppercase tracking-[0.18em]"
          style={{
            borderColor: "var(--border)",
            background: "var(--surface)",
            color: "var(--text-tertiary)",
          }}
        >
          admin
        </span>
        <LogoutButton />
      </div>
    </aside>
  );
}
