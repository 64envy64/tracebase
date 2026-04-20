"use client";

import { useAuth } from "@clerk/nextjs";
import { usePathname, useRouter } from "next/navigation";
import { useTransition } from "react";
import { useGlobalLoading } from "@/components/providers/GlobalLoadingProvider";
import { LoadingButton } from "@/components/ui/LoadingButton";

type GetStartedButtonProps = {
  className?: string;
  fullWidth?: boolean;
  label?: string;
  onMedia?: boolean;
  size?: "default" | "large";
};

const LOADING_SCOPE = "route:get-started";

export function GetStartedButton({
  className = "",
  fullWidth = false,
  label = "Get Started",
  onMedia = false,
  size = "default",
}: GetStartedButtonProps) {
  const { isLoaded, isSignedIn } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const { isLoadingScope, setLoading } = useGlobalLoading();
  const [isPending, startTransition] = useTransition();

  const target = isLoaded && isSignedIn ? "/dashboard" : "/login";
  const loading = isPending || isLoadingScope(LOADING_SCOPE);
  const sizeClassName =
    size === "large" ? "h-12 px-6 text-sm sm:h-[52px] sm:px-7" : "h-10 px-5 text-[13px]";
  const themeClassName = onMedia
    ? "border border-[rgba(177,255,109,0.35)] bg-[rgba(177,255,109,0.96)] text-[#081106] hover:bg-[#d3ffab]"
    : "border border-[rgba(177,255,109,0.35)] bg-[var(--accent)] text-[#081106] hover:bg-[#c9ff98]";

  function handleClick() {
    if (pathname === target) {
      setLoading(LOADING_SCOPE, false);
      return;
    }

    setLoading(LOADING_SCOPE, true);

    startTransition(() => {
      router.push(target);
    });
  }

  return (
    <LoadingButton
      type="button"
      loading={loading}
      onClick={handleClick}
      className={`rounded-full font-medium tracking-tight ${sizeClassName} ${themeClassName} ${
        fullWidth ? "w-full" : ""
      } ${className}`.trim()}
    >
      {label}
    </LoadingButton>
  );
}
