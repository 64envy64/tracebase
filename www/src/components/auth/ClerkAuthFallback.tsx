import { Spinner } from "@/components/ui/Spinner";

type ClerkAuthFallbackProps = {
  label: string;
};

export function ClerkAuthFallback({ label }: ClerkAuthFallbackProps) {
  return (
    <div
      className="flex min-h-[320px] w-full flex-col items-center justify-center rounded-[22px] px-6 py-8"
      style={{
        background: "transparent",
      }}
    >
      <Spinner className="h-5 w-5 text-[var(--accent)]" />
      <p className="mt-4 text-sm font-light" style={{ color: "var(--text-secondary)" }}>
        {label}
      </p>
    </div>
  );
}
