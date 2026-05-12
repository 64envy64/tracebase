"use client";

import { useClerk } from "@clerk/nextjs";
import { useGlobalLoading } from "@/components/providers/GlobalLoadingProvider";
import { LoadingButton } from "@/components/ui/LoadingButton";

export function LogoutButton() {
  const { signOut } = useClerk();
  const { isLoadingScope, runWithLoading } = useGlobalLoading();

  async function handleLogout() {
    await runWithLoading("auth:sign-out", async () => {
      await signOut({ redirectUrl: "/" });
    });
  }

  // Geometry matches the dashboard's SecondaryButton / ActionPill
  // primitives: h-[30px], rounded-lg, px-3, text-[12px], surface
  // background, border-on-border, the same barely-visible hover.
  // Kept as its own component because it needs LoadingButton's
  // spinner overlay — wrapping SecondaryButton would lose that.
  return (
    <LoadingButton
      onClick={handleLogout}
      loading={isLoadingScope("auth:sign-out")}
      className="inline-flex h-[30px] items-center gap-1.5 rounded-lg border px-3 text-[12px] font-light leading-none transition-[background-color,color,border-color] duration-150 hover:bg-[rgba(255,255,255,0.02)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--accent)]"
      style={{
        borderColor: "var(--border)",
        background: "var(--surface)",
        color: "var(--text-secondary)",
      }}
    >
      Log out
    </LoadingButton>
  );
}
