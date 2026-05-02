import Image from "next/image";
import Link from "next/link";
import { type ReactNode } from "react";
import { CtaSection } from "@/components/landing/CtaSection";
import { ForgettingTax } from "@/components/landing/ForgettingTax";
import { HeroInk } from "@/components/landing/HeroInk";
import { LandingNav } from "@/components/landing/LandingNav";
import { PricingGrid } from "@/components/landing/PricingGrid";
import { RunSplitSection } from "@/components/landing/RunSplitSection";
import { TentacleSection } from "@/components/landing/TentacleSection";
import { InkInterstitial, TracebaseInkWordmark } from "@/components/landing/brand/Marks";
import { SectionLabel } from "@/components/landing/brand/Primitives";
import { Reveal } from "@/components/landing/brand/Reveal";
import { INK } from "@/components/landing/brand/tokens";
import { GitHubMark } from "@/components/ui/GitHubMark";

/* ============================================================ */
/*  Shared layout primitives                                     */
/* ============================================================ */

type SectionHeadingProps = {
  label: string;
  muted: ReactNode;
  title: ReactNode;
  body?: ReactNode;
};

function SectionHeading({ label, muted, title, body }: SectionHeadingProps) {
  return (
    <div className="mb-10 max-w-[44rem] md:mb-12">
      <SectionLabel>{label}</SectionLabel>
      <h2
        className="mt-3 font-hero-serif text-[clamp(1.9rem,4vw,3.2rem)] font-normal leading-[1.04] tracking-tight"
        style={{ color: INK.pearl }}
      >
        <span style={{ color: "rgba(232,217,184,0.48)" }}>{muted}</span> {title}
      </h2>
      {body ? (
        <p
          className="mt-5 max-w-[36rem] text-[14px] font-light leading-relaxed md:text-[15px]"
          style={{ color: "rgba(232,217,184,0.68)" }}
        >
          {body}
        </p>
      ) : null}
    </div>
  );
}

function Grid({ cols, children }: { cols: string; children: ReactNode }) {
  return (
    <div
      className="overflow-hidden rounded-xl border"
      style={{ borderColor: "rgba(232,217,184,0.1)", background: "rgba(232,217,184,0.08)" }}
    >
      <div className={`grid gap-px ${cols}`} style={{ background: "rgba(232,217,184,0.08)" }}>
        {children}
      </div>
    </div>
  );
}

function Tile({
  label,
  title,
  body,
  href,
  cta,
}: {
  label?: string;
  title: string;
  body: string;
  href?: string;
  cta?: string;
}) {
  // h-full + flex-col on the inner div so each cell stretches to the
  // tallest row member. Without this, when one tile's body wraps to
  // an extra line (e.g. Integrations) the surrounding `gap-px` rule
  // shows a visible gap below the shorter tiles — looks like the
  // outline is "missing one stripe".
  const inner = (
    <div
      className="flex h-full min-h-[190px] flex-col justify-between gap-4 p-6 md:min-h-[210px] md:p-7"
      style={{ background: INK.inkDeep }}
    >
      <div>
        {label ? <SectionLabel className="mb-4">{label}</SectionLabel> : null}
        <h3
          className="text-[15.5px] font-medium tracking-tight md:text-[16.5px]"
          style={{ color: href ? INK.bone : INK.pearl }}
        >
          {title}
        </h3>
      </div>
      <p
        className="max-w-[28rem] text-[13px] font-light leading-relaxed"
        style={{ color: "rgba(232,217,184,0.64)" }}
      >
        {body}
      </p>
      {cta ? (
        <SectionLabel>
          <span style={{ color: INK.ember }}>{cta} →</span>
        </SectionLabel>
      ) : null}
    </div>
  );
  if (href) {
    return (
      <Link
        href={href}
        // block + h-full make the Link a proper grid-cell-filling box;
        // without it the cell collapses to content height and the
        // bottom border of the rounded outline sits above the
        // tallest tile's content.
        className="group block h-full transition-colors hover:bg-[rgba(232,217,184,0.02)]"
      >
        {inner}
      </Link>
    );
  }
  return <article className="h-full">{inner}</article>;
}

/* ============================================================ */
/*  Content — docs links & FAQ                                   */
/* ============================================================ */

const DOCS_LINKS = [
  {
    title: "Quickstart",
    body: "Install, point at a project, and verify the runtime attaches to your agent surface.",
    href: "/docs#quickstart",
  },
  {
    title: "Integrations",
    body: "MCP for IDE agents, SDK middleware for wrapped clients, service boundary for custom runtimes.",
    href: "/docs#integrations",
  },
  {
    title: "Architecture",
    body: "Capture, retrieval, supervision, compression — how the five arms share one store.",
    href: "/docs#architecture",
  },
  {
    title: "Troubleshooting",
    body: "First checks when retrieval, tooling, or the local store looks wrong in a live workspace.",
    href: "/docs#troubleshooting",
  },
] as const;

