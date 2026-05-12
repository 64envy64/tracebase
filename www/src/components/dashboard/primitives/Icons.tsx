/**
 * Inline SVG icons for the dashboard chrome.
 *
 * We carry our own icons instead of pulling in `lucide-react` /
 * `heroicons` because the dashboard uses ~10 distinct glyphs and the
 * cost of a third-party icon set (extra bundle weight, taste drift
 * when their style changes) outweighs the benefit. Each icon here is
 * 16×16 by default, single-stroke, currentColor — same proportion
 * across the chrome so the sidebar and cards stay visually aligned.
 */
import type { ReactNode, SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function Base({ children, size = 16, ...rest }: IconProps & { children: ReactNode; size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function IconHome(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M2.5 7.5L8 3l5.5 4.5" />
      <path d="M3.5 7v6h9V7" />
    </Base>
  );
}

export function IconRocket(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M9.5 2.5C12 4 13.5 6 13.5 9c0 1-.5 2-1.5 2.5L8 13.5l-4-4 2-4C6.5 4.5 7.5 4 8.5 4l1-1.5z" />
      <circle cx="9" cy="7" r="1.3" />
      <path d="M4 13c0 1 0 1 1 1" />
    </Base>
  );
}

export function IconChart(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M2.5 13.5h11" />
      <path d="M4.5 13.5V8.5" />
      <path d="M7.5 13.5V5.5" />
      <path d="M10.5 13.5V9.5" />
      <path d="M13.5 13.5V3.5" />
    </Base>
  );
}

export function IconLink(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M6.5 9.5L9.5 6.5" />
      <path d="M5.5 11l-1 1a2.5 2.5 0 01-3.5-3.5l2-2a2.5 2.5 0 013.5 0" />
      <path d="M10.5 5l1-1a2.5 2.5 0 013.5 3.5l-2 2a2.5 2.5 0 01-3.5 0" />
    </Base>
  );
}

export function IconKey(props: IconProps) {
  return (
    <Base {...props}>
      <circle cx="10.5" cy="6" r="3" />
      <path d="M8 8L3 13" />
      <path d="M5 11l1 1" />
    </Base>
  );
}

export function IconGraph(props: IconProps) {
  return (
    <Base {...props}>
      <circle cx="4" cy="4" r="1.3" />
      <circle cx="12" cy="4" r="1.3" />
      <circle cx="4" cy="12" r="1.3" />
      <circle cx="12" cy="12" r="1.3" />
      <path d="M5 5l6 6" />
      <path d="M11 5l-6 6" />
    </Base>
  );
}

export function IconPlug(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M5.5 2.5v3" />
      <path d="M10.5 2.5v3" />
      <path d="M4 5.5h8v3a4 4 0 01-8 0v-3z" />
      <path d="M8 9.5v4" />
    </Base>
  );
}

export function IconInbox(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M2.5 9.5L4 3h8l1.5 6.5" />
      <path d="M2.5 9.5h3l1 2h3l1-2h3v3.5h-11v-3.5z" />
    </Base>
  );
}

export function IconAgent(props: IconProps) {
  return (
    <Base {...props}>
      <rect x="3" y="5" width="10" height="8" rx="2" />
      <path d="M6 3v2" />
      <path d="M10 3v2" />
      <circle cx="6.5" cy="9" r=".8" />
      <circle cx="9.5" cy="9" r=".8" />
    </Base>
  );
}

export function IconActivity(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M2 8h3l1.5-4 3 8 1.5-4H14" />
    </Base>
  );
}

export function IconPeople(props: IconProps) {
  return (
    <Base {...props}>
      <circle cx="6" cy="6" r="2.2" />
      <path d="M2.5 13c.5-2 1.8-3 3.5-3s3 1 3.5 3" />
      <circle cx="11.5" cy="6.5" r="1.6" />
      <path d="M10 13c.5-1.8 1.6-2.5 2.5-2.5s1.5.4 1.8 1" />
    </Base>
  );
}

export function IconBook(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M3 3h5a2 2 0 012 2v8a2 2 0 00-2-2H3V3z" />
      <path d="M13 3H8a2 2 0 00-2 2v8a2 2 0 012-2h5V3z" />
    </Base>
  );
}

export function IconArrowUpRight(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M5 11L11 5" />
      <path d="M6 5h5v5" />
    </Base>
  );
}

export function IconChevronRight(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M6 4l4 4-4 4" />
    </Base>
  );
}

export function IconPlus(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M8 3v10" />
      <path d="M3 8h10" />
    </Base>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M3 8.5l3 3 7-7" />
    </Base>
  );
}

export function IconClose(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M4 4l8 8" />
      <path d="M12 4l-8 8" />
    </Base>
  );
}
