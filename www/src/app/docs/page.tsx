import Link from "next/link";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { CopyCommand } from "@/components/CopyButton";
import { LandingNav } from "@/components/landing/LandingNav";
import { Chip, SectionLabel } from "@/components/landing/brand/Primitives";
import { INK } from "@/components/landing/brand/tokens";
import { GitHubMark } from "@/components/ui/GitHubMark";

export const metadata: Metadata = {
  title: "Docs — tracebase.ink",
  description:
    "Install in one command, verify in ten seconds, inspect every assist. Compact reference for tracebase — the closed self-learning loop for coding agents.",
};

/* ============================================================ */
/*  Docs — ink-style layout.                                     */
/*                                                                */
/*  Three-column shell on xl+ (sidebar · content · on-this-page),*/
/*  collapses cleanly down to one column on mobile. The visual   */
/*  language matches the landing: ink/bone/ember palette, hero-  */
/*  serif H1s, mono section eyebrows, tiles with hairline        */
/*  borders, no marketing fluff. Information surface only —      */
/*  install paths, health checks, capability glossary, CLI       */
/*  reference, troubleshooting. We deliberately do NOT expose:   */
/*    · DB schema internals beyond store path                    */
/*    · pattern-DB ranking heuristics                            */
/*    · auth / control-plane endpoints                            */
/*    · proprietary outcome-attribution scoring                  */
/* ============================================================ */

type NavItem = { href: string; label: string };
type NavGroup = { title: string; items: readonly NavItem[] };

const NAV_GROUPS: readonly NavGroup[] = [
  {
    title: "Getting started",
    items: [
      { href: "#welcome", label: "Welcome" },
      { href: "#quickstart", label: "Quickstart" },
      { href: "#install-targets", label: "Agents we install for" },
    ],
  },
  {
    title: "Operate",
    items: [
      { href: "#verify", label: "Verify the install" },
      { href: "#remove", label: "Remove or reset" },
      { href: "#audit", label: "Dashboard & audit" },
    ],
  },
  {
    title: "Architecture",
    items: [
      { href: "#loop", label: "The loop" },
      { href: "#capabilities", label: "Five arms" },
      { href: "#cli", label: "CLI reference" },
      { href: "#troubleshooting", label: "Troubleshooting" },
    ],
  },
] as const;

const ON_THIS_PAGE: readonly NavItem[] = [
  { href: "#welcome", label: "Welcome" },
  { href: "#quickstart", label: "Quickstart" },
  { href: "#install-targets", label: "Agents we install for" },
  { href: "#verify", label: "Verify the install" },
  { href: "#remove", label: "Remove or reset" },
  { href: "#audit", label: "Dashboard & audit" },
  { href: "#loop", label: "The loop" },
  { href: "#capabilities", label: "Five arms" },
  { href: "#cli", label: "CLI reference" },
  { href: "#troubleshooting", label: "Troubleshooting" },
] as const;

type InstallTarget = {
  id: string;
  title: string;
  surface: string;
  steps: readonly string[];
};

const INSTALL_TARGETS: readonly InstallTarget[] = [
  {
    id: "claude-code",
    title: "Claude Code",
    surface: ".mcp.json + CLAUDE.md",
    steps: [
      "Run `npx tracebase-ai init` in your project directory. `init` auto-detects Claude Code 2.x and writes `.mcp.json` so the runtime is picked up on next launch.",
      "Older installs that wrote into `.claude/settings.json` are migrated automatically — nothing to clean by hand.",
      "Restart Claude Code so the MCP server boots.",
      "Run `/tools` and confirm `get_reasoning_patterns` is listed.",
    ],
  },
  {
    id: "cursor",
    title: "Cursor",
    surface: "~/.cursor/mcp.json + AGENTS.md",
    steps: [
      "Run `npx tracebase-ai init` — if Cursor is installed locally, the adapter is written without prompting.",
      "Restart Cursor so MCP reloads.",
      "Open Cursor Settings → MCP and confirm `tracebase` shows a green indicator.",
    ],
  },
  {
    id: "codex",
    title: "Codex",
    surface: "codex mcp registry + AGENTS.md",
    steps: [
      "Run `npx tracebase-ai init` — if the `codex` CLI is on PATH, Codex is detected and the MCP server is registered.",
      "Start a fresh Codex session in the project.",
      "Run `codex mcp list` and confirm `tracebase` is present.",
    ],
  },
] as const;

