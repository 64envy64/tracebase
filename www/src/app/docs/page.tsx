import Link from "next/link";
import type { Metadata } from "next";
import { GitHubMark } from "@/components/ui/GitHubMark";

export const metadata: Metadata = {
  title: "TraceBase Docs",
  description: "Quickstart, integrations, architecture, and troubleshooting for TraceBase.",
};

const QUICKSTART_COMMANDS = [
  "npx tracebase-ai init",
  "npx tracebase-ai doctor",
  "npx tracebase-ai status",
  "npx tracebase-ai serve --mcp",
] as const;

const INTEGRATIONS = [
  {
    title: "IDE agents",
    body: "Use the MCP surface when the agent already operates through tools inside the editor. This keeps rollout lightweight and close to the developer workflow.",
  },
  {
    title: "Wrapped SDK clients",
    body: "Use middleware when your application already owns model calls and you want the memory layer to sit in the same execution path.",
  },
  {
    title: "Custom runtimes",
    body: "Use the library and service boundaries directly when your team needs tighter control over serving, storage, or internal orchestration.",
  },
] as const;

const ARCHITECTURE = [
  {
    title: "Capture",
    body: "Successful runs become durable project-scoped traces that can be reused later instead of being lost as transient session output.",
  },
  {
    title: "Retrieve",
    body: "New work checks for relevant prior wins before generation begins, so the model can start from grounded context when a strong match exists.",
  },
  {
    title: "Serve",
    body: "Integration happens at the layer your team already owns: tool surface, middleware boundary, or a dedicated runtime path.",
  },
] as const;

const TROUBLESHOOTING_LINKS = [
  {
    label: "Quickstart guide",
    href: "https://github.com/64envy64/tracebase/blob/main/docs/QUICKSTART.md",
  },
  {
    label: "Troubleshooting",
    href: "https://github.com/64envy64/tracebase/blob/main/docs/TROUBLESHOOTING.md",
  },
  {
    label: "Design notes",
    href: "https://github.com/64envy64/tracebase/blob/main/docs/DESIGN_v2.md",
  },
] as const;

function Section({
  id,
  eyebrow,
  title,
  body,
  children,
}: {
  id: string;
  eyebrow: string;
  title: string;
  body: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24 border-t py-16 md:py-[4.5rem]" style={{ borderColor: "var(--border)" }}>
      <div className="max-w-[720px]">
        <p className="mb-4 text-[11px] font-light uppercase tracking-[0.2em]" style={{ color: "var(--text-tertiary)" }}>
          {eyebrow}
        </p>
        <h2 className="text-[clamp(1.65rem,3.8vw,2.8rem)] font-light leading-[1.02] tracking-tight">{title}</h2>
        <p className="mt-5 max-w-[42rem] text-[13px] font-light leading-relaxed md:text-sm" style={{ color: "var(--text-secondary)" }}>
          {body}
        </p>
      </div>
      <div className="mt-9">{children}</div>
    </section>
  );
}

