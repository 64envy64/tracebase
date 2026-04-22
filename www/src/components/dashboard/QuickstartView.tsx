import { CopyCommand } from "@/components/CopyButton";

type AgentId = "claude-code" | "cursor" | "codex";

type AgentCard = {
  id: AgentId;
  label: string;
  surface: string;
  steps: string[];
};

const INSTALL_COMMAND = "npx tracebase init";

const AGENT_CARDS: readonly AgentCard[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    surface: ".claude/settings.json + CLAUDE.md",
    steps: [
      "Run the command above in your project root.",
      "Restart Claude Code.",
      "Run /tools and confirm get_reasoning_patterns is listed.",
    ],
  },
  {
    id: "cursor",
    label: "Cursor",
    surface: "~/.cursor/mcp.json + AGENTS.md",
    steps: [
      "Run the command above, pick Cursor.",
      "Restart Cursor.",
      "Cursor Settings → MCP → confirm tracebase is healthy.",
    ],
  },
  {
    id: "codex",
    label: "Codex",
    surface: "codex mcp registry + AGENTS.md",
    steps: [
      "Run the command above, pick Codex.",
      "Start a fresh Codex session in the project.",
      "Run `codex mcp list` and confirm tracebase is registered.",
    ],
  },
] as const;

export function QuickstartView() {
  return (
    <section className="space-y-4" aria-label="Quickstart">
      <header className="flex flex-col gap-1.5">
        <p
          className="text-[10px] font-mono uppercase tracking-[0.22em]"
          style={{ color: "var(--text-tertiary)" }}
        >
          Quickstart
        </p>
        <h1 className="text-[1.5rem] font-light tracking-[-0.02em] md:text-[1.7rem]">
          Install in under 2 minutes.
        </h1>
        <p
          className="max-w-[44rem] text-[13px] font-light leading-relaxed"
          style={{ color: "var(--text-secondary)" }}
        >
          One command, pick your adapter. Re-run any time — everything is safe to remove with{" "}
          <code className="font-mono">npx tracebase remove --keep-store</code>.
        </p>
      </header>

      <CustomIntegrationCta />

      <div className="grid gap-3">
        {AGENT_CARDS.map((card) => (
          <AgentInstallCard key={card.id} card={card} />
        ))}
      </div>
    </section>
  );
}

function CustomIntegrationCta() {
  return (
    <article
      className="flex flex-col justify-between gap-3 rounded-sm border p-4 md:flex-row md:items-center md:gap-6 md:p-5"
      style={{
        borderColor: "var(--border)",
        background: "linear-gradient(180deg, rgba(255,255,255,0.015) 0%, rgba(255,255,255,0) 100%)",
      }}
    >
      <div className="max-w-[42rem]">
        <p
          className="text-[10px] font-mono uppercase tracking-[0.18em]"
          style={{ color: "var(--text-tertiary)" }}
        >
          Custom integration
        </p>
        <p className="mt-2 text-[0.98rem] font-normal tracking-tight">
          Building your own agent framework or need a custom setup?
        </p>
        <p className="mt-2 text-[13px] font-light" style={{ color: "var(--text-secondary)" }}>
          SDK is on npm as <code className="font-mono">tracebase-ai</code>. The MCP server is one reference
          integration — wire the library in directly when you need a tighter fit.
        </p>
      </div>
      <a
        href="https://github.com/64envy64/tracebase"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex shrink-0 items-center gap-2 rounded-sm border px-4 py-2 text-[12px] font-medium tracking-[0.02em] transition-colors"
        style={{
          borderColor: "var(--text)",
          background: "var(--text)",
          color: "var(--bg)",
        }}
      >
        Read the docs
        <span aria-hidden>↗</span>
      </a>
    </article>
  );
}

function AgentInstallCard({ card }: { card: AgentCard }) {
  return (
    <article
      className="rounded-sm border"
      style={{ borderColor: "var(--border)", background: "var(--bg)" }}
    >
      <header
        className="flex items-start justify-between gap-4 border-b px-4 py-4 md:px-5"
        style={{ borderColor: "var(--border)", background: "var(--surface)" }}
      >
        <h3 className="text-[0.98rem] font-medium tracking-tight">{card.label}</h3>
        <span
          className="shrink-0 rounded-sm border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.18em]"
          style={{ borderColor: "var(--border)", color: "var(--text-tertiary)" }}
        >
          {card.surface}
        </span>
      </header>

      <div className="space-y-4 p-4 md:p-5">
        <div className="flex flex-col gap-2">
          <p
            className="text-[10px] font-mono uppercase tracking-[0.22em]"
            style={{ color: "var(--text-tertiary)" }}
          >
            Install
          </p>
          <CopyCommand command={INSTALL_COMMAND} />
        </div>

        <ol className="flex flex-col gap-2.5">
          {card.steps.map((step, index) => (
            <li
              key={step}
              className="flex gap-3 text-[13px] font-light leading-relaxed"
              style={{ color: "var(--text-secondary)" }}
            >
              <span
                className="mt-[1px] inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm border font-mono text-[10px]"
                style={{ borderColor: "var(--border)", color: "var(--text-tertiary)" }}
              >
                {index + 1}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      </div>
    </article>
  );
}
