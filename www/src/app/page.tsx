import Image from "next/image";
import Link from "next/link";
import { type ReactNode } from "react";
import { CtaSection } from "@/components/landing/CtaSection";
import { HeroWithVideo } from "@/components/landing/HeroWithVideo";
import { LandingNav } from "@/components/landing/LandingNav";
import { PricingGrid } from "@/components/landing/PricingGrid";
import { RunComparisonSection } from "@/components/landing/RunComparisonSection";
import { GitHubMark } from "@/components/ui/GitHubMark";

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
    <div className="mb-10 md:mb-12">
      <p className="mb-5 text-[11px] font-light tracking-[0.2em] uppercase" style={{ color: "var(--text-tertiary)" }}>
        {eyebrow}
      </p>
      <div className="max-w-[920px]">
        <p
          className="text-[clamp(1.7rem,4vw,3.2rem)] font-light leading-[0.98] tracking-tight"
          style={{ color: "rgba(237,236,236,0.52)" }}
        >
          {muted}
        </p>
        <h2 className="mt-1 text-[clamp(1.7rem,4vw,3.2rem)] font-light leading-[0.98] tracking-tight">{title}</h2>
      </div>
      {body ? (
        <p className="mt-5 max-w-xl text-[13px] font-light leading-relaxed md:text-sm" style={{ color: "var(--text-secondary)" }}>
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
        <h3 className="text-[1.03rem] font-normal tracking-tight md:text-[1.12rem]">{title}</h3>
      </div>
      <p className="mt-5 max-w-[28rem] text-[13px] font-light leading-relaxed md:text-sm" style={{ color: "var(--text-secondary)" }}>
        {body}
      </p>
    </article>
  );
}

function SectionLinkCard({
  title,
  body,
  href,
}: {
  title: string;
  body: string;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="group flex min-h-[196px] flex-col justify-between p-6 transition-colors md:min-h-[208px] md:p-7"
      style={{ background: "var(--bg)" }}
    >
      <div>
        <p className="mb-5 text-[10px] font-mono uppercase tracking-[0.18em]" style={{ color: "var(--text-tertiary)" }}>
          Docs
        </p>
        <h3 className="text-[1.03rem] font-normal tracking-tight transition-colors group-hover:text-[var(--accent)] md:text-[1.12rem]">
          {title}
        </h3>
      </div>
      <div>
        <p className="max-w-[28rem] text-[13px] font-light leading-relaxed md:text-sm" style={{ color: "var(--text-secondary)" }}>
          {body}
        </p>
        <p className="mt-5 text-[11px] font-light uppercase tracking-[0.16em]" style={{ color: "rgb(var(--accent-rgb) / 0.72)" }}>
          Open section
        </p>
      </div>
    </Link>
  );
}

const DOCS_LINKS = [
  {
    title: "Quickstart",
    body: "Install, initialize a project-local store, and verify the agent surface in a few commands.",
    href: "/docs#quickstart",
  },
  {
    title: "Integrations",
    body: "How to fit TraceBase into IDE agents, wrapped SDK clients, and custom internal runtimes.",
    href: "/docs#integrations",
  },
  {
    title: "Architecture",
    body: "A high-level map of capture, retrieval, and serving without turning the landing into an implementation dump.",
    href: "/docs#architecture",
  },
  {
    title: "Troubleshooting",
    body: "The first checks to run when tooling, retrieval, or the local store look wrong in a live workspace.",
    href: "/docs#troubleshooting",
  },
] as const;

const FAQ_ITEMS = [
  {
    question: "What problem is TraceBase actually solving?",
    answer:
      "It reduces repeated re-discovery. When similar engineering or operations work comes back, the next run starts from prior wins instead of starting cold again.",
  },
  {
    question: "Do we have to move to a hosted platform?",
    answer:
      "No. The default path stays local-first and self-hosted, with project-scoped storage and integration points that fit the tools teams already run.",
  },
  {
    question: "Does this expose private reasoning or internal chain-of-thought?",
    answer:
      "No. The product is positioned around reusable traces and operator-facing signals, not around dumping raw internal deliberation into a public UI.",
  },
  {
    question: "Where does it fit in the stack?",
    answer:
      "Use it at the agent edge that already exists for your team: MCP for tool-driven agents, middleware for wrapped SDK calls, or a service boundary for custom runtimes.",
  },
  {
    question: "When does it help the most?",
    answer:
      "Repeat incidents, debugging loops, migrations, and any workflow where the second or fifth run should benefit from the first one having already paid the exploration cost.",
  },
  {
    question: "Why move setup and implementation detail into docs?",
    answer:
      "Because buyers need the promise quickly, while operators need the mechanics in a place they can return to. Landing and docs should do different jobs.",
  },
] as const;