const FAQ = [
  {
    q: "What failure mode does tracebase.ink actually catch?",
    a: "Five of them. Repeat reasoning, forgotten file meaning, doom-loops, redundant tool calls, and context-window thrashing on long horizons.",
  },
  {
    q: "Do we have to move to a hosted runtime?",
    a: "No. Self-hosted by default, project-scoped storage, no cloud dependency.",
  },
  {
    q: "Does this expose internal chain-of-thought?",
    a: "No. The ink stores resolved traces and operator signals — not raw deliberation.",
  },
  {
    q: "Where does it sit in the stack?",
    a: "Between the agent and its tools. MCP for tool-driven agents, middleware for wrapped SDK clients, boundary for custom runtimes.",
  },
  {
    q: "When is the payoff largest?",
    a: "Repeat incidents, migrations, debugging loops — any workflow where the nth run should beat the first.",
  },
  {
    q: "Why move setup detail into docs?",
    a: "Landing sells the promise. Docs carry the mechanics. Different jobs, different places.",
  },
] as const;

/* ============================================================ */
/*  Page                                                          */
/* ============================================================ */

export default function Home() {
  return (
    <div className="min-h-screen" style={{ background: INK.ink }}>
      <LandingNav />

      <HeroInk />

      <main style={{ color: INK.bone }}>
        <ForgettingTax />

        <RunSplitSection />

        <TentacleSection />

        <div className="mx-auto max-w-[1080px] px-5 sm:px-6">
          <InkInterstitial label="the mechanics live in docs" />

          <section id="docs-preview" className="scroll-mt-20 py-16 md:py-24">
            <Reveal>
              <SectionHeading
                label="docs"
                muted="Keep the landing short."
                title={<span>Mechanics live where teams return to them.</span>}
                body="Quickstart, rollouts, architecture, and recovery paths live in docs — the landing stays focused on the runtime."
              />
            </Reveal>
            <Reveal delayMs={120}>
              <Grid cols="sm:grid-cols-2 lg:grid-cols-4">
                {DOCS_LINKS.map((d) => (
                  <Tile key={d.title} label="docs" title={d.title} body={d.body} href={d.href} cta="Open section" />
                ))}
              </Grid>
            </Reveal>
          </section>

          <InkInterstitial label="pricing · open source today" />

          <section id="pricing" className="scroll-mt-20 py-16 md:py-24">
            <Reveal>
              <SectionHeading
                label="pricing"
                muted="Open source today."
                title={<span>Managed tiers planned for launch.</span>}
                body="Self-hosted is available now. Startup and enterprise tiers below are draft launch packaging — not live checkout."
              />
            </Reveal>
            <Reveal delayMs={120}>
              <PricingGrid />
            </Reveal>
          </section>

          <InkInterstitial label="questions, short answers" />

          <section id="faq" className="scroll-mt-20 py-16 md:py-24" aria-labelledby="faq-heading">
            <Reveal>
              <SectionHeading
                label="faq"
                muted="Common questions."
                title={<span>Short answers for buyers and operators.</span>}
              />
            </Reveal>
            <Reveal delayMs={120}>
              <Grid cols="md:grid-cols-2">
                {FAQ.map((f) => (
                  <Tile key={f.q} title={f.q} body={f.a} />
                ))}
              </Grid>
            </Reveal>
          </section>

          <InkInterstitial label="pick up the pen" />

          <CtaSection />

          <Footer />
        </div>
      </main>
    </div>
  );
}

function Footer() {
  return (
    <footer
      className="flex flex-col gap-8 border-t py-10 lg:flex-row lg:items-center lg:justify-between lg:gap-10"
      style={{ borderColor: "rgba(232,217,184,0.08)" }}
    >
      <div className="flex min-w-0 flex-col gap-3">
        <TracebaseInkWordmark size={14} />
        <p
          className="max-w-sm text-[11px] font-light leading-relaxed"
          style={{ color: INK.sand }}
        >
          MIT. Part of the{" "}
          <a
            href="https://www.daytona.io/startups"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2"
            style={{ color: INK.bone, textDecorationColor: "rgba(232,217,184,0.22)" }}
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
        className="shrink-0 self-start opacity-80 transition-opacity hover:opacity-100 lg:self-center"
        aria-label="Daytona Startup Grid"
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
          className="inline-flex h-9 w-9 items-center justify-center rounded-full border transition-colors hover:text-[var(--bone)]"
          style={{ borderColor: "rgba(232,217,184,0.12)", color: INK.sand }}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="GitHub repository"
        >
          <GitHubMark className="h-[18px] w-[18px]" />
        </a>
        <Link href="/docs" className="text-xs font-light" style={{ color: INK.sand }}>
          Docs
        </Link>
        <a
          href="https://www.npmjs.com/package/tracebase-ai"
          className="text-xs font-light"
          style={{ color: INK.sand }}
          target="_blank"
          rel="noopener noreferrer"
        >
          npm
        </a>
      </nav>
    </footer>
  );
}
