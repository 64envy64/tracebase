import Link from "next/link";
import type { Metadata } from "next";
import { GitHubMark } from "@/components/ui/GitHubMark";

export const metadata: Metadata = {
  title: "Docs — TraceBase",
  description: "Installation, verification, adapters, auditability, and operator docs for TraceBase.",
};

const NAV_GROUPS = [
  {
    title: "Getting Started",
    items: [
      { href: "#what-is-tracebase", label: "What is TraceBase" },
      { href: "#quickstart", label: "Quickstart" },
      { href: "#install-targets", label: "Agent adapters" },
    ],
  },
  {
    title: "Operate",
    items: [
      { href: "#verify-health", label: "Verify health" },
      { href: "#remove-reset", label: "Remove / reset" },
      { href: "#dashboard-auditability", label: "Dashboard + auditability" },
    ],
  },
  {
    title: "Architecture",
    items: [
      { href: "#reasoning-loop", label: "Reasoning loop" },
      { href: "#cli-reference", label: "CLI reference" },
      { href: "#troubleshooting", label: "Troubleshooting" },
    ],
  },
] as const;

const QUICKSTART_COMMANDS = [
  "npx tracebase-ai init",
  "npx tracebase-ai status",
  "npx tracebase-ai doctor",
] as const;

const INSTALL_TARGETS = [
  {
    id: "claude-code",
    title: "Claude Code",
    command: "npx tracebase-ai init",
    surface: ".claude/settings.json + CLAUDE.md",
    steps: [
      "Run the command above in your project directory — `init` auto-detects Claude Code and wires it locally.",
      "Restart Claude Code so the MCP server picks up.",
      "Run `/tools` and confirm `get_reasoning_patterns` is listed.",
    ],
  },
  {
    id: "cursor",
    title: "Cursor",
    command: "npx tracebase-ai init",
    surface: "~/.cursor/mcp.json + AGENTS.md",
    steps: [
      "Run the command above — if Cursor is installed locally, `init` auto-detects it and writes the adapter.",
      "Restart Cursor so MCP reloads.",
      "Open Cursor Settings → MCP and confirm `tracebase` shows a green indicator.",
    ],
  },
  {
    id: "codex",
    title: "Codex",
    command: "npx tracebase-ai init",
    surface: "codex mcp registry + AGENTS.md",
    steps: [
      "Run the command above — if the `codex` CLI is on PATH, `init` detects Codex and registers the MCP server.",
      "Start a fresh Codex session in the project.",
      "Run `codex mcp list` and confirm `tracebase` is present.",
    ],
  },
] as const;

const HEALTH_COMMANDS = [
  {
    command: "npx tracebase-ai status",
    body: "One-screen install snapshot. Shows the resolved project root, target agent, local store path, install surfaces, and recent event counts.",
  },
  {
    command: "npx tracebase-ai doctor",
    body: "Deep integrity check. Fails on broken config, malformed JSON, missing MCP registration, and other real install defects.",
  },
  {
    command: "npx tracebase-ai events --limit 20",
    body: "Read the most recent retrieval, injection, fact injection, agent_used, and outcome events from the local store.",
  },
  {
    command: "npx tracebase-ai report",
    body: "Aggregated reuse metrics from the same event substrate used by the dashboard.",
  },
] as const;

const EVENT_TYPES = [
  {
    name: "retrieval",
    body: "Candidate blocks and facts surfaced for the run, including shadow retrieval when enabled.",
  },
  {
    name: "injection / fact_injection",
    body: "What actually entered the prompt after gating. Prompt payload and analytics stay one-to-one.",
  },
  {
    name: "agent_used / fact_agent_used",
    body: "What the agent actually used, intersected with what was truly injected so attribution stays honest.",
  },
  {
    name: "outcome",
    body: "Whether the run resolved and whether it was a control run. This closes the calibration and lifecycle loop.",
  },
] as const;

const CLI_REFERENCE = [
  { command: "npx tracebase-ai init", body: "Initialize the local store, auto-detect the active agent (or every locally-installed agent), write the adapter surfaces, and link into the hosted workspace when browser auth is available." },
  { command: "npx tracebase-ai init --agent cursor", body: "Scripting escape hatch. Restrict the install to a single adapter. Most users should not need this — `init` alone does the right thing." },
  { command: "npx tracebase-ai remove", body: "Remove `.tracebase`, the managed instruction block, and the registered MCP entry for the active adapter." },
  { command: "npx tracebase-ai status --json", body: "Machine-readable install snapshot for scripts and dashboard reuse." },
  { command: "npx tracebase-ai doctor --json", body: "Machine-readable health report. Exits non-zero when install integrity is broken." },
  { command: "npx tracebase-ai report --json", body: "Structured aggregated reuse analytics from the local event log." },
] as const;