export default function Home() {
  return (
    <div className="min-h-screen">
      <LandingNav />

      <HeroWithVideo />

      <main className="mx-auto max-w-[1080px] bg-[var(--bg)] px-6" style={{ color: "var(--text)" }}>
        <section className="scroll-mt-20 py-[4.5rem] md:py-20" id="overview" aria-labelledby="overview-heading">
          <p className="mb-3 text-[11px] font-light tracking-[0.2em] uppercase" style={{ color: "var(--text-tertiary)" }}>
            Overview
          </p>
          <h2 id="overview-heading" className="mb-5 text-[24px] font-light tracking-tight sm:text-[26px]">
            What changes once repeat work stops starting cold
          </h2>
          <p className="mb-9 max-w-2xl text-[13px] font-light leading-relaxed md:text-sm" style={{ color: "var(--text-secondary)" }}>
            TraceBase captures every solved problem as a reasoning trace and feeds it back into future runs. Your
            agents don&apos;t just execute — they accumulate expertise. Every run is built on every run before it.
          </p>
          <SectionGrid columnsClassName="sm:grid-cols-2">
            <SectionCard
              title="Document intake"
              body="Repeated extraction, classification, and review work improves once prior successful paths are surfaced before generation begins."
            />
            <SectionCard
              title="Claims + casework"
              body="Models stop treating every claim, form, or exception as a brand new problem when the shape has already shown up before."
            />
            <SectionCard
              title="Support triage"
              body="Repeated routing and response flows get shorter when grounded priors are injected ahead of another speculative pass."
            />
            <SectionCard
              title="Existing LLM pipeline"
              body="Drop a reasoning layer into the stack you already own instead of rebuilding around brittle checker logic."
            />
          </SectionGrid>
          <p className="mt-8 max-w-3xl text-[12px] font-light leading-relaxed" style={{ color: "rgba(237,236,236,0.46)" }}>
            Best fit tends to be repeat-heavy vertical SaaS work: document processing, claims automation, support
            operations, financial analysis, and other model jobs that recur in familiar shapes.
          </p>
          <p className="mt-9 max-w-2xl text-[11px] font-light leading-relaxed" style={{ color: "var(--text-tertiary)" }}>
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

        <RunComparisonSection />

        <div className="border-t" style={{ borderColor: "var(--border)" }} />

        <section className="scroll-mt-20 py-20 md:py-[5.5rem]" id="docs-preview">
          <SectionHeading
            eyebrow="Docs"
            muted="Keep the landing short."
            title="Put setup and implementation detail where teams expect it."
            body="Quickstart, rollout options, architecture notes, and recovery paths now live in docs so the landing can stay focused on the product promise."
          />

          <SectionGrid columnsClassName="sm:grid-cols-2 lg:grid-cols-4">
            {DOCS_LINKS.map((item) => (
              <SectionLinkCard key={item.title} {...item} />
            ))}
          </SectionGrid>
        </section>

        <div className="border-t" style={{ borderColor: "var(--border)" }} />

        <section className="scroll-mt-20 py-20 md:py-[5.5rem]" id="pricing">
          <SectionHeading
            eyebrow="Pricing"
            muted="Open source now."
            title="Managed launch pricing."
            body="Self-hosted is available today. The startup and enterprise tiers below are planned managed rollout packaging, shown here as draft launch pricing rather than live checkout."
          />

          <PricingGrid />
        </section>

        <div className="border-t" style={{ borderColor: "var(--border)" }} />

        <section className="scroll-mt-20 py-20 md:py-[5.5rem]" id="faq" aria-labelledby="faq-heading">
          <SectionHeading
            eyebrow="FAQ"
            muted="Questions that come up fast."
            title="Answers for buyers, operators, and engineers."
            body="This is the public-facing pass: enough to evaluate the product, without turning the landing into a long technical brief."
          />

          <SectionGrid columnsClassName="lg:grid-cols-2">
            {FAQ_ITEMS.map((item) => (
              <SectionCard
                key={item.question}
                title={item.question}
                body={item.answer}
                minHeightClassName="min-h-[214px] md:min-h-[226px]"
              />
            ))}
          </SectionGrid>
        </section>

        <div className="border-t" style={{ borderColor: "var(--border)" }} />

        <CtaSection />

        <footer
          className="flex flex-col gap-8 border-t py-8 lg:flex-row lg:items-center lg:justify-between lg:gap-10"
          style={{ borderColor: "var(--border)" }}
        >
          <div className="flex min-w-0 flex-col gap-2">
            <span className="text-xs font-light" style={{ color: "var(--text-tertiary)" }}>
              MIT &middot; TraceBase
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

          <nav className="flex flex-wrap items-center gap-x-5 gap-y-2 self-start lg:self-center" aria-label="Footer">
            <a
              href="https://github.com/64envy64/tracebase"
              className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/10 text-[var(--text-tertiary)] transition-colors hover:text-[var(--text)]"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="GitHub repository"
            >
              <GitHubMark className="h-[18px] w-[18px]" />
            </a>
            <Link href="/docs" className="text-xs font-light" style={{ color: "var(--text-tertiary)" }}>
              Docs
            </Link>
            <a
              href="https://www.npmjs.com/package/tracebase-ai"
              className="text-xs font-light"
              style={{ color: "var(--text-tertiary)" }}
              target="_blank"
              rel="noopener noreferrer"
            >
              npm
            </a>
          </nav>
        </footer>
      </main>
    </div>
  );
}
