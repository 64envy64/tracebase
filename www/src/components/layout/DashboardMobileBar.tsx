"use client";

import { useUser } from "@clerk/nextjs";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogoutButton } from "@/components/auth/LogoutButton";

const MOBILE_NAV = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/quickstart", label: "Install" },
  { href: "/dashboard/impact", label: "Impact" },
  { href: "/dashboard/installations", label: "Linked" },
  { href: "/dashboard/api-keys", label: "Keys" },
] as const;

function isActive(pathname: string, href: string): boolean {
  if (href === "/dashboard") return pathname === "/dashboard";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function DashboardMobileBar() {
  const pathname = usePathname();
  const { user } = useUser();
  const shortName = user?.firstName || "Account";

  return (
    <header
      className="sticky top-0 z-40 flex items-center justify-between gap-3 border-b px-4 py-3 md:hidden"
      style={{ borderColor: "var(--border)", background: "var(--bg)" }}
    >
      <Link href="/" className="flex shrink-0 items-center gap-2">
        <Image src="/logo.svg" alt="" width={20} height={20} className="h-5 w-5" />
        <span className="text-base font-semibold tracking-tight" style={{ color: "var(--text)" }}>
          TraceBase
        </span>
      </Link>

      <nav className="flex min-w-0 flex-1 items-center justify-end gap-1 overflow-x-auto" aria-label="Quick links">
        {MOBILE_NAV.map((item) => {
          const active = isActive(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className="shrink-0 rounded-sm px-2.5 py-1.5 text-xs font-light"
              style={{
                background: active ? "var(--surface)" : "transparent",
                color: active ? "var(--text)" : "var(--text-secondary)",
              }}
              aria-current={active ? "page" : undefined}
            >
              {item.label}
            </Link>
          );
        })}
        <span className="shrink-0 px-1 text-[11px] font-light uppercase tracking-[0.16em]" style={{ color: "var(--text-tertiary)" }}>
          {shortName}
        </span>
        <LogoutButton />
      </nav>
    </header>
  );
}
