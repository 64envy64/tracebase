"use client";

import { startTransition, useDeferredValue, useEffect, useRef, useState } from "react";
import { AnimatedButtonLabel } from "@/components/ui/AnimatedButtonLabel";

type BillingMode = "monthly" | "annual";

type PricingPlan = {
  name: string;
  badge: string;
  monthlyPrice: number | null;
  annualMonthlyPrice: number | null;
  annualSavings: string | null;
  monthlySubtitle: string;
  annualSubtitle: string;
  features: readonly string[];
  accent: boolean;
  ctaLabel: string;
  ctaStyle: "quiet" | "light";
  ctaArrow?: boolean;
  ctaHref?: string;
};

const CALENDLY_URL = "https://calendly.com/a-sarzhigitov07/30min";

const PRICING_PLANS: readonly PricingPlan[] = [
  {
    name: "Open Source",
    badge: "Available now",
    monthlyPrice: 0,
    annualMonthlyPrice: 0,
    annualSavings: null,
    monthlySubtitle: "Self-hosted memory, MCP, SDK middleware, and local SQLite storage.",
    annualSubtitle: "Self-hosted memory, MCP, SDK middleware, and local SQLite storage.",
    features: [
      "Local SQLite memory",
      "MCP / HTTP / SDK access",
      "Adaptive weight learning",
      "Embeddings with your own API key",
    ],
    accent: false,
    ctaLabel: "Try free",
    ctaStyle: "quiet",
    ctaArrow: true,
    ctaHref: "/docs#quickstart",
  },
  {
    name: "Startup",
    badge: "Managed tier",
    monthlyPrice: 159,
    annualMonthlyPrice: 149,
    annualSavings: "Save $120 / year",
    monthlySubtitle: "Managed traces, analytics, and team access for small product teams shipping weekly.",
    annualSubtitle: "Same managed tier with a modest annual discount for teams committing to a yearly rollout.",
    features: [
      "50,000 injections / mo",
      "Unlimited API keys",
      "Unlimited team members",
      "Hosted traces + analytics",
    ],
    accent: true,
    ctaLabel: "Upgrade",
    ctaStyle: "light",
    ctaArrow: true,
    ctaHref: CALENDLY_URL,
  },
  {
    name: "Enterprise",
    badge: "Custom rollout",
    monthlyPrice: null,
    annualMonthlyPrice: null,
    annualSavings: null,
    monthlySubtitle: "Private deployment, SSO, and support for higher-volume or regulated environments.",
    annualSubtitle: "Private deployment, SSO, and support for higher-volume or regulated environments.",
    features: [
      "Unlimited injections",
      "SSO + SAML",
      "Private deployment options",
      "Custom retention + support",
    ],
    accent: false,
    ctaLabel: "Talk to us",
    ctaStyle: "light",
    ctaArrow: false,
    ctaHref: CALENDLY_URL,
  },
] as const;

function PricingCtaButton({
  label,
  tone,
  showArrow = false,
  href,
}: {
  label: string;
  tone: PricingPlan["ctaStyle"];
  showArrow?: boolean;
  href?: string;
}) {
  const className = [
    "group inline-flex min-h-[52px] w-full items-center justify-center rounded-[18px] border px-5 py-4 text-center text-[13px] font-semibold tracking-tight transition-[background-color,color,border-color,box-shadow,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] hover:-translate-y-px focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]",
    tone === "light"
      ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--ink-deep)] shadow-[0_18px_38px_rgba(0,0,0,0.18)] hover:border-[var(--accent-hover)] hover:bg-[var(--accent-hover)]"
      : "text-[var(--text)] border-[rgba(232,217,184,0.12)] bg-[rgba(232,217,184,0.04)] hover:border-[rgba(232,217,184,0.2)] hover:bg-[rgba(232,217,184,0.07)]",
  ].join(" ");

  if (href) {
    return (
      <a
        href={href}
        className={className}
        target={href.startsWith("http") ? "_blank" : undefined}
        rel={href.startsWith("http") ? "noopener noreferrer" : undefined}
      >
        <AnimatedButtonLabel label={label} showArrow={showArrow} />
      </a>
    );
  }

  return (
    <button type="button" className={className}>
      <AnimatedButtonLabel label={label} showArrow={showArrow} />
    </button>
  );
}

function useAnimatedNumber(target: number) {
  const [display, setDisplay] = useState(target);
  const [reducedMotion, setReducedMotion] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia("(prefers-reduced-motion: reduce)").matches : false,
  );
  const currentValueRef = useRef(target);

  useEffect(() => {
    currentValueRef.current = display;
  }, [display]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReducedMotion(media.matches);

    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (reducedMotion) {
      currentValueRef.current = target;
      return;
    }

    const from = currentValueRef.current;
    if (from === target) return;

    const start = performance.now();
    const duration = 420;
    let frame = 0;

    const tick = (now: number) => {
      const progress = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const next = from + (target - from) * eased;
      currentValueRef.current = next;
      setDisplay(next);

      if (progress < 1) {
        frame = window.requestAnimationFrame(tick);
        return;
      }

      currentValueRef.current = target;
    };

    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [target, reducedMotion]);

  return reducedMotion ? target : display;
}

function AnimatedPriceValue({
  amount,
  suffix,
}: {
  amount: number | null;
  suffix: string;
}) {
  const animated = useAnimatedNumber(amount ?? 0);
  const rounded = Math.round(animated);

  if (amount === null) {
    return <span className="font-mono text-[clamp(2.65rem,5vw,4.35rem)] leading-[0.88] tracking-[-0.04em]">Custom</span>;
  }

  return (
    <span className="flex items-end gap-2">
      <span className="font-mono text-[clamp(2.65rem,5vw,4.35rem)] leading-[0.88] tracking-[-0.04em] tabular-nums">${rounded}</span>
      <span className="pb-2 text-sm font-light" style={{ color: "var(--text-secondary)" }}>
        {suffix}
      </span>
    </span>
  );
}

