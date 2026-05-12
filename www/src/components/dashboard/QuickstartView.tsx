import { CopyCommand } from "@/components/CopyButton";
import { PageHeader } from "@/components/dashboard/primitives/PageHeader";
import { ActionPill, PrimaryButton } from "@/components/dashboard/primitives/Buttons";
import { CardHeaderRow, SectionCard } from "@/components/dashboard/primitives/SectionCard";
import {
  IconAgent,
  IconArrowUpRight,
  IconChart,
  IconRocket,
} from "@/components/dashboard/primitives/Icons";

type AgentId = "claude-code" | "cursor" | "codex";

type AgentCard = {
  id: AgentId;
  label: string;
  surface: string;
  steps: string[];
};

const INSTALL_COMMAND = "npx tracebase-ai init";

/**
 * Quickstart — three identical install cards, one per supported
 * agent. The card body is the install command + a numbered step list;
 * the surface (config file paths) lives in the header meta strip so
 * it's visible without expanding anything. Same `SectionCard`
 * primitive as the Overview's recent-activity rows, so the dashboard
 * reads as one product.
 */
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
    <section className="space-y-7" aria-label="Quickstart">
      <PageHeader
        title="Quickstart"
        subtitle="Pick an adapter. One command per project."
        actions={
          <>
            <ActionPill href="/dashboard" icon={<IconRocket />}>
              Overview
            </ActionPill>
            <ActionPill href="/dashboard/impact" icon={<IconChart />}>
              Impact
            </ActionPill>
          </>
        }
      />

      <div className="grid gap-3">
        {AGENT_CARDS.map((card) => (
          <AgentInstallCard key={card.id} card={card} />
        ))}
      </div>

      <SectionCard
        inset={false}
        header={
          <CardHeaderRow
            icon={<IconArrowUpRight />}
            actor={<span>Custom integration</span>}
            meta={<>· build on the SDK</>}
            actions={
              <PrimaryButton href="https://github.com/64envy64/tracebase" external icon={<IconArrowUpRight />}>
                Read the docs
              </PrimaryButton>
            }
          />
        }
      />
    </section>
  );
}

function AgentInstallCard({ card }: { card: AgentCard }) {
  return (
    <SectionCard
      header={
        <CardHeaderRow
          icon={<IconAgent />}
          actor={<span style={{ color: "var(--text)" }}>{card.label}</span>}
          meta={<span className="font-mono normal-case tracking-normal">· {card.surface}</span>}
        />
      }
      body={
        <div className="space-y-4">
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
      }
    />
  );
}
