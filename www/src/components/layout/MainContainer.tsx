import type { ReactNode } from "react";

export function MainContainer({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <main className={`mx-auto max-w-[1080px] px-6 pb-16 pt-24 ${className}`.trim()}>{children}</main>
  );
}
