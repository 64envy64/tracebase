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

  return (
    <LoadingButton
      onClick={handleLogout}
      loading={isLoadingScope("auth:sign-out")}
      className="inline-flex h-9 items-center rounded-sm border px-3 text-xs font-light transition-[background-color,border-color] hover:[border-color:rgba(237,236,236,0.14)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--accent)]"
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
