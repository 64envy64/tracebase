import Link from "next/link";
import { BenchmarkTease } from "@/components/landing/BenchmarkTease";
import { CtaSection } from "@/components/landing/CtaSection";
import { FAQSection } from "@/components/landing/FAQSection";
import { ForgettingTax } from "@/components/landing/ForgettingTax";
import { HeroInk } from "@/components/landing/HeroInk";
import { LandingNav } from "@/components/landing/LandingNav";
import { PartnersStrip } from "@/components/landing/PartnersStrip";
import { RunSplitSection } from "@/components/landing/RunSplitSection";
import { TentacleSection } from "@/components/landing/TentacleSection";
import { UseCasesSection } from "@/components/landing/UseCasesSection";
import { InkInterstitial, TracebaseInkWordmark } from "@/components/landing/brand/Marks";
import { INK } from "@/components/landing/brand/tokens";
import { GitHubStarButton } from "@/components/ui/GitHubStarButton";

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

        <div className="mx-auto max-w-[1080px] px-5 sm:px-6">
          <BenchmarkTease />
        </div>

        <TentacleSection />

        <div className="mx-auto max-w-[1080px] px-5 sm:px-6">
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
