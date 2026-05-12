import type { AnchorHTMLAttributes, ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";
import Link from "next/link";

/**
 * Dashboard button vocabulary — three flavours so every section uses
 * the same control language.
 *
 *   • `<PrimaryButton>` — solid accent fill. Reserved for the one
 *     CTA that's the obvious next step on the page.
 *   • `<SecondaryButton>` — bordered, surface-fill, muted text.
 *     Sits next to a primary or stands alone for non-destructive
 *     navigation.
 *   • `<ActionPill>` — even more subtle. Used in toolbars and headers
 *     when the action is a navigation shortcut, not the page CTA.
 *
 * All three accept either an `href` (renders as a Next `<Link>`) or
 * an `onClick` (renders as a `<button>`). Mixing is a TypeScript
 * error — there's exactly one mode per call.
 */

type BaseProps = {
  children: ReactNode;
  icon?: ReactNode;
  className?: string;
  ariaLabel?: string;
};

type LinkMode = BaseProps & {
  href: string;
  external?: boolean;
  onClick?: never;
  type?: never;
  disabled?: never;
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "className" | "href" | "children">;

type ButtonMode = BaseProps & {
  onClick?: ButtonHTMLAttributes<HTMLButtonElement>["onClick"];
  type?: "button" | "submit";
  disabled?: boolean;
  href?: never;
  external?: never;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "onClick" | "type" | "disabled" | "children">;

type AnyMode = LinkMode | ButtonMode;

function isLink(p: AnyMode): p is LinkMode {
  return typeof (p as LinkMode).href === "string";
}

function omitProps<T extends object>(
  props: T,
  keys: readonly string[],
): Record<string, unknown> {
  const rest = { ...props } as Record<string, unknown>;
  for (const key of keys) delete rest[key];
  return rest;
}

function ButtonShell(props: AnyMode & {
  background: string;
  borderColor: string;
  color: string;
  hoverShift?: string;
}) {
  const {
    children,
    icon,
    className = "",
    background,
    borderColor,
    color,
    hoverShift = "rgba(255,255,255,0.04)",
    ariaLabel,
  } = props;

  const inner = (
    <>
      {icon ? (
        <span className="inline-flex shrink-0" aria-hidden>
          {icon}
        </span>
      ) : null}
      <span className="min-w-0 truncate">{children}</span>
    </>
  );

  const style = {
    borderColor,
    background,
    color,
    ["--hover-shift" as string]: hoverShift,
  } as CSSProperties;

  // Uniform geometry across every dashboard button: same height
  // (~30px = h-[30px]), same radius, same horizontal padding. The
  // only thing the three flavours change is the background / border
  // colour and the hover shift. Hover transitions are kept under
  // 150ms and the shifts are deliberately tiny — visible enough to
  // signal hit-targets, never enough to flash.
  const classes =
    "inline-flex h-[30px] items-center gap-1.5 rounded-lg border px-3 text-[12px] font-light leading-none transition-[background-color,color,border-color] duration-150 hover:bg-[var(--hover-shift)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--accent)] disabled:cursor-default disabled:opacity-50 " +
    className;

  if (isLink(props)) {
    const { href, external } = props;
    const anchorRest = omitProps(props, [
      "href",
      "external",
      "children",
      "icon",
      "className",
      "ariaLabel",
      "background",
      "borderColor",
      "color",
      "hoverShift",
    ]) as Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "className" | "href" | "children">;
    if (external) {
      return (
        <a
          {...anchorRest}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className={classes}
          style={style}
          aria-label={ariaLabel}
        >
          {inner}
        </a>
      );
    }
    return (
      <Link href={href} className={classes} style={style} aria-label={ariaLabel}>
        {inner}
      </Link>
    );
  }
  const { onClick, type = "button", disabled } = props;
  const buttonRest = omitProps(props, [
    "onClick",
    "type",
    "disabled",
    "href",
    "external",
    "children",
    "icon",
    "className",
    "ariaLabel",
    "background",
    "borderColor",
    "color",
    "hoverShift",
  ]) as Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "onClick" | "type" | "disabled" | "children">;
  return (
    <button
      {...buttonRest}
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={classes}
      style={style}
      aria-label={ariaLabel}
    >
      {inner}
    </button>
  );
}

export function PrimaryButton(props: AnyMode) {
  return (
    <ButtonShell
      {...props}
      background="var(--accent)"
      borderColor="var(--accent)"
      color="var(--bg)"
      // 6% lift on hover — barely visible against the accent fill,
      // enough to confirm the press target without flashing.
      hoverShift="color-mix(in srgb, var(--accent) 94%, white 6%)"
    />
  );
}

export function SecondaryButton(props: AnyMode) {
  return (
    <ButtonShell
      {...props}
      background="var(--surface)"
      borderColor="var(--border)"
      color="var(--text)"
      hoverShift="rgba(255,255,255,0.025)"
    />
  );
}

export function ActionPill(props: AnyMode) {
  return (
    <ButtonShell
      {...props}
      background="var(--surface)"
      borderColor="var(--border)"
      color="var(--text-secondary)"
      hoverShift="rgba(255,255,255,0.02)"
    />
  );
}
