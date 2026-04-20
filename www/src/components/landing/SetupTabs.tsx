"use client";

import { type FocusEvent, useEffect, useState } from "react";

const AUTO_ADVANCE_MS = 4800;

type SetupMethod = {
  id: string;
  eyebrow: string;
  title: string;
  desc: string;
  previewLabel: string;
  preview: string;
  steps: string[];
  highlightedStep: string;
  sideKicker: string;
  sideTitle: string;
  sideDesc: string;
  cards: Array<{ title: string; desc: string }>;
  tabLabel: string;
  tabSummary: string;
  icon: "sdk" | "command" | "direct";
};

const SETUP_METHODS: readonly SetupMethod[] = [
  {
    id: "sdk",
    eyebrow: "OpenAI / Anthropic",
    title: "SDK Middleware",
    desc: "Wrap the client once and let recall run before each call while store captures the resolved path after completion.",
    previewLabel: "agent.ts",
    preview: `const layer = new ReasoningLayer()
const openai = wrapOpenAI(new OpenAI(), layer)
await openai.chat.completions.create(...)`,
    steps: ["recall", "inject", "call", "store"],
    highlightedStep: "inject",
    sideKicker: "Best default",
    sideTitle: "Wrap once. Keep it automatic.",
    sideDesc: "The cleanest setup for teams already shipping on OpenAI or Anthropic clients.",
    cards: [
      {
        title: "Recall before the call",
        desc: "Find related traces before the model spends tokens exploring.",
      },
      {
        title: "Inject on strong matches",
        desc: "Only add prior context when the match is useful enough to ground the answer.",
      },
      {
        title: "Store the resolved path",
        desc: "Successful runs become part of memory for the next repeat case.",
      },
    ],
    tabLabel: "SDK Middleware",
    tabSummary: "Best default for teams already running on wrapped OpenAI or Anthropic clients.",
    icon: "sdk",
  },
  {
    id: "command",
    eyebrow: "MCP / IDE rollout",
    title: "One command",
    desc: "Auto-configure Claude Code, Cursor, Windsurf, and other MCP clients without hand-editing config files.",
    previewLabel: "terminal",
    preview: `$ npx tracebase-ai setup
tracebase -> Claude Code
tracebase -> Cursor
recall/store -> enabled`,
    steps: ["detect", "configure", "recall", "store"],
    highlightedStep: "configure",
    sideKicker: "Fastest rollout",
    sideTitle: "Ready across your IDE stack.",
    sideDesc: "Best when you want the memory layer available across tools without touching config by hand.",
    cards: [
      {
        title: "Auto-detect installed clients",
        desc: "Picks up supported MCP-capable IDEs on the machine.",
      },
      {
        title: "Wire in recall + store",
        desc: "Adds the two tools where the agent actually needs them.",
      },
      {
        title: "No config drift",
        desc: "Keeps rollout simple when multiple developers need the same setup.",
      },
    ],
    tabLabel: "One command",
    tabSummary: "The fastest path when the same memory layer needs to land across multiple IDEs.",
    icon: "command",
  },
  {
    id: "direct",
    eyebrow: "Custom agents",
    title: "Direct SDK",
    desc: "Call `storeTrace`, `recall`, and `feedback` directly when you need full control over orchestration and scoring.",
    previewLabel: "custom.ts",
    preview: `layer.storeTrace(...)
const hits = layer.recall(...)
layer.feedback(hits[0].trace.id, true)`,
    steps: ["store", "recall", "feedback", "control"],
    highlightedStep: "control",
    sideKicker: "Full control",
    sideTitle: "Place memory exactly where it matters.",
    sideDesc: "Use this path when retrieval should be explicit and fit a custom orchestration layer.",
    cards: [
      {
        title: "Decide when to store",
        desc: "Capture only the runs you actually want to keep in memory.",
      },
      {
        title: "Recall selectively",
        desc: "Query traces only around the turns where context helps.",
      },
      {
        title: "Tune with feedback",
        desc: "Refine ranking quality over time from real outcomes in your workflow.",
      },
    ],
    tabLabel: "Direct SDK",
    tabSummary: "Use this when retrieval should fit a custom orchestration layer instead of middleware.",
    icon: "direct",
  },
] as const;

