import { CopyCommand } from "@/components/CopyButton";
import { GetStartedButton } from "@/components/auth/GetStartedButton";

export function HeroWithVideo() {
  return (
    <section
      className="relative flex min-h-[100svh] flex-col justify-center overflow-hidden"
      aria-label="Introduction"
    >
      <video
        className="pointer-events-none absolute inset-0 h-full w-full object-cover"
        autoPlay
        muted
        loop
        playsInline
        preload="metadata"
        aria-hidden
      >
        <source src="/back.mp4" type="video/mp4" />
      </video>

      <div
        className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/38 via-black/22 to-[#0f0e09]/88"
        aria-hidden
      />

      <div className="relative z-10 mx-auto flex w-full max-w-[1080px] flex-col items-center px-6 pb-24 pt-32 text-center sm:pt-36 lg:pb-28 lg:pt-40">
        <div className="max-w-[760px]">
          <h1 className="font-hero-serif text-[clamp(2.2rem,5vw,4.5rem)] font-normal leading-[1.04] tracking-tight text-[#f6f5f4] drop-shadow-[0_1px_24px_rgba(0,0,0,0.35)]">
            Agents that compound
            <br />
            their own intelligence.
          </h1>

          <p
            className="mx-auto mt-6 max-w-[38rem] text-sm font-normal leading-relaxed sm:text-[15px]"
            style={{ color: "rgba(237, 236, 236, 0.78)" }}
          >
            If your models handle the same jobs every day, they should arrive with priors instead of restarting from
            zero. TraceBase adds a self-improving reasoning layer to the LLM pipeline you already run.
          </p>

          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <GetStartedButton size="large" onMedia />
            <CopyCommand command="npx tracebase-ai init" onMedia />
          </div>
        </div>
      </div>
    </section>
  );
}
