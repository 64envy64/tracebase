import Link from "next/link";
import { type ReactNode } from "react";
import { CtaSection } from "@/components/landing/CtaSection";
import { FAQSection } from "@/components/landing/FAQSection";
import { ForgettingTax } from "@/components/landing/ForgettingTax";
import { HeroInk } from "@/components/landing/HeroInk";
import { LandingNav } from "@/components/landing/LandingNav";
import { PartnersStrip } from "@/components/landing/PartnersStrip";
import { PricingGrid } from "@/components/landing/PricingGrid";
import { RunSplitSection } from "@/components/landing/RunSplitSection";
import { TentacleSection } from "@/components/landing/TentacleSection";
import { UseCasesSection } from "@/components/landing/UseCasesSection";
import { InkInterstitial, TracebaseInkWordmark } from "@/components/landing/brand/Marks";
import { SectionLabel } from "@/components/landing/brand/Primitives";
import { Reveal } from "@/components/landing/brand/Reveal";
import { INK } from "@/components/landing/brand/tokens";
import { GitHubStarButton } from "@/components/ui/GitHubStarButton";

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

/* ============================================================ */
/*  Page                                                          */
/* ============================================================ */

export default function Home() {
  return (
    <div className="min-h-screen" style={{ background: INK.ink }}>
      <LandingNav />

      <HeroInk />

      <PartnersStrip />

      <main style={{ color: INK.bone }}>
        <ForgettingTax />

        <RunSplitSection />

        <TentacleSection />

        <div className="mx-auto max-w-[1080px] px-5 sm:px-6">
          <InkInterstitial label="pricing — open source today" />

          <section id="pricing" className="scroll-mt-20 py-16 md:py-24">
            <Reveal>
              <SectionHeading
                label="pricing"
                muted="Free, open source."
                title={<span>Paid tiers are coming.</span>}
                body="Self-hosted is live under MIT. Hobby / Startup / Enterprise — draft packaging, not on checkout yet."
              />
            </Reveal>
            <Reveal delayMs={120}>
              <PricingGrid />
            </Reveal>
          </section>

          <InkInterstitial label="where this earns its keep" />

          <UseCasesSection />

          <InkInterstitial label="eight answers before you install" />

          <FAQSection />

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
          MIT-licensed · self-hosted · v0.9 · May 2026
        </p>
      </div>

      <nav className="flex flex-wrap items-center gap-x-5 gap-y-2 self-start lg:self-center" aria-label="Footer">
        <GitHubStarButton className="h-9" />
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