function TabIcon({ kind }: { kind: SetupMethod["icon"] }) {
  const commonProps = {
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    fill: "none",
  };

  if (kind === "sdk") {
    return (
      <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden>
        <rect x="4.5" y="4.5" width="7" height="7" rx="2" {...commonProps} />
        <rect x="12.5" y="12.5" width="7" height="7" rx="2" {...commonProps} />
        <path d="M11.5 8h2.2a2 2 0 0 1 2 2v2.5" {...commonProps} />
        <path d="M8 11.5v2.2a2 2 0 0 0 2 2h2.5" {...commonProps} />
      </svg>
    );
  }

  if (kind === "command") {
    return (
      <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden>
        <rect x="3.5" y="5" width="17" height="14" rx="3" {...commonProps} />
        <path d="m8 10 2.5 2L8 14.5" {...commonProps} />
        <path d="M13 15h3.5" {...commonProps} />
      </svg>
    );
  }

  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden>
      <path d="M8 6H6v12h2" {...commonProps} />
      <path d="M16 6h2v12h-2" {...commonProps} />
      <path d="M10 9h4" {...commonProps} />
      <path d="M10 12h6" {...commonProps} />
      <path d="M10 15h3" {...commonProps} />
    </svg>
  );
}

function SetupStepPill({ label, active }: { label: string; active: boolean }) {
  return (
    <span
      className="inline-flex items-center py-1 text-[11px] font-semibold uppercase tracking-[0.18em]"
      style={{
        color: active ? "rgba(177,255,109,0.76)" : "rgba(237,236,236,0.42)",
      }}
    >
      {label}
    </span>
  );
}

function SetupInfoCard({ title, desc }: { title: string; desc: string }) {
  return (
    <div
      className="rounded-[18px] border px-5 py-5"
      style={{
        borderColor: "rgba(255,255,255,0.07)",
        background: "rgba(255,255,255,0.012)",
      }}
    >
      <p className="text-[15px] font-semibold tracking-tight" style={{ color: "rgba(237,236,236,0.9)" }}>
        {title}
      </p>
      <p className="mt-2.5 text-sm font-light leading-relaxed" style={{ color: "var(--text-secondary)" }}>
        {desc}
      </p>
    </div>
  );
}

function SetupPreviewFrame({
  label,
  code,
}: {
  label: string;
  code: string;
}) {
  return (
    <div
      className="mt-8 rounded-[28px] border p-5 md:min-h-[310px] md:p-6"
      style={{
        borderColor: "rgba(255,255,255,0.08)",
        background: "rgba(255,255,255,0.018)",
      }}
    >
      <div className="flex items-center gap-2">
        <span className="h-2.5 w-2.5 rounded-full bg-[#ef7b63]" aria-hidden />
        <span className="h-2.5 w-2.5 rounded-full bg-[#eac45a]" aria-hidden />
        <span className="h-2.5 w-2.5 rounded-full bg-[#8fd06d]" aria-hidden />
        <span className="ml-auto text-[10px] font-mono uppercase tracking-[0.18em]" style={{ color: "var(--text-tertiary)" }}>
          {label}
        </span>
      </div>

      <pre
        className="mt-6 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-7 md:text-[13px]"
        style={{ color: "rgba(237,236,236,0.84)" }}
      >
        {code}
      </pre>
    </div>
  );
}

function SetupTabCard({
  method,
  active,
  paused,
  reducedMotion,
  onClick,
}: {
  method: SetupMethod;
  active: boolean;
  paused: boolean;
  reducedMotion: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className="relative flex min-h-[172px] flex-col items-start p-5 text-left md:min-h-[188px] md:p-6"
      style={{
        background: active ? "rgba(255,255,255,0.045)" : "var(--bg)",
        color: active ? "var(--text)" : "rgba(237,236,236,0.84)",
      }}
    >
      <span className="absolute inset-x-0 top-0 h-px bg-white/[0.04]" aria-hidden />
      {active ? (
        <span
          key={method.id}
          className="setup-tab-progress absolute inset-x-0 top-0 h-px"
          style={{
            background: "linear-gradient(90deg, rgba(177,255,109,0.85) 0%, rgba(177,255,109,0.35) 100%)",
            animationDuration: `${AUTO_ADVANCE_MS}ms`,
            animationPlayState: paused || reducedMotion ? "paused" : "running",
          }}
          aria-hidden
        />
      ) : null}

      <span
        className="inline-flex h-11 w-11 items-center justify-center rounded-[15px] border md:h-12 md:w-12 md:rounded-[16px]"
        style={{
          borderColor: active ? "rgba(177,255,109,0.16)" : "rgba(255,255,255,0.08)",
          background: active ? "rgba(177,255,109,0.06)" : "rgba(255,255,255,0.02)",
          color: active ? "rgba(177,255,109,0.78)" : "rgba(237,236,236,0.66)",
        }}
      >
        <TabIcon kind={method.icon} />
      </span>

      <span className="mt-7 text-[clamp(1.45rem,2vw,2rem)] font-light tracking-tight">{method.tabLabel}</span>
      <span className="mt-3 max-w-sm text-sm font-light leading-relaxed" style={{ color: active ? "rgba(237,236,236,0.68)" : "var(--text-secondary)" }}>
        {method.tabSummary}
      </span>
    </button>
  );
}

