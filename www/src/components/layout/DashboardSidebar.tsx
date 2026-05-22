"use client";

import { useUser } from "@clerk/nextjs";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { LogoutButton } from "@/components/auth/LogoutButton";
import {
  IconActivity,
  IconArrowUpRight,
  IconBook,
  IconChart,
  IconHome,
  IconKey,
  IconLink as IconLinkSvg,
  IconPattern,
  IconPeople,
  IconRocket,
} from "@/components/dashboard/primitives/Icons";

/**
 * Dashboard sidebar — two functional groups plus an external row at
 * the foot.
 *
 *   OPERATIONS — the day-to-day surfaces a user opens repeatedly:
 *     Overview, Quickstart, Runs, Patterns, Memory, Impact.
 *
 *   WORKSPACE  — settings-like surfaces that get touched less often:
 *     Installations, API keys, Team.
 *
 *   EXTERNAL   — links out of the dashboard to product / docs / source.
 *
 * Each row has the same geometry (icon · label) so the three groups
 * read as one consistent column. The user card at the foot of the
 * sidebar sits inside its own bordered region so the rest feels light.
 */

type NavItem = {
  href: string;
  label: string;
  icon: ReactNode;
  external?: boolean;
};

const OPERATIONS_NAV: NavItem[] = [
  { href: "/dashboard", label: "Overview", icon: <IconHome /> },
  { href: "/dashboard/quickstart", label: "Quickstart", icon: <IconRocket /> },
  { href: "/dashboard/runs", label: "Runs", icon: <IconActivity /> },
  { href: "/dashboard/patterns", label: "Patterns", icon: <IconPattern /> },
  { href: "/dashboard/memory", label: "Memory", icon: <IconBook /> },
  { href: "/dashboard/impact", label: "Impact", icon: <IconChart /> },
];

const WORKSPACE_NAV: NavItem[] = [
  { href: "/dashboard/installations", label: "Installations", icon: <IconLinkSvg /> },
  { href: "/dashboard/api-keys", label: "API keys", icon: <IconKey /> },
  { href: "/dashboard/team", label: "Team", icon: <IconPeople /> },
];

const EXTERNAL_NAV: NavItem[] = [
  { href: "/whitepaper", label: "Whitepaper", icon: <IconBook /> },
  { href: "/", label: "Home", icon: <IconHome /> },
  {
    href: "https://github.com/64envy64/tracebase",
    label: "GitHub",
    icon: <IconArrowUpRight />,
    external: true,
  },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/dashboard") return pathname === "/dashboard";
  return pathname === href || pathname.startsWith(`${href}/`);
}

type DashboardSidebarProps = {
  demoMode?: boolean;
};

export function DashboardSidebar({ demoMode = false }: DashboardSidebarProps) {
  if (demoMode) {
    return (
      <SidebarFrame
        demoMode
        displayName="DataInfra pilot"
        secondaryLine="agent memory layer"
        initials="DI"
        showLogout={false}
      />
    );
  }

  return <AuthenticatedDashboardSidebar />;
}

function AuthenticatedDashboardSidebar() {
  const { isLoaded, user } = useUser();

  const displayName =
    user?.fullName ||
    user?.firstName ||
    user?.username ||
    user?.primaryEmailAddress?.emailAddress ||
    "Authenticated user";
  const secondaryLine = user?.primaryEmailAddress?.emailAddress;
  const avatarUrl = user?.imageUrl;

  return (
    <SidebarFrame
      demoMode={false}
      displayName={displayName}
      secondaryLine={secondaryLine}
      avatarUrl={avatarUrl}
      isLoaded={isLoaded}
      showLogout
    />
  );
}