const HEALTH_CMDS: readonly { command: string; body: string }[] = [
  { command: "npx tracebase-ai status", body: "One-screen install snapshot. Resolved project root, active agent, local store path, install surfaces, recent event counts." },
  { command: "npx tracebase-ai doctor", body: "Deep integrity check. Fails on broken config, malformed JSON, missing MCP registration, or any real install defect." },
  { command: "npx tracebase-ai events --limit 20", body: "Read the most recent retrieval, injection, agent_used, and outcome events from the local event log." },
  { command: "npx tracebase-ai report", body: "Aggregated reuse metrics from the same substrate the hosted dashboard reads." },
] as const;

const LOOP_PHASES: readonly { name: string; tone: "ember" | "sand" | "amber" | "coral"; body: string }[] = [
  { name: "Capture", tone: "ember", body: "Resolved runs land in a local SQLite event log — tool chain, files touched, verdict." },
  { name: "Index", tone: "sand", body: "Traces are distilled into reusable patterns. Indexed in the same project-scoped store." },
  { name: "Recall", tone: "amber", body: "When the next run rhymes with an indexed shape, the pattern is surfaced before re-derivation." },
  { name: "Learn", tone: "coral", body: "Outcome attribution feeds back. Useful patterns rise; disproved ones quietly demote." },
] as const;

const CAPABILITIES: readonly { name: string; tone: "ember" | "sand" | "coral" | "amber" | "neutral"; body: string }[] = [
  { name: "Recall", tone: "ember", body: "Surfaces past solutions when a similar problem returns. Vector + heuristic match against the project-scoped pattern store." },
  { name: "Gist", tone: "sand", body: "Semantic file memory. Recalls what a file means without re-reading the bytes. Survives window compaction." },
  { name: "Loop", tone: "coral", body: "Catches doom-loops mid-run on a six-turn rolling window. Suggests a redirect — never overrides agent judgement." },
  { name: "Guard", tone: "amber", body: "Spots repeat tool calls and redundant fetches before they compound on the bill." },
  { name: "Fold", tone: "neutral", body: "Folds older turns into gist summaries so long horizons stay coherent without thrashing the window." },
] as const;

const CLI_REFERENCE: readonly { command: string; body: string }[] = [
  { command: "npx tracebase-ai init", body: "Initialise the local store, auto-detect the active agent (or every locally-installed agent on a cold terminal), write the adapter surfaces, and link into the hosted workspace if browser auth is available." },
  { command: "npx tracebase-ai init --agent cursor", body: "Scripting escape hatch. Restrict the install to a single adapter. Most users never need this." },
  { command: "npx tracebase-ai remove", body: "Removes `.tracebase/`, the managed instruction block, and the registered MCP entry for the active adapter. User content outside the managed block is preserved." },
  { command: "npx tracebase-ai status --json", body: "Machine-readable install snapshot. Same shape the dashboard uses." },
  { command: "npx tracebase-ai doctor --json", body: "Machine-readable health report. Non-zero exit when install integrity is broken — wire into CI for rollout gates." },
  { command: "npx tracebase-ai report --json", body: "Structured aggregated reuse analytics. Pair with `--limit` and `--after` for windowed reads." },
  { command: "npx tracebase-ai recall <shape>", body: "Look up resolved patterns for a problem shape directly from the project-scoped store. Useful for inspecting what the agent would have surfaced." },
  { command: "npx tracebase-ai impact", body: "30-day reuse + saved-tokens funnel — same fold as the hosted impact page, computed locally from the event log." },
] as const;