export function SetupTabs() {
  const [activeIndex, setActiveIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReducedMotion(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (paused || reducedMotion) return;
    const timer = window.setTimeout(() => {
      setActiveIndex((index) => (index + 1) % SETUP_METHODS.length);
    }, AUTO_ADVANCE_MS);
    return () => window.clearTimeout(timer);
  }, [activeIndex, paused, reducedMotion]);

  const activeMethod = SETUP_METHODS[activeIndex] ?? SETUP_METHODS[0];

  const handleBlurCapture = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setPaused(false);
    }
  };

  return (
    <div
      className="overflow-hidden border"
      style={{
        borderColor: "var(--border)",
        background: "rgba(255,255,255,0.02)",
      }}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={handleBlurCapture}
    >
      <div
        className="grid gap-px lg:min-h-[760px] lg:grid-cols-[minmax(0,1.08fr)_minmax(0,0.92fr)]"
        style={{ background: "var(--border)" }}
      >
        <div className="min-h-[430px] p-6 md:min-h-[520px] md:p-8 xl:p-10" style={{ background: "var(--bg)" }}>
          <div key={activeMethod.id} className="hero-toast-in flex h-full flex-col">
            <p className="text-[10px] font-mono uppercase tracking-[0.18em]" style={{ color: "var(--text-tertiary)" }}>
              {activeMethod.eyebrow}
            </p>

            <div className="mt-6 flex flex-wrap gap-2">
              {activeMethod.steps.map((step) => (
                <SetupStepPill key={step} label={step} active={step === activeMethod.highlightedStep} />
              ))}
            </div>

            <h3 className="mt-6 text-[clamp(2rem,4vw,3.1rem)] font-light tracking-tight">{activeMethod.title}</h3>
            <p className="mt-4 max-w-2xl text-sm font-light leading-relaxed md:text-[15px]" style={{ color: "var(--text-secondary)" }}>
              {activeMethod.desc}
            </p>

            <SetupPreviewFrame label={activeMethod.previewLabel} code={activeMethod.preview} />
          </div>
        </div>

        <aside className="min-h-[390px] p-6 md:min-h-[520px] md:p-8 xl:p-10" style={{ background: "var(--bg)" }}>
          <div key={`aside-${activeMethod.id}`} className="hero-toast-in flex h-full flex-col">
            <p className="text-[10px] font-mono uppercase tracking-[0.18em]" style={{ color: "var(--text-tertiary)" }}>
              {activeMethod.sideKicker}
            </p>
            <h4 className="mt-5 max-w-sm text-[clamp(1.75rem,3.2vw,2.45rem)] font-light tracking-tight">
              {activeMethod.sideTitle}
            </h4>
            <p className="mt-4 max-w-md text-sm font-light leading-relaxed md:text-[15px]" style={{ color: "var(--text-secondary)" }}>
              {activeMethod.sideDesc}
            </p>

            <div className="mt-8 grid flex-1 gap-3 md:grid-rows-3">
              {activeMethod.cards.map((card) => (
                <SetupInfoCard key={card.title} title={card.title} desc={card.desc} />
              ))}
            </div>
          </div>
        </aside>
      </div>

      <div className="grid gap-px md:grid-cols-3" style={{ background: "var(--border)" }} role="tablist" aria-label="Three ways to use TraceBase">
        {SETUP_METHODS.map((method, index) => (
          <SetupTabCard
            key={method.id}
            method={method}
            active={index === activeIndex}
            paused={paused}
            reducedMotion={reducedMotion}
            onClick={() => setActiveIndex(index)}
          />
        ))}
      </div>
    </div>
  );
}