const TROUBLESHOOTING_STEPS = [
  {
    title: "Install targeted the wrong agent",
    body: "`init` auto-detects the agent you are running inside and falls back to every locally-installed agent. If you need to lock it down, re-run with `npx tracebase-ai init --agent cursor` (or `--agent codex`). Auto-selection never picks Codex unless the `codex` CLI is actually available.",
  },
  {
    title: "Status works in root but not from a subdirectory",
    body: "This path is fixed. `status`, `doctor`, `events`, and `report` now walk up to the real project root and do not invent phantom nested stores.",
  },
  {
    title: "Codex adapter says CLI is unavailable",
    body: "Install the Codex CLI or use another adapter. TraceBase now surfaces this as an incomplete install instead of silently succeeding.",
  },
  {
    title: "Need a clean reinstall",
    body: "Run `npx tracebase-ai remove`, then `npx tracebase-ai init`. This removes the local project store and the managed integration surfaces without touching unrelated user content.",
  },
] as const;

const ON_THIS_PAGE = [
  { href: "#what-is-tracebase", label: "What is TraceBase" },
  { href: "#quickstart", label: "Quickstart" },
  { href: "#install-targets", label: "Agent adapters" },
  { href: "#verify-health", label: "Verify health" },
  { href: "#remove-reset", label: "Remove / reset" },
  { href: "#dashboard-auditability", label: "Dashboard + auditability" },
  { href: "#reasoning-loop", label: "Reasoning loop" },
  { href: "#cli-reference", label: "CLI reference" },
  { href: "#troubleshooting", label: "Troubleshooting" },
] as const;

function Section({
  id,
  eyebrow,
  title,
  body,
  children,
}: {
  id: string;
  eyebrow: string;
  title: string;
  body: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      className="scroll-mt-24 border-t py-12 md:py-14"
      style={{ borderColor: "var(--border)" }}
    >
      <div className="max-w-[760px]">
        <p
          className="text-[10px] font-mono uppercase tracking-[0.18em]"
          style={{ color: "var(--text-tertiary)" }}
        >
          {eyebrow}
        </p>
        <h2 className="mt-3 text-[1.7rem] font-light tracking-[-0.03em] md:text-[2rem]">{title}</h2>
        <p
          className="mt-4 text-sm font-light leading-relaxed"
          style={{ color: "var(--text-secondary)" }}
        >
          {body}
        </p>
      </div>
      <div className="mt-7">{children}</div>
    </section>
  );
}

function CommandBlock({
  command,
  body,
}: {
  command: string;
  body?: string;
}) {
  return (
    <div className="rounded-sm border" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
      <div className="overflow-x-auto border-b px-4 py-3 font-mono text-[13px]" style={{ borderColor: "var(--border)" }}>
        <span style={{ color: "var(--text-tertiary)" }}>$ </span>
        <span>{command}</span>
      </div>
      {body ? (
        <p className="px-4 py-3 text-[13px] font-light leading-relaxed" style={{ color: "var(--text-secondary)" }}>
          {body}
        </p>
      ) : null}
    </div>
  );
}

function NoteCard({
  title,
  body,
}: {
  title: string;
  body: string;
}) {
  return (
    <article className="rounded-sm border p-4" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
      <h3 className="text-sm font-medium tracking-tight">{title}</h3>
      <p className="mt-3 text-[13px] font-light leading-relaxed" style={{ color: "var(--text-secondary)" }}>
        {body}
      </p>
    </article>
  );
}