const TROUBLESHOOTING: readonly { title: string; body: string }[] = [
  { title: "Install targeted the wrong agent", body: "`init` auto-detects the agent you're running inside. To pin it explicitly, re-run with `npx tracebase-ai init --agent cursor` (or `--agent codex`). Auto-selection never picks Codex unless the `codex` CLI is actually on PATH." },
  { title: "`status` works in the root but not from a subdirectory", body: "Fixed in v0.8. `status`, `doctor`, `events`, and `report` walk up to the real project root and never invent phantom nested stores." },
  { title: "Codex adapter says CLI is unavailable", body: "Install the Codex CLI or use another adapter. Tracebase now surfaces this as an incomplete install instead of silently succeeding." },
  { title: "Need a clean reinstall", body: "Run `npx tracebase-ai remove`, then `npx tracebase-ai init`. Removes the local store + managed integration surfaces without touching unrelated user content." },
] as const;

/* ============================================================ */
/*  Page                                                          */
/* ============================================================ */

export default function DocsPage() {
  return (
    <div className="min-h-screen" style={{ background: INK.ink, color: INK.bone }}>
      <LandingNav />

      <div className="mx-auto grid w-full max-w-[1320px] grid-cols-1 gap-0 px-4 pt-14 sm:px-6 md:grid-cols-[228px_minmax(0,1fr)] md:gap-10 md:px-8 xl:grid-cols-[228px_minmax(0,1fr)_220px] xl:gap-12">
        <DocsSidebar />

        <main className="min-w-0 py-10 md:py-14">
          <WelcomeBlock />

          <DocSection
            id="quickstart"
            eyebrow="Quickstart"
            title="Three commands."
            body="Install, confirm the surface, run a health check. The browser approval step only appears when hosted linking is available — fully offline installs skip it entirely."
          >
            <CommandStack
              items={[
                { command: "npx tracebase-ai init", note: "Detects your active agent and writes the adapter." },
                { command: "npx tracebase-ai status", note: "One-screen install snapshot." },
                { command: "npx tracebase-ai doctor", note: "Deep integrity check — exits non-zero on real defects." },
              ]}
            />
            <Callouts
              items={[
                { title: "What success looks like", body: "`init` reports the selected target, writes the local config, writes the managed instruction file, and links the project into the hosted workspace if you approve in the browser." },
                { title: "What to do next", body: "Restart the target agent, confirm `tracebase` appears in the MCP surface, then run `status` from the project root." },
              ]}
            />
          </DocSection>

          <DocSection
            id="install-targets"
            eyebrow="Agent adapters"
            title="One install. Three agent surfaces."
            body="`init` auto-detects the agent you are running inside. On a cold terminal it configures every locally-installed agent. You never need `--agent` under normal use."
          >
            <div className="grid gap-3">
              {INSTALL_TARGETS.map((target) => (
                <InstallCard key={target.id} target={target} />
              ))}
            </div>
          </DocSection>

          <DocSection
            id="verify"
            eyebrow="Operate"
            title="Verify the install in ten seconds."
            body="After install you should not have to guess. The local CLI gives you enough signal to tell a fresh project from a broken one — and enough detail to debug adapter wiring without opening the database by hand."
          >
            <CommandStack items={HEALTH_CMDS.map((h) => ({ command: h.command, note: h.body }))} />
          </DocSection>

          <DocSection
            id="remove"
            eyebrow="Lifecycle"
            title="Remove or reset cleanly."
            body="Tracebase has a proper uninstall path. Use it to put a project back into a known-clean state before a reinstall, or for local testing."
          >
            <CommandStack
              items={[
                {
                  command: "npx tracebase-ai remove",
                  note: "Removes `.tracebase/`, the managed instruction block, and the MCP entry. User content outside the managed block is preserved.",
                },
              ]}
            />
            <Callouts
              items={[
                { title: "Safe cleanup", body: "Removes only Tracebase-owned surfaces. Nothing outside the managed instruction block is touched." },
                { title: "Reinstall loop", body: "For a full reset: `npx tracebase-ai remove` → `npx tracebase-ai init`." },
              ]}
            />
          </DocSection>

          <DocSection
            id="audit"
            eyebrow="Control plane"
            title="The dashboard reads the same event log."
            body="The hosted dashboard is not a separate truth source. It is the visibility layer on top of the same retrieval and outcome events the CLI reads — nothing is reinterpreted between layers."
          >
            <Callouts
              items={[
                { title: "Retrieval", body: "Candidates surfaced for the run, including shadow retrieval when enabled." },
                { title: "Injection", body: "What actually entered the prompt after gating. Prompt payload and analytics stay one-to-one." },
                { title: "Agent used", body: "What the agent actually used, intersected with what was truly injected — attribution stays honest." },
                { title: "Outcome", body: "Whether the run resolved, and whether it was a control run. Closes the calibration loop." },
              ]}
            />
          </DocSection>

          <DocSection
            id="loop"
            eyebrow="Architecture"
            title="The closed self-learning loop."
            body="Four phases. One feedback loop. Capture happens at the end of a run; learn closes back to capture. The whole loop runs locally against your project unless you opt into hosted visibility."
          >
            <PhaseGrid />
          </DocSection>

          <DocSection
            id="capabilities"
            eyebrow="Capabilities"
            title="Five arms, one memory."
            body="Each capability catches a specific failure mode agents hit at runtime. Same vocabulary as the landing — recall, gist, loop, guard, fold — implemented over a single project-scoped store."
          >
            <CapabilityGrid />
          </DocSection>

          <DocSection
            id="cli"
            eyebrow="Reference"
            title="CLI reference."
            body="The commands that matter for rollout, operations, debugging, and analytics. The public surface is intentionally small and composable — every command emits machine-readable output behind `--json`."
          >
            <CommandStack items={CLI_REFERENCE.map((c) => ({ command: c.command, note: c.body }))} />
          </DocSection>

          <DocSection
            id="troubleshooting"
            eyebrow="Troubleshooting"
            title="When things go wrong."
            body="Most install problems are one of four things: wrong adapter, broken local config, missing CLI surface, or the user checking the wrong project root. Verify the specific failure first — don't edit files blind."
          >
            <Callouts items={TROUBLESHOOTING} columns={2} />
          </DocSection>

          <FooterBlock />
        </main>

        <OnThisPage />
      </div>
    </div>
  );
}

