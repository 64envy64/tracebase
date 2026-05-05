"use client";

import { AnimatedButtonLabel } from "@/components/ui/AnimatedButtonLabel";
import { LoadingButton } from "@/components/ui/LoadingButton";

type GetStartedButtonProps = {
  className?: string;
  fullWidth?: boolean;
  label?: string;
  onMedia?: boolean;
  size?: "default" | "large";
};

const CALENDLY_URL = "https://calendly.com/a-sarzhigitov07/30min";

export function GetStartedButton({
  className = "",
  fullWidth = false,
  label = "Book a Demo",
  onMedia = false,
  size = "default",
}: GetStartedButtonProps) {
  const sizeClassName =
    size === "large" ? "h-12 px-6 text-sm sm:h-[52px] sm:px-7" : "h-10 px-5 text-[13px]";
  const themeClassName = onMedia
    ? "border border-[var(--accent)] bg-[var(--accent)] text-black shadow-[0_20px_42px_rgba(0,0,0,0.22)] hover:border-[var(--accent-hover)] hover:bg-[var(--accent-hover)]"
    : "border border-[var(--accent)] bg-[var(--accent)] text-black shadow-[0_16px_34px_rgba(0,0,0,0.16)] hover:border-[var(--accent-hover)] hover:bg-[var(--accent-hover)]";

  function handleClick() {
    window.open(CALENDLY_URL, "_blank", "noopener,noreferrer");
  }

  return (
    <LoadingButton
      type="button"
      loading={false}
      onClick={handleClick}
      className={`group rounded-full font-medium tracking-tight transition-[background-color,border-color,color,box-shadow,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] hover:-translate-y-px focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] ${sizeClassName} ${themeClassName} ${
        fullWidth ? "w-full" : ""
      } ${className}`.trim()}
    >
      <AnimatedButtonLabel label={label} />
    </LoadingButton>
  );
}