function SidebarFrame({
  demoMode,
  displayName,
  secondaryLine,
  avatarUrl,
  initials,
  isLoaded = true,
  showLogout,
}: {
  demoMode: boolean;
  displayName: string;
  secondaryLine?: string | null;
  avatarUrl?: string | null;
  initials?: string;
  isLoaded?: boolean;
  showLogout: boolean;
}) {
  const pathname = usePathname();

  return (
    <aside
      className="sticky top-0 hidden h-screen w-[248px] shrink-0 border-r md:flex md:flex-col"
      style={{ borderColor: "var(--border)", background: "var(--bg)" }}
      aria-label="App navigation"
    >
      <div className="flex flex-1 flex-col gap-8 overflow-y-auto px-5 py-7">
        <Link href="/" className="flex items-center gap-2.5 px-1">
          <Image src="/logo.svg" alt="" width={22} height={22} className="h-[22px] w-[22px]" />
          <span className="text-[15px] font-semibold tracking-tight" style={{ color: "var(--text)" }}>
            TraceBase
          </span>
        </Link>

        <NavGroup
          items={OPERATIONS_NAV}
          pathname={pathname}
          ariaLabel="Operations"
          eyebrow="Operations"
          demoMode={demoMode}
        />

        <NavGroup
          items={WORKSPACE_NAV}
          pathname={pathname}
          ariaLabel="Workspace"
          eyebrow="Workspace"
          demoMode={demoMode}
          bordered
        />

        <div className="min-h-4 flex-1" aria-hidden />

        <NavGroup
          items={EXTERNAL_NAV}
          pathname={pathname}
          ariaLabel="External"
          bordered
          muted
          demoMode={false}
        />
      </div>

      <div className="border-t px-5 py-4" style={{ borderColor: "var(--border)" }}>
        <div className="flex items-center gap-3">
          <span
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full"
            style={{ background: "rgba(255,255,255,0.06)", border: "1px solid var(--border)" }}
            aria-hidden
          >
            {avatarUrl ? (
              // Clerk's imageUrl serves a CDN with already-resized avatars;
              // we pass through Image so Next.js can still optimize the
              // request when sizes change at the breakpoints.
              <Image
                src={avatarUrl}
                alt=""
                width={36}
                height={36}
                className="h-9 w-9 object-cover"
              />
            ) : (
              <span className="font-mono text-[11px]" style={{ color: "var(--text-tertiary)" }}>
                {initials ?? initialsOf(displayName)}
              </span>
            )}
          </span>
          <div className="min-w-0 flex-1 leading-tight">
            <p className="truncate text-[13px] font-normal" style={{ color: "var(--text)" }}>
              {isLoaded ? displayName : "Loading account"}
            </p>
            {secondaryLine ? (
              <p
                className="mt-0.5 truncate text-[11px] font-light"
                style={{ color: "var(--text-tertiary)" }}
              >
                {secondaryLine}
              </p>
            ) : null}
          </div>
          {showLogout ? <LogoutButton /> : null}
        </div>
      </div>
    </aside>
  );
}

function NavGroup({
  items,
  pathname,
  ariaLabel,
  eyebrow,
  bordered,
  muted,
  demoMode,
}: {
  items: NavItem[];
  pathname: string;
  ariaLabel: string;
  eyebrow?: string;
  bordered?: boolean;
  muted?: boolean;
  demoMode: boolean;
}) {
  return (
    <nav
      className={
        "flex flex-col gap-1" +
        (bordered ? " border-t pt-6" : "")
      }
      style={bordered ? { borderColor: "var(--border)" } : undefined}
      aria-label={ariaLabel}
    >
      {eyebrow ? (
        <p
          className="px-1.5 pb-2.5 text-[10px] font-mono uppercase tracking-[0.22em]"
          style={{ color: "var(--text-tertiary)" }}
        >
          {eyebrow}
        </p>
      ) : null}
      {items.map((item) => {
        const active = isActive(pathname, item.href);
        const href = demoMode && item.href.startsWith("/dashboard")
          ? `${item.href}?demo=1`
          : item.href;
        const rowStyle = {
          background: active ? "var(--surface)" : "transparent",
          color: active ? "var(--text)" : muted ? "var(--text-tertiary)" : "var(--text-secondary)",
        };
        const classes =
          "group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-light transition-[background-color,color] hover:bg-[rgba(255,255,255,0.02)]";
        const inner = (
          <>
            <span
              className="inline-flex shrink-0 transition-[color]"
              style={{ color: active ? "var(--text)" : "var(--text-tertiary)" }}
              aria-hidden
            >
              {item.icon}
            </span>
            <span className="min-w-0 truncate">{item.label}</span>
          </>
        );
        if (item.external) {
          return (
            <a
              key={item.href}
              href={item.href}
              target="_blank"
              rel="noopener noreferrer"
              className={classes}
              style={rowStyle}
            >
              {inner}
            </a>
          );
        }
        return (
          <Link
            key={item.href}
            href={href}
            className={classes}
            style={rowStyle}
            aria-current={active ? "page" : undefined}
          >
            {inner}
          </Link>
        );
      })}
    </nav>
  );
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