/* ============================================================ */
/*  Welcome — the hero of the docs page. Title + lede + a quick  */
/*  install command the reader can copy in one motion.            */
/* ============================================================ */

function WelcomeBlock() {
  return (
    <section id="welcome" className="scroll-mt-24">
      <SectionLabel>docs</SectionLabel>
      <h1
        className="mt-3 font-hero-serif text-[clamp(2.2rem,4.4vw,3.6rem)] font-normal leading-[1.04] tracking-tight"
        style={{ color: INK.pearl }}
      >
        <span style={{ color: "rgba(232,217,184,0.48)" }}>Install once.</span>{" "}
        Verify in ten seconds.
      </h1>
      <p
        className="mt-5 max-w-[44rem] text-[14.5px] font-light leading-relaxed"
        style={{ color: "rgba(232,217,184,0.72)" }}
      >
        Tracebase is the closed self-learning loop for coding agents — capture, index, recall, learn. It installs into the agent surface you already use, keeps a project-scoped local store by default, and adds hosted visibility on top without changing the core workflow.
      </p>

      <div className="mt-7 flex flex-wrap items-center gap-3">
        <CopyCommand command="npx tracebase-ai init" />
        <a
          href="#quickstart"
          className="text-[13px] font-light underline-offset-2 hover:underline"
          style={{ color: INK.sand }}
        >
          jump to quickstart →
        </a>
      </div>

      <div className="mt-8 grid gap-px overflow-hidden rounded-xl border md:grid-cols-3" style={{ borderColor: "rgba(232,217,184,0.12)", background: "rgba(232,217,184,0.08)" }}>
        <Highlight title="One command install" body="Auto-detects your active agent, writes the adapter, and links into the hosted workspace if browser auth is available." />
        <Highlight title="Operator-first health" body="`status`, `doctor`, `events`, `report` — all read the same local substrate. CI-friendly via `--json` and non-zero exit on real defects." />
        <Highlight title="Audit by default" body="Retrieval, injection, agent-used, and outcome events stay in one chain so reuse quality can be measured instead of guessed." />
      </div>
    </section>
  );
}