function PricingCard({
  plan,
  billing,
}: {
  plan: PricingPlan;
  billing: BillingMode;
}) {
  const amount = billing === "annual" ? plan.annualMonthlyPrice : plan.monthlyPrice;
  const subtitle = billing === "annual" ? plan.annualSubtitle : plan.monthlySubtitle;
  const showSavings = billing === "annual" && plan.annualSavings;

  return (
    <article
      className="grid min-h-[640px] grid-rows-[minmax(132px,auto)_minmax(208px,auto)_1fr_auto] p-8 md:p-10"
      style={{ background: "var(--bg)" }}
    >
      <header className="grid min-h-[132px] content-start gap-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h3 className="font-mono text-[clamp(1.9rem,3vw,2.5rem)] font-medium leading-[0.94] tracking-tight">{plan.name}</h3>
          {showSavings ? (
            <span
              className="rounded-full border px-3 py-1 text-[10px] font-mono uppercase tracking-[0.16em]"
              style={{
                borderColor: "var(--accent)",
                background: "rgb(var(--accent-rgb) / 0.14)",
                color: "var(--accent)",
              }}
            >
              {plan.annualSavings}
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <span
            className="rounded-full border px-3 py-1 text-[10px] font-mono uppercase tracking-[0.16em]"
            style={{
              borderColor: plan.accent ? "var(--accent)" : "rgba(232,217,184,0.14)",
              background: plan.accent ? "var(--accent)" : "rgba(232,217,184,0.04)",
              color: plan.accent ? "var(--accent-ink)" : "var(--text)",
            }}
          >
            {plan.badge}
          </span>
        </div>
      </header>

      <div className="grid min-h-[208px] grid-rows-[minmax(96px,auto)_minmax(96px,auto)] content-start">
        <div className="flex items-start">
          <AnimatedPriceValue amount={amount} suffix={billing === "annual" ? "/mo billed yearly" : "/mo"} />
        </div>
        <div className="mt-7 space-y-2">
          <p className="max-w-[18rem] text-sm font-light leading-relaxed" style={{ color: "var(--text-secondary)" }}>
            {subtitle}
          </p>
          {billing === "annual" && plan.annualMonthlyPrice !== null && plan.monthlyPrice !== null && plan.annualMonthlyPrice !== plan.monthlyPrice ? (
            <p className="text-[11px] font-light leading-relaxed" style={{ color: "var(--text-tertiary)" }}>
              Billed as ${plan.annualMonthlyPrice * 12} / year.
            </p>
          ) : null}
        </div>
      </div>

      <ul className="mt-10 space-y-4">
        {plan.features.map((feature) => (
          <li
            key={feature}
            className="border-b pb-4 text-[15px] font-light leading-relaxed"
            style={{
              borderColor: "rgba(232,217,184,0.08)",
              color: "var(--text-secondary)",
            }}
          >
            {feature}
          </li>
        ))}
      </ul>

      <div className="pt-10">
        <PricingCtaButton label={plan.ctaLabel} tone={plan.ctaStyle} showArrow={plan.ctaArrow} href={plan.ctaHref} />
      </div>
    </article>
  );
}

export function PricingGrid() {
  const [billing, setBilling] = useState<BillingMode>("monthly");
  const deferredBilling = useDeferredValue(billing);

  const setMode = (next: BillingMode) => {
    startTransition(() => {
      setBilling(next);
    });
  };

  return (
    <div
      className="overflow-hidden rounded-xl border"
      style={{
        borderColor: "var(--border)",
        background: "rgba(232,217,184,0.02)",
      }}
    >
      <div className="border-b px-6 py-6 md:px-8" style={{ borderColor: "var(--border)", background: "var(--bg)" }}>
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-sm font-medium tracking-tight">Choose billing cadence</p>
            <p className="mt-1 text-[13px] font-light" style={{ color: "var(--text-secondary)" }}>
              Annual keeps pricing a little lower for teams committing to a production rollout.
            </p>
          </div>

          <div
            className="relative inline-grid h-12 min-w-[258px] grid-cols-2 rounded-full border p-[3px]"
            style={{ borderColor: "rgba(232,217,184,0.12)", background: "var(--ink-deep)" }}
            role="tablist"
            aria-label="Billing cadence"
          >
            <span
              className="absolute left-[3px] top-[3px] h-[calc(100%-6px)] w-[calc(50%-3px)] rounded-full border transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
              style={{
                transform: billing === "monthly" ? "translateX(0)" : "translateX(100%)",
                borderColor: "var(--accent)",
                background: "var(--accent)",
              }}
              aria-hidden
            />
            {(["monthly", "annual"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                role="tab"
                aria-selected={billing === mode}
                onClick={() => setMode(mode)}
                className="relative z-10 flex h-10 items-center justify-center rounded-full px-6 text-sm font-semibold tracking-tight transition-colors"
                style={{
                  color: billing === mode ? "var(--accent-ink)" : "var(--text-secondary)",
                }}
              >
                {mode === "monthly" ? "Monthly" : "Annual"}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="grid gap-px lg:grid-cols-3" style={{ background: "var(--border)" }}>
        {PRICING_PLANS.map((plan) => (
          <PricingCard key={plan.name} plan={plan} billing={deferredBilling} />
        ))}
      </div>
    </div>
  );
}
