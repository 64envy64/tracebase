"use client";

import { useUser } from "@clerk/nextjs";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogoutButton } from "@/components/auth/LogoutButton";

export function DashboardMobileBar() {
  const pathname = usePathname();
  const onDashboard = pathname.startsWith("/dashboard");
  const { user } = useUser();
  const shortName = user?.firstName || "Account";

  return (
    <header
      className="sticky top-0 z-40 flex items-center justify-between gap-3 border-b px-4 py-3 md:hidden"
      style={{ borderColor: "var(--border)", background: "var(--bg)" }}
    >
      <Link href="/" className="flex shrink-0 items-center gap-2">
        <Image src="/logo.svg" alt="" width={20} height={20} className="h-5 w-5" />
        <span className="text-sm font-light tracking-wide" style={{ color: "var(--text)" }}>
          tracebase
        </span>
      </Link>

      <nav className="flex min-w-0 flex-1 items-center justify-end gap-1 overflow-x-auto" aria-label="Quick links">
        <Link
          href="/dashboard"
          className="shrink-0 rounded-sm px-2.5 py-1.5 text-xs font-light"
          style={{
            background: onDashboard ? "var(--surface)" : "transparent",
            color: onDashboard ? "var(--text)" : "var(--text-secondary)",
          }}
        >
          Dashboard
        </Link>
        <Link
          href="/whitepaper"
          className="shrink-0 rounded-sm px-2.5 py-1.5 text-xs font-light [color:var(--text-secondary)]"
        >
          Docs
        </Link>
        <span className="shrink-0 px-1 text-[11px] font-light uppercase tracking-[0.16em]" style={{ color: "var(--text-tertiary)" }}>
          {shortName}
        </span>
        <LogoutButton />
      </nav>
    </header>
  );
}
