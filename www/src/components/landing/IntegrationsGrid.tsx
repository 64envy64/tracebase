import Image from "next/image";

type Integration = {
  name: string;
  logo: string;
  width: number;
  height: number;
  logoClassName: string;
};

const INTEGRATIONS: readonly Integration[] = [
  {
    name: "Claude Code",
    logo: "/partners/claudecode.svg",
    width: 144,
    height: 40,
    logoClassName: "h-10 w-auto object-contain md:h-11",
  },
  {
    name: "Cursor",
    logo: "/partners/cursor.png",
    width: 104,
    height: 104,
    logoClassName: "h-12 w-12 object-contain md:h-14 md:w-14",
  },
  {
    name: "Codex",
    logo: "/partners/codex.png",
    width: 120,
    height: 120,
    logoClassName: "h-[3.25rem] w-[3.25rem] object-contain md:h-[3.75rem] md:w-[3.75rem]",
  },
] as const;

function IntegrationCard({ integration }: { integration: Integration }) {
  return (
    <article
      className="flex min-h-[220px] flex-col items-center justify-center gap-6 px-6 py-10 text-center md:min-h-[250px] md:px-8"
      style={{ background: "var(--bg)" }}
    >
      <div
        className="flex h-[5.5rem] w-[5.5rem] items-center justify-center rounded-[24px] border md:h-[6.5rem] md:w-[6.5rem]"
        style={{
          borderColor: "rgba(232,217,184,0.1)",
          background: "rgba(232,217,184,0.04)",
        }}
      >
        <Image
          src={integration.logo}
          alt={`${integration.name} logo`}
          width={integration.width}
          height={integration.height}
          className={integration.logoClassName}
        />
      </div>

      <div>
        <h3 className="text-[1.05rem] font-light tracking-tight md:text-[1.2rem]">{integration.name}</h3>
      </div>
    </article>
  );
}

export function IntegrationsGrid() {
  return (
    <div
      className="overflow-hidden rounded-xl border"
      style={{
        borderColor: "var(--border)",
        background: "var(--ink-deep)",
      }}
    >
      <div className="grid gap-px md:grid-cols-3" style={{ background: "var(--border)" }}>
        {INTEGRATIONS.map((integration) => (
          <IntegrationCard key={integration.name} integration={integration} />
        ))}
      </div>
    </div>
  );
}
