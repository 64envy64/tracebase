import type { ReactNode } from "react";
import Image from "next/image";

export function EmptyState({
  title,
  body,
  hint,
  artSrc,
  artAlt = "",
}: {
  title: string;
  body: string;
  hint?: ReactNode;
  artSrc?: string;
  artAlt?: string;
}) {
  return (
    <div
      className="rounded-lg border border-dashed px-4 py-8 text-center md:px-6"
      style={{ borderColor: "var(--border)", background: "rgba(255,255,255,0.01)" }}
    >
      {artSrc ? (
        <Image
          src={artSrc}
          alt={artAlt}
          width={64}
          height={64}
          className="mx-auto mb-4 rounded-lg"
        />
      ) : null}
      <p
        className="text-[12px] font-mono uppercase tracking-[0.18em]"
        style={{ color: "var(--text-tertiary)" }}
      >
        {title}
      </p>
      <p
        className="mx-auto mt-3 max-w-xl text-[12px] font-light leading-relaxed"
        style={{ color: "var(--text-secondary)" }}
      >
        {body}
      </p>
      {hint ? (
        <p
          className="mt-3 text-[11px] font-light leading-relaxed"
          style={{ color: "var(--text-tertiary)" }}
        >
          {hint}
        </p>
      ) : null}
    </div>
  );
}
