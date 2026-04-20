import Image from "next/image";
import { type ReactNode } from "react";
import { CtaSection } from "@/components/landing/CtaSection";
import { HeroWithVideo } from "@/components/landing/HeroWithVideo";
import { IntegrationsGrid } from "@/components/landing/IntegrationsGrid";
import { LandingNav } from "@/components/landing/LandingNav";
import { PricingGrid } from "@/components/landing/PricingGrid";
import { RunComparisonSection } from "@/components/landing/RunComparisonSection";
import { SetupTabs } from "@/components/landing/SetupTabs";

function SectionHeading({
  eyebrow,
  muted,
  title,
  body,
}: {
  eyebrow: string;
  muted: string;
  title: string;
  body?: string;
}) {
  return (
    <div className="mb-12 md:mb-14">
      <p className="mb-6 text-xs font-light tracking-[0.22em] uppercase" style={{ color: "var(--text-tertiary)" }}>
        {eyebrow}
      </p>
      <div className="max-w-[920px]">
        <p
          className="text-[clamp(2rem,4.8vw,4.25rem)] font-light leading-[0.98] tracking-tight"
          style={{ color: "rgba(237,236,236,0.52)" }}
        >
          {muted}
        </p>
        <h2 className="mt-1 text-[clamp(2rem,4.8vw,4.25rem)] font-light leading-[0.98] tracking-tight">{title}</h2>
      </div>
      {body ? (
        <p className="mt-6 max-w-xl text-sm font-light leading-relaxed" style={{ color: "var(--text-secondary)" }}>
          {body}
        </p>
      ) : null}
    </div>
  );
}

function SectionGrid({
  columnsClassName,
  children,
}: {
  columnsClassName: string;
  children: ReactNode;
}) {
  return (
    <div
      className="overflow-hidden border"
      style={{
        borderColor: "var(--border)",
        background: "rgba(255,255,255,0.02)",
      }}
    >
      <div className={`grid gap-px ${columnsClassName}`} style={{ background: "var(--border)" }}>
        {children}
      </div>
    </div>
  );
}

function SectionCard({
  eyebrow,
  title,
  body,
  minHeightClassName = "min-h-[196px] md:min-h-[210px]",
}: {
  eyebrow?: string;
  title: string;
  body: string;
  minHeightClassName?: string;
}) {
  return (
    <article className={`flex flex-col justify-between p-6 md:p-7 ${minHeightClassName}`} style={{ background: "var(--bg)" }}>
      <div>
        {eyebrow ? (
          <p className="mb-5 text-[10px] font-mono uppercase tracking-[0.18em]" style={{ color: "var(--text-tertiary)" }}>
            {eyebrow}
          </p>
        ) : null}
        <h3 className="text-[1.1rem] font-normal tracking-tight md:text-[1.2rem]">{title}</h3>
      </div>
      <p className="mt-5 max-w-[28rem] text-sm font-light leading-relaxed" style={{ color: "var(--text-secondary)" }}>
        {body}
      </p>
    </article>
  );
}

