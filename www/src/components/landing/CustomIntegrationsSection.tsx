const CUSTOM_STEPS = [
  {
    number: "01",
    title: "We map your current pipeline",
    body: "We identify where your agents repeat work, where prompts drift, and where cost spikes come from avoidable re-exploration.",
  },
  {
    number: "02",
    title: "We fit TraceBase into the stack",
    body: "SDK middleware, MCP tools, or a custom orchestration layer — whatever matches the way your product already routes model calls.",
  },
  {
    number: "03",
    title: "Your system compounds from there",
    body: "Resolved paths get stored, recall quality improves, and repeat workflows start grounded instead of blank.",
  },
] as const;

export function CustomIntegrationsSection() {
  return (
    <section className="scroll-mt-20 py-24" id="custom-integrations" aria-labelledby="custom-integrations-heading">
      <div
        className="overflow-hidden border"
        style={{
          borderColor: "var(--border)",
          background: "rgba(255,255,255,0.02)",
        }}
      >
        <div className="grid gap-px xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]" style={{ background: "var(--border)" }}>
          <div className="p-8 md:p-10" style={{ background: "var(--bg)" }}>
            <p className="text-xs font-light uppercase tracking-[0.22em]" style={{ color: "var(--text-tertiary)" }}>
              Custom integrations
            </p>
            <h2
              id="custom-integrations-heading"
              className="mt-6 max-w-[12ch] text-[clamp(2rem,4vw,3.9rem)] font-mono font-medium leading-[0.94] tracking-[-0.04em]"
            >
              Need TraceBase inside a custom runtime?
            </h2>
            <p className="mt-6 max-w-xl text-[15px] font-light leading-relaxed" style={{ color: "var(--text-secondary)" }}>
              When your models already sit inside a larger workflow, the right move is usually not another generic widget.
              It&apos;s a reasoning layer shaped around the way your pipeline actually behaves.
            </p>
            <p className="mt-4 max-w-xl text-sm font-light leading-relaxed" style={{ color: "var(--text-secondary)" }}>
              We can plug retrieval, injection, and memory capture into existing agent loops, internal tools, or product
              surfaces without forcing a rewrite.
            </p>

            <div className="mt-8">
              <a
                href="https://calendly.com/a-sarzhigitov07/30min"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-[56px] items-center justify-center rounded-[18px] border border-[var(--accent)] bg-[var(--accent)] px-6 text-sm font-semibold tracking-tight text-[var(--accent-ink)] transition-colors hover:bg-[var(--accent-hover)]"
              >
                Talk to us
              </a>
            </div>
          </div>

          <div className="grid gap-px md:grid-rows-3" style={{ background: "var(--border)" }}>
            {CUSTOM_STEPS.map((step) => (
              <article key={step.number} className="p-8 md:p-10" style={{ background: "var(--bg)" }}>
                <p className="text-[clamp(2.25rem,4vw,3.5rem)] font-mono font-medium tracking-[-0.05em]" style={{ color: "rgba(237,236,236,0.2)" }}>
                  {step.number}
                </p>
                <h3 className="mt-6 text-[1.1rem] font-semibold tracking-tight md:text-[1.2rem]">{step.title}</h3>
                <p className="mt-4 max-w-[34rem] text-sm font-light leading-relaxed md:text-[15px]" style={{ color: "var(--text-secondary)" }}>
                  {step.body}
                </p>
              </article>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
