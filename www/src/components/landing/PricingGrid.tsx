type PricingPlan = {
  name: string;
  badge: string;
  price: string;
  subtitle: string;
  features: readonly string[];
  accent: boolean;
  ctaLabel: string;
  ctaStyle: "quiet" | "light";
  ctaHref?: string;
};

const PRICING_PLANS: readonly PricingPlan[] = [
  {
    name: "Open Source",
    badge: "Current",
    price: "$0",
    subtitle: "Available today for self-hosted teams and local workflows.",
    features: [
      "Local SQLite memory",
      "MCP / HTTP / SDK access",
      "Adaptive weight learning",
      "Embeddings with your own API key",
    ],
    accent: false,
    ctaLabel: "Try free",
    ctaStyle: "quiet",
    ctaHref: "#setup",
  },
  {
    name: "Startup",
    badge: "Planned",
    price: "$159/mo",
    subtitle: "Draft launch pricing for a managed tier aimed at small teams.",
    features: [
      "50,000 injections / mo",
      "Unlimited API keys",
      "Unlimited team members",
      "Hosted traces + analytics",
    ],
    accent: true,
    ctaLabel: "Upgrade",
    ctaStyle: "light",
  },
  {
    name: "Enterprise",
    badge: "Planned",
    price: "Custom",
    subtitle: "Design-partner rollout for higher-volume and regulated environments.",
    features: [
      "Unlimited injections",
      "SSO + SAML",
      "Private deployment options",
      "Custom retention + support",
    ],
    accent: false,
    ctaLabel: "Talk to sales",
    ctaStyle: "light",
  },
] as const;

function PricingCtaButton({
  label,
  tone,
  href,
}: {
  label: string;
  tone: PricingPlan["ctaStyle"];
  href?: string;
}) {
  const className =
    "group inline-flex min-h-[60px] w-full items-center justify-center rounded-[20px] border px-5 py-4 text-center transition-[background-color,color,border-color,box-shadow] duration-200 ease-out";

  const style =
    tone === "light"
      ? {
          borderColor: "rgba(237,236,236,0.94)",
          background: "rgba(237,236,236,0.98)",
          color: "var(--bg)",
          boxShadow: "0 16px 34px rgba(0,0,0,0.14)",
        }
      : {
          borderColor: "rgba(255,255,255,0.12)",
          background: "rgba(255,255,255,0.02)",
          color: "rgba(237,236,236,0.82)",
        };

  const roll = (
    <span className="relative flex h-12 w-full max-w-full items-stretch justify-center overflow-hidden">
      <span className="flex w-full flex-col transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:-translate-y-12 motion-reduce:transition-none motion-reduce:group-hover:translate-y-0">
        <span className="flex h-12 shrink-0 items-center justify-center font-mono text-[12px] uppercase tracking-[0.18em]">
          {label}
        </span>
        <span className="flex h-12 shrink-0 items-center justify-center font-mono text-[12px] uppercase tracking-[0.18em]" aria-hidden>
          {label}
        </span>
      </span>
    </span>
  );

  if (href) {
    return (
      <a href={href} className={className} style={style}>
        {roll}
      </a>
    );
  }

  return (
    <button type="button" className={className} style={style}>
      {roll}
    </button>
  );
}

function PricingCard({ plan }: { plan: PricingPlan }) {
  return (
    <article
      className="grid min-h-[680px] grid-rows-[minmax(136px,auto)_minmax(236px,auto)_1fr_auto] p-8 md:p-10"
      style={{ background: "var(--bg)" }}
    >
      <header className="grid min-h-[136px] content-start gap-5">
        <h3 className="font-mono text-[clamp(1.9rem,3vw,2.5rem)] font-medium leading-[0.94] tracking-tight">{plan.name}</h3>
        <div>
          <span
            className="rounded-full border px-3 py-1 text-[10px] font-mono uppercase tracking-[0.16em]"
            style={{
              borderColor: plan.accent ? "rgba(177,255,109,0.18)" : "rgba(255,255,255,0.08)",
              background: plan.accent ? "rgba(177,255,109,0.07)" : "rgba(255,255,255,0.03)",
              color: plan.accent ? "rgba(177,255,109,0.72)" : "rgba(237,236,236,0.52)",
            }}
          >
            {plan.badge}
          </span>
        </div>
      </header>

      <div className="grid min-h-[236px] grid-rows-[minmax(112px,auto)_minmax(96px,auto)] content-start">
        <div className="flex items-start">
          <p className="font-mono text-[clamp(2.65rem,5vw,4.35rem)] leading-[0.88] tracking-[-0.04em]">{plan.price}</p>
        </div>
        <p className="mt-7 max-w-[17rem] text-sm font-light leading-relaxed" style={{ color: "var(--text-secondary)" }}>
          {plan.subtitle}
        </p>
      </div>

      <ul className="mt-10 space-y-4">
        {plan.features.map((feature) => (
          <li
            key={feature}
            className="border-b pb-4 text-[15px] font-light leading-relaxed"
            style={{
              borderColor: "rgba(255,255,255,0.06)",
              color: "rgba(237,236,236,0.72)",
            }}
          >
            {feature}
          </li>
        ))}
      </ul>

      <div className="pt-10">
        <PricingCtaButton label={plan.ctaLabel} tone={plan.ctaStyle} href={plan.ctaHref} />
      </div>
    </article>
  );
}

export function PricingGrid() {
  return (
    <div
      className="overflow-hidden border"
      style={{
        borderColor: "var(--border)",
        background: "rgba(255,255,255,0.02)",
      }}
    >
      <div className="grid gap-px lg:grid-cols-3" style={{ background: "var(--border)" }}>
        {PRICING_PLANS.map((plan) => (
          <PricingCard key={plan.name} plan={plan} />
        ))}
      </div>
    </div>
  );
}