export default function Home() {
  return (
    <div className="min-h-screen">
      <LandingNav />

      <HeroWithVideo />

      <main className="mx-auto max-w-[1080px] bg-[var(--bg)] px-6" style={{ color: "var(--text)" }}>
        <RunComparisonSection />

        <div className="border-t" style={{ borderColor: "var(--border)" }} />

        <section className="scroll-mt-20 py-20 md:py-24" id="overview" aria-labelledby="overview-heading">
          <p className="mb-3 text-xs font-light tracking-widest uppercase" style={{ color: "var(--text-tertiary)" }}>
            Overview
          </p>
          <h2 id="overview-heading" className="mb-6 text-[26px] font-light tracking-tight sm:text-[28px]">
            What you get
          </h2>
          <p className="mb-10 max-w-2xl text-sm font-light leading-relaxed" style={{ color: "var(--text-secondary)" }}>
            TraceBase captures every solved problem as a reasoning trace and feeds it back into future runs. Your
            agents don&apos;t just execute — they accumulate expertise. Every run is built on every run before it.
          </p>
          <SectionGrid columnsClassName="sm:grid-cols-2">
            <SectionCard
              title="IDEs"
              body="MCP tools for recall before a task and store after, without changing the flow teams already use."
            />
            <SectionCard
              title="SDK"
              body="Wrap OpenAI or Anthropic clients once; middleware runs recall, then your completion, then store."
            />
            <SectionCard
              title="Repeated work"
              body="Similar incidents surface prior traces instead of forcing the model to reason from zero each time."
            />
            <SectionCard
              title="Storage"
              body="Local SQLite by default, with optional embeddings when you want broader semantic retrieval."
            />
          </SectionGrid>
          <p className="mt-10 max-w-2xl text-[11px] font-light leading-relaxed" style={{ color: "var(--text-tertiary)" }}>
            TraceBase is included in the{" "}
            <a
              href="https://www.daytona.io/startups"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--text-secondary)] underline decoration-white/[0.12] underline-offset-2 transition-colors hover:text-[var(--text)]"
            >
              Daytona Startup Grid
            </a>{" "}
            — Daytona&apos;s program backing early teams that ship AI-native developer infrastructure.
          </p>
        </section>

        <div className="border-t" style={{ borderColor: "var(--border)" }} />

        {/* How it works */}
        <section className="scroll-mt-20 py-24" id="how">
          <SectionHeading
            eyebrow="How it works"
            muted="Recall before the call."
            title="Store after the fix."
            body="The middleware sits between your code and the LLM. Before each call it checks memory. After each call it stores the result. No manual work."
          />

          <SectionGrid columnsClassName="sm:grid-cols-2 lg:grid-cols-4">
            {[
              { n: "01", title: "Recall", desc: "Check memory for similar problems solved before." },
              { n: "02", title: "Inject", desc: "Add prior solution to system prompt as a hint." },
              { n: "03", title: "Call", desc: "LLM solves faster with context. Fewer tokens." },
              { n: "04", title: "Store", desc: "New trace captured. Memory grows automatically." },
            ].map((s) => (
              <SectionCard key={s.n} eyebrow={s.n} title={s.title} body={s.desc} minHeightClassName="min-h-[210px] md:min-h-[228px]" />
            ))}
          </SectionGrid>
        </section>

        <div className="border-t" style={{ borderColor: "var(--border)" }} />

        {/* Integrations */}
        <section className="py-24">
          <SectionHeading
            eyebrow="Integrations"
            muted="Works with any agent."
            title="Fits the tools teams already use."
            body="MCP for IDE-native agents, middleware for wrapped SDKs, and a clean path for custom runtimes when retrieval needs to stay under your control."
          />

          <IntegrationsGrid />
        </section>

        <div className="border-t" style={{ borderColor: "var(--border)" }} />

        {/* Features */}
        <section className="py-24">
          <p className="mb-8 text-xs font-light tracking-widest uppercase" style={{ color: "var(--text-tertiary)" }}>
            Under the hood
          </p>
          <SectionGrid columnsClassName="sm:grid-cols-2 lg:grid-cols-3">
            {[
              { title: "Multi-signal ranking", desc: "Fingerprint, BM25, Jaccard, structural, cosine. Two-stage retrieval." },
              { title: "Adaptive weights", desc: "Thompson Sampling learns optimal signal weights from your feedback." },
              { title: "Recall-before-call", desc: "Middleware recalls and injects prior solutions automatically." },
              { title: "Streaming", desc: "Full stream:true support. Traces captured after stream completes." },
              { title: "Local-first", desc: "SQLite with WAL. Sub-millisecond recall. Data stays on your machine." },
              { title: "Embeddings", desc: "Optional cosine similarity via OpenAI text-embedding-3-small." },
            ].map((f) => (
              <SectionCard key={f.title} title={f.title} body={f.desc} minHeightClassName="min-h-[188px] md:min-h-[204px]" />
            ))}
          </SectionGrid>
        </section>

        <div className="border-t" style={{ borderColor: "var(--border)" }} />

        {/* Setup */}
        <section className="scroll-mt-20 py-24" id="setup">
          <SectionHeading
            eyebrow="Setup"
            muted="Three ways."
            title="To use TraceBase."
            body="Pick the layer that fits your stack: wrapped SDKs, one-command IDE rollout, or direct control inside custom agents."
          />

          <SetupTabs />
        </section>

        <div className="border-t" style={{ borderColor: "var(--border)" }} />

        {/* Pricing */}
        <section className="scroll-mt-20 py-24" id="pricing">
          <SectionHeading
            eyebrow="Pricing"
            muted="Open source now."
            title="Managed launch pricing."
            body="Self-hosted is available today. The startup and enterprise tiers below are planned managed rollout packaging, shown here as draft launch pricing rather than live checkout."
          />

          <PricingGrid />
        </section>

        <div className="border-t" style={{ borderColor: "var(--border)" }} />

        {/* CTA */}
        <CtaSection />

        <footer
          className="flex flex-col gap-8 border-t py-8 lg:flex-row lg:items-center lg:justify-between lg:gap-10"
          style={{ borderColor: "var(--border)" }}
        >
          <div className="flex min-w-0 flex-col gap-2">
            <span className="text-xs font-light" style={{ color: "var(--text-tertiary)" }}>
              MIT &middot; tracebase
            </span>
            <p className="max-w-sm text-[11px] font-light leading-relaxed lg:max-w-xs" style={{ color: "var(--text-tertiary)" }}>
              Part of the{" "}
              <a
                href="https://www.daytona.io/startups"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--text-secondary)] underline decoration-white/[0.12] underline-offset-2 transition-colors hover:text-[var(--text)]"
              >
                Daytona Startup Grid
              </a>
              .
            </p>
          </div>

          <a
            href="https://www.daytona.io/startups"
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 self-start opacity-90 transition-opacity hover:opacity-100 lg:self-center"
            aria-label="Daytona Startup Grid (opens in a new tab)"
          >
            <Image
              src="/partners/daytonapartner.png"
              alt=""
              width={160}
              height={40}
              className="h-8 w-auto max-w-[200px] object-contain object-left"
              sizes="200px"
            />
          </a>

          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 self-start lg:self-center">
            <a
              href="https://github.com/64envy64/tracebase"
              className="text-xs font-light"
              style={{ color: "var(--text-tertiary)" }}
              target="_blank"
              rel="noopener noreferrer"
            >
              GitHub
            </a>
            <a
              href="https://www.npmjs.com/package/tracebase-ai"
              className="text-xs font-light"
              style={{ color: "var(--text-tertiary)" }}
              target="_blank"
              rel="noopener noreferrer"
            >
              npm
            </a>
          </div>
        </footer>
      </main>
    </div>
  );
}
