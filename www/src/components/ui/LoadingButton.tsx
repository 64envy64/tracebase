import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Spinner } from "@/components/ui/Spinner";

type LoadingButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  loading?: boolean;
  children: ReactNode;
};

export function LoadingButton({
  children,
  className = "",
  disabled,
  loading = false,
  type = "button",
  ...props
}: LoadingButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading}
      className={`relative inline-flex items-center justify-center overflow-hidden transition-[background-color,border-color,color,opacity,transform] disabled:cursor-not-allowed disabled:opacity-60 ${className}`.trim()}
      {...props}
    >
      <span className={loading ? "opacity-0" : "opacity-100"}>{children}</span>
      {loading ? (
        <span className="absolute inset-0 flex items-center justify-center">
          <Spinner className="h-3.5 w-3.5" />
        </span>
      ) : null}
    </button>
  );
}
