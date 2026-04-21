import type { Metadata } from "next";
import { auth } from "@clerk/nextjs/server";
import { DeviceApprovalPanel } from "@/components/install/DeviceApprovalPanel";

export const metadata: Metadata = {
  title: "Connect CLI — TraceBase",
  description: "Approve a TraceBase CLI installation and return to your terminal.",
};

export default async function CliInstallPage({
  searchParams,
}: {
  searchParams: Promise<{ device?: string }>;
}) {
  await auth.protect();
  const params = await searchParams;
  const deviceCode = params.device?.trim() || "";

  return (
    <div className="min-h-svh px-4 py-8 md:px-8 md:py-10" style={{ background: "var(--bg)" }}>
      <div className="mx-auto max-w-[860px] space-y-5">
        <header className="border-b pb-4" style={{ borderColor: "var(--border)" }}>
          <p className="text-[10px] font-mono uppercase tracking-[0.18em]" style={{ color: "var(--text-tertiary)" }}>
            Install
          </p>
          <h1 className="mt-3 text-[clamp(1.6rem,3.2vw,2.4rem)] font-light leading-[1.04] tracking-tight">
            Connect this CLI session
          </h1>
          <p className="mt-3 max-w-[42rem] text-[13px] font-light leading-relaxed" style={{ color: "var(--text-secondary)" }}>
            The terminal is waiting for approval. Once you confirm below, the local `tracebase init`
            run will finish and the project will appear in your dashboard automatically.
          </p>
        </header>

        {deviceCode ? (
          <DeviceApprovalPanel deviceCode={deviceCode} />
        ) : (
          <div
            className="rounded-sm border p-5 text-[13px] font-light"
            style={{
              borderColor: "var(--border)",
              background: "var(--surface)",
              color: "var(--text-secondary)",
            }}
          >
            Missing device code. Re-run <code>npx tracebase init</code> from your project root.
          </div>
        )}
      </div>
    </div>
  );
}
