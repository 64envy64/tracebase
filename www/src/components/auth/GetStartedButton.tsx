"use client";

import { useAuth } from "@clerk/nextjs";
import { usePathname, useRouter } from "next/navigation";
import { useTransition } from "react";
import { useGlobalLoading } from "@/components/providers/GlobalLoadingProvider";
import { AnimatedButtonLabel } from "@/components/ui/AnimatedButtonLabel";
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
    ? "border border-[var(--accent)] bg-[var(--accent)] text-black shadow-[0_20px_42px_rgba(0,0,0,0.22)] hover:border-[var(--accent-hover)] hover:bg-[var(--accent-hover)]"
    : "border border-[var(--accent)] bg-[var(--accent)] text-black shadow-[0_16px_34px_rgba(0,0,0,0.16)] hover:border-[var(--accent-hover)] hover:bg-[var(--accent-hover)]";

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
      className={`group rounded-full font-medium tracking-tight transition-[background-color,border-color,color,box-shadow,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] hover:-translate-y-px focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] ${sizeClassName} ${themeClassName} ${
        fullWidth ? "w-full" : ""
      } ${className}`.trim()}
    >
      <AnimatedButtonLabel label={label} />
    </LoadingButton>
  );
}