export default function DocsPage() {
  return (
    <div className="min-h-screen">
      <header
        className="sticky top-0 z-50 border-b"
        style={{
          borderColor: "var(--border)",
          background: "rgba(15, 14, 9, 0.88)",
          backdropFilter: "blur(14px)",
          WebkitBackdropFilter: "blur(14px)",
        }}
      >
        <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-4 px-5 py-4 md:px-7">
          <div className="min-w-0">
            <p className="text-[10px] font-mono uppercase tracking-[0.18em]" style={{ color: "var(--text-tertiary)" }}>
              Guides
            </p>
            <h1 className="mt-2 text-lg font-medium tracking-tight">TraceBase Docs</h1>
          </div>

          <nav className="hidden items-center gap-5 text-sm md:flex" aria-label="Top navigation">
            <Link href="/docs" style={{ color: "var(--text)" }}>
              Guides
            </Link>
            <a href="#install-targets" style={{ color: "var(--text-secondary)" }} className="transition-colors hover:[color:var(--text)]">
              Integrations
            </a>
            <a href="#cli-reference" style={{ color: "var(--text-secondary)" }} className="transition-colors hover:[color:var(--text)]">
              CLI
            </a>
            <Link href="/whitepaper" style={{ color: "var(--text-secondary)" }} className="transition-colors hover:[color:var(--text)]">
              Whitepaper
            </Link>
            <a
              href="https://github.com/64envy64/tracebase"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 transition-colors hover:[color:var(--text)]"
              style={{ color: "var(--text-secondary)" }}
            >
              <GitHubMark className="h-4 w-4" />
              GitHub
            </a>
          </nav>
        </div>
      </header>

      <main className="mx-auto grid max-w-[1440px] gap-0 md:grid-cols-[248px_minmax(0,1fr)] xl:grid-cols-[248px_minmax(0,1fr)_236px]">
        <aside
          className="hidden border-r md:block"
          style={{ borderColor: "var(--border)", background: "rgba(255,255,255,0.01)" }}
        >
          <div className="sticky top-[73px] h-[calc(100vh-73px)] overflow-y-auto px-5 py-8">
            <div className="space-y-7">
              <div className="space-y-2">
                <a
                  href="https://github.com/64envy64/tracebase"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-sm transition-colors hover:[color:var(--text)]"
                  style={{ color: "var(--text-secondary)" }}
                >
                  <GitHubMark className="h-4 w-4" />
                  GitHub
                </a>
                <Link href="/dashboard" className="block text-sm transition-colors hover:[color:var(--text)]" style={{ color: "var(--text-secondary)" }}>
                  Dashboard
                </Link>
              </div>

              {NAV_GROUPS.map((group) => (
                <div key={group.title}>
                  <p
                    className="text-[11px] font-light uppercase tracking-[0.18em]"
                    style={{ color: "var(--text-tertiary)" }}
                  >
                    {group.title}
                  </p>
                  <nav className="mt-3 flex flex-col gap-1.5" aria-label={group.title}>
                    {group.items.map((item) => (
                      <a
                        key={item.href}
                        href={item.href}
                        className="rounded-sm px-3 py-2 text-sm font-light transition-[background-color,color] hover:[color:var(--text)]"
                        style={{ color: "var(--text-secondary)" }}
                      >
                        {item.label}
                      </a>
                    ))}
                  </nav>
                </div>
              ))}
            </div>
          </div>
        </aside>

        <article className="min-w-0 px-5 py-8 md:px-8 md:py-10 xl:px-10">
          <div className="max-w-[820px]">
            <p className="text-[10px] font-mono uppercase tracking-[0.18em]" style={{ color: "rgb(var(--accent-rgb) / 0.78)" }}>
              Getting Started
            </p>
            <h1 className="mt-3 text-[2.2rem] font-light tracking-[-0.04em] md:text-[3rem]">
              Install once.
              <br />
              Verify quickly.
              <br />
              Inspect every assist.
            </h1>
            <p className="mt-5 max-w-[720px] text-sm font-light leading-relaxed" style={{ color: "var(--text-secondary)" }}>
              TraceBase is a reasoning reuse layer for agents. It installs into the agent surface you already use,
              keeps project-scoped local memory by default, and adds hosted visibility on top without changing the
              core workflow.
            </p>
          </div>

          <div className="mt-8 grid gap-3 md:grid-cols-3">
            <NoteCard
              title="One command install"
              body="`npx tracebase-ai init` creates the local store, writes the adapter surface, and links the project into the hosted workspace when browser auth is available."
            />
            <NoteCard
              title="Operator-first health checks"
              body="`status`, `doctor`, `events`, and `report` all read the same local event substrate and now resolve the real project root from nested directories."
            />
            <NoteCard
              title="Auditability by default"
              body="Retrieval, prompt injection, usage attribution, and outcomes stay in one chain so reuse quality can be measured instead of guessed."
            />
          </div>

          <Section
            id="what-is-tracebase"
            eyebrow="Overview"
            title="What TraceBase actually installs"
            body="The install path stays small. TraceBase adds a project-scoped memory store, wires the active agent into that store, and writes a managed instruction block so the agent knows when to retrieve and when to report outcomes."
          >
            <div className="grid gap-3 md:grid-cols-3">
              <NoteCard
                title="Local store"
                body="`.tracebase/` contains the local SQLite store and stable workspace config for the project."
              />
              <NoteCard
                title="Agent adapter"
                body="Depending on the target: `.claude/settings.json`, `~/.cursor/mcp.json`, or the Codex MCP registry."
              />
              <NoteCard
                title="Managed instructions"
                body="`CLAUDE.md` or `AGENTS.md` gets a managed TraceBase block. User content outside that block is preserved."
              />
            </div>
          </Section>

          <Section
            id="quickstart"
            eyebrow="Quickstart"
            title="Start with the default path"
            body="For most users the right flow is still three commands: install, confirm the install surface, then run a health check. The browser approval step only appears when hosted linking is available."
          >
            <div className="grid gap-3">
              {QUICKSTART_COMMANDS.map((command) => (
                <CommandBlock key={command} command={command} />
              ))}
            </div>

            <div className="mt-5 grid gap-3 md:grid-cols-2">
              <NoteCard
                title="What success looks like"
                body="`init` reports the selected target, writes the local config, writes the managed instruction file, and links the project into the hosted workspace if you approve in the browser."
              />
              <NoteCard
                title="What to do immediately after"
                body="Restart the target agent, confirm TraceBase appears in the MCP surface, then run `npx tracebase-ai status` from the project."
              />
            </div>
          </Section>

          <Section
            id="install-targets"
            eyebrow="Integrations"
            title="One command. It picks the right adapter."
            body="`init` auto-detects the agent you are running inside, or — on a cold terminal — configures every agent installed on the machine. You never have to pass `--agent` under normal use."
          >
            <div className="grid gap-3">
              {INSTALL_TARGETS.map((target) => (
                <article key={target.id} className="rounded-sm border" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
                  <div className="border-b px-4 py-3" style={{ borderColor: "var(--border)" }}>
                    <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                      <div>
                        <h3 className="text-base font-medium tracking-tight">{target.title}</h3>
                        <p className="mt-1 text-[12px] font-light" style={{ color: "var(--text-tertiary)" }}>
                          {target.surface}
                        </p>
                      </div>
                      <p className="text-[11px] font-mono uppercase tracking-[0.18em]" style={{ color: "var(--text-tertiary)" }}>
                        adapter
                      </p>
                    </div>
                  </div>

                  <div className="space-y-4 p-4">
                    <CommandBlock command={target.command} />
                    <ol className="grid gap-2.5">
                      {target.steps.map((step, index) => (
                        <li
                          key={step}
                          className="flex gap-3 text-[13px] font-light leading-relaxed"
                          style={{ color: "var(--text-secondary)" }}
                        >
                          <span
                            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm border text-[10px] font-mono"
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
              ))}
            </div>
          </Section>

          <Section
            id="verify-health"
            eyebrow="Operate"
            title="Verification should be fast and boring"
            body="After install, you should not guess. The local CLI gives you enough signal to distinguish a fresh project from a broken one, and enough detail to debug adapter wiring without going into the database by hand."
          >
            <div className="grid gap-3">
              {HEALTH_COMMANDS.map((item) => (
                <CommandBlock key={item.command} command={item.command} body={item.body} />
              ))}
            </div>
          </Section>

          <Section
            id="remove-reset"
            eyebrow="Lifecycle"
            title="Remove or reset the install cleanly"
            body="TraceBase now has a proper uninstall path. This is useful both for local testing and for recovering a project to a known-clean state before a reinstall."
          >
            <div className="grid gap-3 md:grid-cols-[minmax(0,0.94fr)_minmax(0,1.06fr)]">
              <CommandBlock
                command="npx tracebase-ai remove"
                body="Removes `.tracebase/`, removes the managed TraceBase section from `CLAUDE.md` or `AGENTS.md`, and unregisters the MCP entry for the active adapter."
              />
              <div className="grid gap-3">
                <NoteCard
                  title="Safe cleanup"
                  body="The command removes only TraceBase-owned surfaces. User content outside the managed instruction block is preserved."
                />
                <NoteCard
                  title="Reinstall loop"
                  body="For a full reset: `npx tracebase-ai remove` → `npx tracebase-ai init`."
                />
                <NoteCard
                  title="Scope"
                  body="This is a project uninstall. It does not revoke your dashboard account or delete unrelated agent configuration."
                />
              </div>
            </div>
          </Section>

          <Section
            id="dashboard-auditability"
            eyebrow="Control Plane"
            title="The dashboard sits on top of the same event substrate"
            body="The hosted dashboard is not a separate truth source. It is the visibility layer on top of the same retrieval and outcome model the local CLI uses."
          >
            <div className="grid gap-3 md:grid-cols-2">
              <article className="rounded-sm border p-4" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
                <h3 className="text-sm font-medium tracking-tight">What the dashboard should answer</h3>
                <ul className="mt-4 space-y-3 text-[13px] font-light leading-relaxed" style={{ color: "var(--text-secondary)" }}>
                  <li>How often did retrieval fire?</li>
                  <li>What actually entered prompts?</li>
                  <li>Which blocks and facts were helpful?</li>
                  <li>What token or latency delta did reuse create?</li>
                </ul>
              </article>

              <article className="rounded-sm border p-4" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
                <h3 className="text-sm font-medium tracking-tight">Why the audit trail matters</h3>
                <ul className="mt-4 space-y-3 text-[13px] font-light leading-relaxed" style={{ color: "var(--text-secondary)" }}>
                  <li>Enterprises need to inspect what was injected and why.</li>
                  <li>Calibration only works if usage attribution is honest.</li>
                  <li>Lifecycle repair only works if disproved reasoning can be demoted safely.</li>
                </ul>
              </article>
            </div>

            <div className="mt-5 grid gap-3 md:grid-cols-2">
              {EVENT_TYPES.map((item) => (
                <NoteCard key={item.name} title={item.name} body={item.body} />
              ))}
            </div>
          </Section>

          <Section
            id="reasoning-loop"
            eyebrow="Architecture"
            title="The product loop is capture → recall → inject → measure → repair"
            body="Public docs do not need every internal detail, but they should make the operating loop legible. TraceBase is useful only if the whole loop closes and poor reasoning gets corrected instead of accumulating."
          >
            <div className="grid gap-3 md:grid-cols-5">
              <NoteCard title="Capture" body="Successful runs are distilled into reusable blocks and facts." />
              <NoteCard title="Recall" body="New work retrieves candidates from procedural and semantic memory before the agent burns tokens." />
              <NoteCard title="Inject" body="Only gate-passing candidates reach the prompt. Rendered payload and analytics stay aligned." />
              <NoteCard title="Measure" body="Events track retrieval, injection, usage, outcome, and aggregate helpfulness." />
              <NoteCard title="Repair" body="Verification and lifecycle repair demote blocks that stop earning their keep." />
            </div>
          </Section>

          <Section
            id="cli-reference"
            eyebrow="Reference"
            title="Core CLI surface"
            body="These are the commands that matter for rollout, operations, and debugging. Keep the public surface small and composable."
          >
            <div className="grid gap-3">
              {CLI_REFERENCE.map((item) => (
                <CommandBlock key={item.command} command={item.command} body={item.body} />
              ))}
            </div>
          </Section>

          <Section
            id="troubleshooting"
            eyebrow="Troubleshooting"
            title="Start with the concrete failure mode"
            body="Most install problems are one of four things: wrong adapter, broken local config, missing CLI surface, or a user checking the wrong project root. The right response is to verify that specific failure, not to edit files blind."
          >
            <div className="grid gap-3 md:grid-cols-2">
              {TROUBLESHOOTING_STEPS.map((item) => (
                <NoteCard key={item.title} title={item.title} body={item.body} />
              ))}
            </div>
          </Section>
        </article>

        <aside className="hidden border-l xl:block" style={{ borderColor: "var(--border)" }}>
          <div className="sticky top-[73px] h-[calc(100vh-73px)] overflow-y-auto px-5 py-8">
            <p className="text-[11px] font-light uppercase tracking-[0.18em]" style={{ color: "var(--text-tertiary)" }}>
              On this page
            </p>
            <nav className="mt-4 flex flex-col gap-2" aria-label="On this page">
              {ON_THIS_PAGE.map((item) => (
                <a
                  key={item.href}
                  href={item.href}
                  className="text-sm font-light transition-colors hover:[color:var(--text)]"
                  style={{ color: "var(--text-secondary)" }}
                >
                  {item.label}
                </a>
              ))}
            </nav>
          </div>
        </aside>
      </main>
    </div>
  );
}
