"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { GetStartedButton } from "@/components/auth/GetStartedButton";
import { GitHubStarButton } from "@/components/ui/GitHubStarButton";
import { MiniOcto, TracebaseInkWordmark } from "./brand/Marks";

type NavItem = { href: string; label: string; external?: boolean };

const NAV_LINKS: NavItem[] = [
  { href: "#capabilities", label: "Runtime" },
  { href: "#runs", label: "Runs" },
  { href: "/docs", label: "Docs" },
  { href: "#pricing", label: "Pricing" },
  { href: "#faq", label: "FAQ" },
];

const linkClass =
  "rounded-md px-2.5 py-1.5 text-[13px] font-normal tracking-tight text-[var(--text-secondary)] transition-colors hover:text-[var(--text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]";

const mobileRowClass =
  "flex w-full items-center rounded-md px-3 py-3 text-[15px] font-normal tracking-tight text-[var(--text-secondary)] transition-colors hover:bg-white/[0.04] hover:text-[var(--text)] active:bg-white/[0.06]";

const SCROLL_LOCK_OWNER = "landing-nav";

function clearLandingScrollLock(force = false) {
  if (typeof document === "undefined") return;

  const nodes = [document.body, document.documentElement];
  for (const node of nodes) {
    const owner = node.dataset.scrollLockOwner;
    if (!force && owner && owner !== SCROLL_LOCK_OWNER) continue;

    if (force || !owner || owner === SCROLL_LOCK_OWNER) {
      node.style.overflow = "";
      if (owner === SCROLL_LOCK_OWNER) {
        delete node.dataset.scrollLockOwner;
      }
    }
  }
}

function setLandingScrollLock() {
  if (typeof document === "undefined") return;

  const nodes = [document.body, document.documentElement];
  for (const node of nodes) {
    node.dataset.scrollLockOwner = SCROLL_LOCK_OWNER;
    node.style.overflow = "hidden";
  }
}

function IconMenuDouble() {
  return (
    <svg width="20" height="12" viewBox="0 0 20 12" fill="none" aria-hidden className="shrink-0">
      <path d="M0 1.5h20M0 10.5h20" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconClose() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden className="shrink-0">
      <path d="M3.5 3.5 12.5 12.5M12.5 3.5 3.5 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function DesktopLink({ href, label, external }: NavItem) {
  if (external) {
    return (
      <a href={href} className={linkClass} target="_blank" rel="noopener noreferrer">
        {label}
      </a>
    );
  }
  if (href.startsWith("/")) {
    return (
      <Link href={href} className={linkClass} prefetch={href === "/dashboard" ? false : undefined}>
        {label}
      </Link>
    );
  }
  return (
    <a href={href} className={linkClass}>
      {label}
    </a>
  );
}

function MobileRow({ item, onNavigate }: { item: NavItem; onNavigate: () => void }) {
  const { href, label, external } = item;
  if (external) {
    return (
      <a href={href} className={mobileRowClass} target="_blank" rel="noopener noreferrer" onClick={onNavigate}>
        {label}
      </a>
    );
  }
  if (href.startsWith("/")) {
    return (
      <Link href={href} className={mobileRowClass} onClick={onNavigate} prefetch={href === "/dashboard" ? false : undefined}>
        {label}
      </Link>
    );
  }
  return (
    <a href={href} className={mobileRowClass} onClick={onNavigate}>
      {label}
    </a>
  );
}

export function LandingNav() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    clearLandingScrollLock(true);
    return () => clearLandingScrollLock(true);
  }, []);

  useEffect(() => {
    const id = window.requestAnimationFrame(() => setOpen(false));
    clearLandingScrollLock(true);
    return () => window.cancelAnimationFrame(id);
  }, [pathname]);

  useEffect(() => {
    if (!open) {
      clearLandingScrollLock(true);
      return;
    }

    setLandingScrollLock();
    return () => clearLandingScrollLock(true);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const close = () => setOpen(false);

  return (
    <header
      className="landing-nav-enter fixed top-0 z-50 w-full border-b"
      style={{
        borderColor: "rgba(232,217,184,0.08)",
        background: "rgba(10, 16, 20, 0.76)",
        backdropFilter: "blur(14px)",
        WebkitBackdropFilter: "blur(14px)",
      }}
    >
      <div className="mx-auto flex h-14 max-w-[1080px] items-center justify-between gap-4 px-4 sm:px-6">
        <Link
          href="/"
          className="flex min-w-0 shrink items-center gap-2.5 rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
          onClick={close}
          aria-label="tracebase.ink home"
        >
          <MiniOcto size={22} animated />
          <TracebaseInkWordmark size={16} />
        </Link>

        <div className="hidden items-center gap-3 md:flex">
          <nav className="flex items-center gap-0.5" aria-label="Primary">
            {NAV_LINKS.map((item) => (
              <DesktopLink key={item.href} {...item} />
            ))}
          </nav>
          <GitHubStarButton />
          <GetStartedButton />
        </div>

        <button
          type="button"
          className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-white/[0.06] hover:text-[var(--text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] md:hidden"
          aria-expanded={open}
          aria-controls="landing-nav-mobile"
          aria-label={open ? "Close menu" : "Open menu"}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="flex h-5 w-5 items-center justify-center" aria-hidden>
            {open ? <IconClose /> : <IconMenuDouble />}
          </span>
        </button>
      </div>

      {open ? (
        <div id="landing-nav-mobile">
          <button
            type="button"
            className="fixed inset-0 top-14 z-40 bg-black/50 backdrop-blur-[2px]"
            aria-label="Close menu"
            onClick={close}
          />
          <nav
            className="absolute left-0 right-0 top-full z-50 border-b border-white/[0.08] shadow-[0_16px_48px_rgba(0,0,0,0.45)]"
            style={{
              background: "rgba(15, 14, 9, 0.96)",
              backdropFilter: "blur(16px)",
              WebkitBackdropFilter: "blur(16px)",
            }}
            aria-label="Primary mobile"
          >
            <div className="mx-auto max-w-[1080px] px-4 py-2 sm:px-6">
              <ul className="flex flex-col py-1">
                {NAV_LINKS.map((item) => (
                  <li key={item.href}>
                    <MobileRow item={item} onNavigate={close} />
                  </li>
                ))}
                <li className="px-1 pb-2 pt-3">
                  <GitHubStarButton fullWidth />
                </li>
              </ul>
              <div className="border-t border-white/[0.08] px-1 pb-3 pt-4">
                <GetStartedButton fullWidth />
              </div>
            </div>
          </nav>
        </div>
      ) : null}
    </header>
  );
}