function Highlight({ title, body }: { title: string; body: string }) {
  return (
    <div
      className="flex h-full flex-col gap-2 p-5 md:p-6"
      style={{ background: INK.inkDeep }}
    >
      <h3 className="text-[14px] font-medium tracking-tight" style={{ color: INK.pearl }}>
        {title}
      </h3>
      <p className="text-[12.5px] font-light leading-relaxed" style={{ color: "rgba(232,217,184,0.66)" }}>
        {body}
      </p>
    </div>
  );
}

/* ============================================================ */
/*  DocSection — the shared section primitive: anchor scroll     */
/*  margin, eyebrow + serif heading + body, content slot.        */
/* ============================================================ */

function DocSection({
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
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24 border-t py-12 md:py-14" style={{ borderColor: "rgba(232,217,184,0.08)" }}>
      <div className="max-w-[44rem]">
        <SectionLabel>{eyebrow}</SectionLabel>
        <h2
          className="mt-3 font-hero-serif text-[clamp(1.55rem,3vw,2.25rem)] font-normal leading-[1.06] tracking-tight"
          style={{ color: INK.pearl }}
        >
          {title}
        </h2>
        <p
          className="mt-4 text-[14px] font-light leading-relaxed"
          style={{ color: "rgba(232,217,184,0.7)" }}
        >
          {body}
        </p>
      </div>
      <div className="mt-7">{children}</div>
    </section>
  );
}

/* ============================================================ */
/*  CommandStack — the dominant docs primitive: a tile-shell     */
/*  with rows of `$ command` + a one-line note underneath.       */
/* ============================================================ */

function CommandStack({
  items,
}: {
  items: readonly { command: string; note?: string }[];
}) {
  return (
    <div
      className="overflow-hidden rounded-xl border"
      style={{ borderColor: "rgba(232,217,184,0.12)", background: INK.inkDeep }}
    >
      {items.map((item, i) => (
        <div
          key={item.command}
          className="flex flex-col gap-2 border-b px-5 py-4 last:border-b-0 md:flex-row md:items-start md:gap-6 md:px-6"
          style={{ borderColor: "rgba(232,217,184,0.06)" }}
        >
          <div
            className="flex min-w-0 items-center gap-2 font-mono text-[13px]"
            style={{ color: INK.pearl }}
          >
            <span style={{ color: INK.ember }}>$</span>
            <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{item.command}</span>
          </div>
          {item.note ? (
            <p
              className="flex-1 text-[12.5px] font-light leading-relaxed md:max-w-[34rem]"
              style={{ color: "rgba(232,217,184,0.66)" }}
            >
              {item.note}
            </p>
          ) : null}
          {i === items.length - 1 ? null : null}
        </div>
      ))}
    </div>
  );
}

/* ============================================================ */
/*  Callouts — small grid of titled note cards.                  */
/* ============================================================ */

function Callouts({
  items,
  columns = 2,
}: {
  items: readonly { title: string; body: string }[];
  columns?: 2 | 3 | 4;
}) {
  const colClass =
    columns === 4 ? "md:grid-cols-2 xl:grid-cols-4" : columns === 3 ? "md:grid-cols-3" : "md:grid-cols-2";
  return (
    <div
      className={`mt-4 grid gap-px overflow-hidden rounded-xl border sm:grid-cols-1 ${colClass}`}
      style={{ borderColor: "rgba(232,217,184,0.12)", background: "rgba(232,217,184,0.08)" }}
    >
      {items.map((item) => (
        <article
          key={item.title}
          className="flex h-full flex-col gap-2 p-5"
          style={{ background: INK.inkDeep }}
        >
          <h3 className="text-[13.5px] font-medium tracking-tight" style={{ color: INK.pearl }}>
            {item.title}
          </h3>
          <p className="text-[12.5px] font-light leading-relaxed" style={{ color: "rgba(232,217,184,0.66)" }}>
            {item.body}
          </p>
        </article>
      ))}
    </div>
  );
}

