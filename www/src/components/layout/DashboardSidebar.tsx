"use client";

import { useUser } from "@clerk/nextjs";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { LogoutButton } from "@/components/auth/LogoutButton";
import {
  IconActivity,
  IconAgent,
  IconArrowUpRight,
  IconBook,
  IconChart,
  IconGraph,
  IconHome,
  IconInbox,
  IconKey,
  IconLink as IconLinkSvg,
  IconPeople,
  IconPlug,
  IconRocket,
} from "@/components/dashboard/primitives/Icons";

/**
 * Dashboard sidebar — three vertical regions, all sharing the same
 * row geometry (icon · label · optional badge):
 *
 *   1. Primary nav         — Overview / Quickstart / Impact / …
 *   2. Engineering Brain   — How work flows / Connections / …
 *   3. External            — Whitepaper / Home / GitHub
 *
 * Bottom of the sidebar is the user card: circular avatar (Clerk's
 * imageUrl), display name, secondary email, and the LogoutButton.
 * The card sits inside its own bordered region so the rest of the
 * sidebar feels lighter.
 */

type NavItem = {
  href: string;
  label: string;
  icon: ReactNode;
  external?: boolean;
};

const PRIMARY_NAV: NavItem[] = [
  { href: "/dashboard", label: "Overview", icon: <IconHome /> },
  { href: "/dashboard/quickstart", label: "Quickstart", icon: <IconRocket /> },
  { href: "/dashboard/impact", label: "Impact", icon: <IconChart /> },
  { href: "/dashboard/installations", label: "Installations", icon: <IconLinkSvg /> },
  { href: "/dashboard/api-keys", label: "API keys", icon: <IconKey /> },
];

const ENGINEERING_BRAIN_NAV: NavItem[] = [
  { href: "/dashboard/graph", label: "How work flows", icon: <IconGraph /> },
  { href: "/dashboard/integrations", label: "Connections", icon: <IconPlug /> },
  { href: "/dashboard/issues", label: "Work coming in", icon: <IconInbox /> },
  { href: "/dashboard/agents", label: "Agents", icon: <IconAgent /> },
  { href: "/dashboard/runs", label: "Activity", icon: <IconActivity /> },
  { href: "/dashboard/team", label: "People", icon: <IconPeople /> },
  { href: "/dashboard/memory", label: "Lessons learned", icon: <IconBook /> },
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

export function DashboardSidebar() {
  const pathname = usePathname();
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

        <NavGroup items={PRIMARY_NAV} pathname={pathname} ariaLabel="Workspace" />

        <NavGroup
          items={ENGINEERING_BRAIN_NAV}
          pathname={pathname}
          ariaLabel="Engineering Brain"
          eyebrow="Engineering Brain"
          bordered
        />

        <div className="min-h-4 flex-1" aria-hidden />

        <NavGroup items={EXTERNAL_NAV} pathname={pathname} ariaLabel="External" bordered muted />
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
                {initialsOf(displayName)}
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
          <LogoutButton />
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
}: {
  items: NavItem[];
  pathname: string;
  ariaLabel: string;
  eyebrow?: string;
  bordered?: boolean;
  muted?: boolean;
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
            href={item.href}
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