export default function DocsPage() {
  return (
    <div className="min-h-screen">
      <header
        className="sticky top-0 z-50 border-b border-white/[0.08]"
        style={{
          background: "rgba(15, 14, 9, 0.76)",
          backdropFilter: "blur(14px)",
          WebkitBackdropFilter: "blur(14px)",
        }}
      >
        <div className="mx-auto flex max-w-[1080px] items-center justify-between gap-4 px-6 py-4">
          <div>
            <p className="text-[11px] uppercase tracking-[0.2em]" style={{ color: "var(--text-tertiary)" }}>
              TraceBase Docs
            </p>
            <p className="mt-1 text-sm font-light" style={{ color: "var(--text-secondary)" }}>
              Setup, rollout, and operating notes for the simplified landing.
            </p>
          </div>

          <nav className="hidden items-center gap-5 text-[13px] md:flex" aria-label="Docs navigation">
            <a href="#quickstart" className="transition-colors hover:text-[var(--text)]" style={{ color: "var(--text-secondary)" }}>
              Quickstart
            </a>
            <a href="#integrations" className="transition-colors hover:text-[var(--text)]" style={{ color: "var(--text-secondary)" }}>
              Integrations
            </a>
            <a href="#architecture" className="transition-colors hover:text-[var(--text)]" style={{ color: "var(--text-secondary)" }}>
              Architecture
            </a>
            <a href="#troubleshooting" className="transition-colors hover:text-[var(--text)]" style={{ color: "var(--text-secondary)" }}>
              Troubleshooting
            </a>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-[1080px] px-6 py-14">
        <div className="max-w-[760px]">
          <p className="text-[11px] uppercase tracking-[0.2em]" style={{ color: "rgb(var(--accent-rgb) / 0.72)" }}>
            Docs
          </p>
          <h1 className="mt-4 text-[clamp(2rem,5vw,4rem)] font-light leading-[0.98] tracking-tight">
            The landing stays short.
            <br />
            The operating detail lives here.
          </h1>
          <p className="mt-6 max-w-[42rem] text-[13px] font-light leading-relaxed md:text-sm" style={{ color: "var(--text-secondary)" }}>
            This page holds the setup path, integration choices, high-level architecture, and first troubleshooting checks.
            It is intentionally operator-oriented and easier to expand than the homepage.
          </p>
        </div>

        <Section
          id="quickstart"
          eyebrow="Quickstart"
          title="Bring TraceBase into a project in a few commands."
          body="The default path is local-first and project-scoped. Initialize the workspace, confirm health, and then verify that your agent surface can see the integration."
        >
          <div className="grid gap-px overflow-hidden border md:grid-cols-[1.1fr_0.9fr]" style={{ borderColor: "var(--border)", background: "var(--border)" }}>
            <div className="p-6 md:p-7" style={{ background: "var(--bg)" }}>
              <div className="space-y-3 rounded-[18px] border p-5 font-mono text-[13px] leading-relaxed" style={{ borderColor: "rgba(255,255,255,0.08)", background: "rgba(255,255,255,0.02)" }}>
                {QUICKSTART_COMMANDS.map((command) => (
                  <div key={command} className="overflow-x-auto">
                    <span style={{ color: "var(--text-tertiary)" }}>$ </span>
                    <span>{command}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="p-6 md:p-7" style={{ background: "var(--bg)" }}>
              <h3 className="text-[1.02rem] font-normal tracking-tight md:text-[1.12rem]">What to expect</h3>
              <ul className="mt-5 space-y-4 text-[13px] font-light leading-relaxed md:text-sm" style={{ color: "var(--text-secondary)" }}>
                <li>Initialize a project-local store and config rather than a shared global memory.</li>
                <li>Run health checks before rollout so broken MCP or config wiring is visible immediately.</li>
                <li>Use `status` after real runs to verify that the memory layer is actually seeing activity.</li>
              </ul>
            </div>
          </div>
        </Section>

        <Section
          id="integrations"
          eyebrow="Integrations"
          title="Choose the integration surface you already own."
          body="The point is not to force a new workflow. Pick the boundary that matches the agent runtime your team already ships."
        >
          <div className="grid gap-px overflow-hidden border md:grid-cols-3" style={{ borderColor: "var(--border)", background: "var(--border)" }}>
            {INTEGRATIONS.map((item) => (
              <article key={item.title} className="min-h-[220px] p-6 md:p-7" style={{ background: "var(--bg)" }}>
                <h3 className="text-[1.02rem] font-normal tracking-tight md:text-[1.12rem]">{item.title}</h3>
                <p className="mt-5 text-[13px] font-light leading-relaxed md:text-sm" style={{ color: "var(--text-secondary)" }}>
                  {item.body}
                </p>
              </article>
            ))}
          </div>
        </Section>

        <Section
          id="architecture"
          eyebrow="Architecture"
          title="A simple mental model is enough for the public docs."
          body="You do not need every internal detail to evaluate fit. The important point is where prior work is captured, how it is surfaced, and where it is served back into live runs."
        >
          <div className="grid gap-px overflow-hidden border md:grid-cols-3" style={{ borderColor: "var(--border)", background: "var(--border)" }}>
            {ARCHITECTURE.map((item) => (
              <article key={item.title} className="min-h-[212px] p-6 md:p-7" style={{ background: "var(--bg)" }}>
                <p className="mb-5 text-[10px] font-mono uppercase tracking-[0.18em]" style={{ color: "var(--text-tertiary)" }}>
                  Layer
                </p>
                <h3 className="text-[1.02rem] font-normal tracking-tight md:text-[1.12rem]">{item.title}</h3>
                <p className="mt-5 text-[13px] font-light leading-relaxed md:text-sm" style={{ color: "var(--text-secondary)" }}>
                  {item.body}
                </p>
              </article>
            ))}
          </div>
        </Section>

        <Section
          id="troubleshooting"
          eyebrow="Troubleshooting"
          title="Start with the health surface before guessing."
          body="Most rollout failures are wiring problems, local config issues, or a store that was never initialized correctly. The linked docs cover the detailed recovery paths."
        >
          <div className="grid gap-px overflow-hidden border md:grid-cols-[1.15fr_0.85fr]" style={{ borderColor: "var(--border)", background: "var(--border)" }}>
            <div className="p-6 md:p-7" style={{ background: "var(--bg)" }}>
              <h3 className="text-[1.02rem] font-normal tracking-tight md:text-[1.12rem]">First checks</h3>
              <ul className="mt-5 space-y-4 text-[13px] font-light leading-relaxed md:text-sm" style={{ color: "var(--text-secondary)" }}>
                <li>Run `npx tracebase-ai doctor` before touching config by hand.</li>
                <li>Confirm the agent actually sees the integration surface after restart.</li>
                <li>Use `status` and recent events to distinguish a fresh install from a broken store.</li>
              </ul>
            </div>
            <div className="p-6 md:p-7" style={{ background: "var(--bg)" }}>
              <h3 className="text-[1.02rem] font-normal tracking-tight md:text-[1.12rem]">Reference docs</h3>
              <div className="mt-5 flex flex-col gap-3">
                {TROUBLESHOOTING_LINKS.map((item) => (
                  <a
                    key={item.href}
                    href={item.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-[18px] border px-4 py-3 text-[13px] font-light transition-colors hover:border-white/16 hover:text-[var(--text)] md:text-sm"
                    style={{ borderColor: "rgba(255,255,255,0.08)", color: "var(--text-secondary)", background: "rgba(255,255,255,0.02)" }}
                  >
                    {item.label}
                  </a>
                ))}
              </div>
            </div>
          </div>
        </Section>

        <footer className="border-t py-8" style={{ borderColor: "var(--border)" }}>
          <div className="flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-[11px] uppercase tracking-[0.2em]" style={{ color: "var(--text-tertiary)" }}>
                TraceBase
              </p>
              <p className="mt-2 text-[13px] font-light leading-relaxed md:text-sm" style={{ color: "var(--text-secondary)" }}>
                Keep the homepage focused. Expand the docs as the rollout surface grows.
              </p>
            </div>

            <nav className="flex items-center gap-5" aria-label="Footer">
              <Link href="/" className="text-[13px] font-light transition-colors hover:text-[var(--text)]" style={{ color: "var(--text-secondary)" }}>
                Home
              </Link>
              <a
                href="https://github.com/64envy64/tracebase"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/10 text-[var(--text-secondary)] transition-colors hover:text-[var(--text)]"
                aria-label="GitHub repository"
              >
                <GitHubMark className="h-[18px] w-[18px]" />
              </a>
            </nav>
          </div>
        </footer>
      </main>
    </div>
  );
}