/* ============================================================ */
/*  InstallCard — per-agent card with surface chip + steps list. */
/* ============================================================ */

function InstallCard({ target }: { target: InstallTarget }) {
  return (
    <article
      className="overflow-hidden rounded-xl border"
      style={{ borderColor: "rgba(232,217,184,0.12)", background: INK.inkDeep }}
    >
      <header
        className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4 md:px-6"
        style={{ borderColor: "rgba(232,217,184,0.06)" }}
      >
        <div className="flex flex-col gap-1">
          <h3 className="text-[15px] font-medium tracking-tight" style={{ color: INK.pearl }}>
            {target.title}
          </h3>
          <p className="font-mono text-[11px]" style={{ color: INK.sand }}>
            {target.surface}
          </p>
        </div>
        <Chip tone="sand" size="sm">adapter</Chip>
      </header>

      <ol className="grid gap-2.5 px-5 py-5 md:px-6">
        {target.steps.map((step, i) => (
          <li
            key={i}
            className="grid items-start gap-3 text-[12.5px] font-light leading-relaxed md:grid-cols-[24px_minmax(0,1fr)]"
            style={{ color: "rgba(232,217,184,0.72)" }}
          >
            <span
              className="inline-flex h-5 w-5 items-center justify-center rounded border font-mono text-[10px]"
              style={{ borderColor: "rgba(232,217,184,0.14)", color: INK.sand }}
            >
              {i + 1}
            </span>
            <InlineCodeText text={step} />
          </li>
        ))}
      </ol>
    </article>
  );
}

/* ============================================================ */
/*  InlineCodeText — splits a body string on backticks and       */
/*  renders the wrapped segments as inline code so docs prose    */
/*  reads cleanly without manually splitting at every callsite.  */
/* ============================================================ */

function InlineCodeText({ text }: { text: string }) {
  const parts = text.split("`");
  return (
    <span>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <code
            key={i}
            className="rounded-sm px-1 py-px font-mono text-[12px]"
            style={{
              color: INK.pearl,
              background: "rgba(232,217,184,0.06)",
            }}
          >
            {part}
          </code>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </span>
  );
}

/* ============================================================ */
/*  PhaseGrid — the four-phase loop visualised as a tile row.    */
/*  Renders inside the architecture section.                     */
/* ============================================================ */

function PhaseGrid() {
  return (
    <div
      className="grid gap-px overflow-hidden rounded-xl border sm:grid-cols-2 lg:grid-cols-4"
      style={{ borderColor: "rgba(232,217,184,0.12)", background: "rgba(232,217,184,0.08)" }}
    >
      {LOOP_PHASES.map((phase, i) => (
        <article
          key={phase.name}
          className="flex h-full flex-col gap-3 p-5"
          style={{ background: INK.inkDeep }}
        >
          <div className="flex items-center gap-3">
            <span className="font-mono text-[10px] tracking-[0.22em]" style={{ color: INK.sand }}>
              0{i + 1}
            </span>
            <Chip tone={phase.tone} size="sm">{phase.name}</Chip>
          </div>
          <p className="text-[12.5px] font-light leading-relaxed" style={{ color: "rgba(232,217,184,0.7)" }}>
            {phase.body}
          </p>
        </article>
      ))}
    </div>
  );
}

/* ============================================================ */
/*  CapabilityGrid — five capability tiles. Same vocabulary as   */
/*  the landing's `Five arms, one memory` runtime section.       */
/* ============================================================ */

function CapabilityGrid() {
  return (
    <div
      className="grid gap-px overflow-hidden rounded-xl border sm:grid-cols-2 lg:grid-cols-5"
      style={{ borderColor: "rgba(232,217,184,0.12)", background: "rgba(232,217,184,0.08)" }}
    >
      {CAPABILITIES.map((cap, i) => (
        <article
          key={cap.name}
          className="flex h-full flex-col gap-3 p-5"
          style={{ background: INK.inkDeep }}
        >
          <div className="flex items-center gap-3">
            <span className="font-mono text-[10px] tracking-[0.22em]" style={{ color: INK.sand }}>
              0{i + 1}
            </span>
            <Chip tone={cap.tone} size="sm">{cap.name}</Chip>
          </div>
          <p className="text-[12.5px] font-light leading-relaxed" style={{ color: "rgba(232,217,184,0.7)" }}>
            {cap.body}
          </p>
        </article>
      ))}
    </div>
  );
}

/* ============================================================ */
/*  Sidebar — left rail. Sticky from the top of viewport,        */
/*  collapses on mobile (we just hide it; the on-this-page rail  */
/*  on the right is hidden too, leaving the content readable).   */
/* ============================================================ */

function DocsSidebar() {
  return (
    <aside
      className="hidden border-r md:block"
      style={{ borderColor: "rgba(232,217,184,0.08)" }}
    >
      <div className="sticky top-20 max-h-[calc(100vh-5rem)] overflow-y-auto pb-12 pt-10 pr-6">
        <div className="flex flex-col gap-3">
          <a
            href="https://github.com/64envy64/tracebase"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 text-[12.5px] font-light transition-colors hover:[color:var(--text)]"
            style={{ color: INK.sand }}
          >
            <GitHubMark className="h-4 w-4" />
            GitHub
          </a>
          <Link
            href="/dashboard"
            className="text-[12.5px] font-light transition-colors hover:[color:var(--text)]"
            style={{ color: INK.sand }}
          >
            Dashboard
          </Link>
          <Link
            href="/whitepaper"
            className="text-[12.5px] font-light transition-colors hover:[color:var(--text)]"
            style={{ color: INK.sand }}
          >
            Whitepaper
          </Link>
        </div>

        <div className="mt-10 flex flex-col gap-8">
          {NAV_GROUPS.map((group) => (
            <div key={group.title}>
              <p
                className="text-[10px] font-mono uppercase tracking-[0.22em]"
                style={{ color: INK.sand }}
              >
                {group.title}
              </p>
              <nav className="mt-3 flex flex-col gap-px" aria-label={group.title}>
                {group.items.map((item) => (
                  <a
                    key={item.href}
                    href={item.href}
                    className="rounded-sm py-1.5 text-[13px] font-light transition-colors hover:[color:var(--pearl)]"
                    style={{ color: "rgba(232,217,184,0.72)" }}
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
  );
}

/* ============================================================ */
/*  OnThisPage — right-rail. Hidden below xl.                    */
/* ============================================================ */

function OnThisPage() {
  return (
    <aside
      className="hidden border-l xl:block"
      style={{ borderColor: "rgba(232,217,184,0.08)" }}
    >
      <div className="sticky top-20 max-h-[calc(100vh-5rem)] overflow-y-auto pb-12 pl-6 pt-10">
        <p className="text-[10px] font-mono uppercase tracking-[0.22em]" style={{ color: INK.sand }}>
          on this page
        </p>
        <nav className="mt-4 flex flex-col gap-px" aria-label="On this page">
          {ON_THIS_PAGE.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="rounded-sm py-1.5 text-[12.5px] font-light transition-colors hover:[color:var(--pearl)]"
              style={{ color: "rgba(232,217,184,0.66)" }}
            >
              {item.label}
            </a>
          ))}
        </nav>
      </div>
    </aside>
  );
}

/* ============================================================ */
/*  FooterBlock — closes the docs main column.                   */
/* ============================================================ */

function FooterBlock() {
  return (
    <footer
      className="mt-14 flex flex-col gap-3 border-t pt-8 text-[12px] font-light"
      style={{ borderColor: "rgba(232,217,184,0.08)", color: INK.sand }}
    >
      <p>
        <InlineCodeText text="tracebase-ai v0.9 · MIT · self-hosted by default. The hosted workspace is opt-in and reads the same event log." />
      </p>
      <p>
        Found a gap?{" "}
        <a
          href="https://github.com/64envy64/tracebase/issues"
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2 hover:[color:var(--pearl)]"
          style={{ color: INK.bone }}
        >
          Open an issue
        </a>{" "}
        or ping us — docs are kept honest in lockstep with the runtime.
      </p>
    </footer>
  );
}
