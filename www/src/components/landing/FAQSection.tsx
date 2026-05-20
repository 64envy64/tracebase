"use client";

import { useId, useState } from "react";
import { SectionLabel } from "./brand/Primitives";
import { Reveal } from "./brand/Reveal";
import { INK } from "./brand/tokens";

/* ============================================================ */
/*  FAQSection — single-column disclosure list. Eight questions  */
/*  ordered the way a thoughtful first-time visitor or YC        */
/*  reviewer actually asks: what is it → how is it different →   */
/*  what about my data → how fast → trust failure modes → what's */
/*  the perf cost → can I see the impact → what does it cost.    */
/*                                                                */
/*  Implementation: each item is a button + grid-row-fr trick.   */
/*  Animating `grid-template-rows` from 0fr → 1fr animates the   */
/*  panel from 0 → auto without ever pinning a fixed height,     */
/*  so answers of any length expand smoothly with no clipping    */
/*  and no layout jumps elsewhere on the page.                   */
/* ============================================================ */

type FaqItem = {
  q: string;
  a: string;
};

const FAQ_ITEMS: readonly FaqItem[] = [
  {
    q: "What does Tracebase actually do?",
    a: "Captures resolved agent work — from any team, any agent — and surfaces it on the next similar run. Five failure modes it closes: repeat reasoning, forgotten file meaning, doom-loops, redundant tool calls, and context-window thrashing on long sessions.",
  },
  {
    q: "How is this different from mem0, Letta, or a vector store?",
    a: "Those are general LLM memory layers — flat retrieval over chat history. Tracebase is built for tool-driven coding agents: a pattern DB tuned for code-shape retrieval, doom-loop detection, tool-call dedup, and context folding. Vector recall is one of the five arms, not the whole thing.",
  },
  {
    q: "Does my code leave my machine?",
    a: "No. Self-hosted by default — the pattern DB is a project-local SQLite file. The hosted dashboard is optional and read-only over the same local event log. MIT license, same binary on-prem and in CI.",
  },
  {
    q: "How fast is setup?",
    a: "One command. `npx tracebase-ai init` auto-detects the active agent (Claude Code, Cursor, Codex), writes the adapter, and registers the MCP entry. Verify with `npx tracebase-ai doctor`. Under a minute on a clean install.",
  },
  {
    q: "What if it surfaces a wrong pattern?",
    a: "The agent decides. Tracebase suggests — never overrides. Patterns that stop earning their keep get demoted automatically: the lifecycle repair loop watches outcome attribution and downranks reasoning that disproves itself.",
  },
  {
    q: "Will it slow my agent down?",
    a: "No. Retrieval is a local SQLite read — fast enough that it isn't the bottleneck. The slower path is the agent's own work, which Tracebase shortens by skipping re-derivation.",
  },
  {
    q: "How do I see whether it's actually helping?",
    a: "Every retrieval, injection, agent_used, and outcome event is logged locally. `npx tracebase-ai impact` shows the 30-day funnel; the dashboard reads the same events. Injected vs used vs resolved, fully transparent — no magic.",
  },
  {
    q: "How is it priced?",
    a: "Self-hosted is free, MIT-licensed, available today. Hobby, Startup, and Enterprise tiers in the pricing section above are draft packaging — not on checkout yet. Talk to us for early access.",
  },
] as const;

/* ============================================================ */
/*  Section                                                       */
/* ============================================================ */

export function FAQSection() {
  return (
    <section
      id="faq"
      aria-labelledby="faq-heading"
      className="scroll-mt-20 py-16 md:py-24"
      style={{ color: INK.bone }}
    >
      <Reveal>
        <FaqHeader />
      </Reveal>

      <Reveal delayMs={120}>
        <div
          className="overflow-hidden rounded-xl border"
          style={{
            borderColor: "rgba(232,217,184,0.1)",
            background: INK.inkDeep,
          }}
        >
          {FAQ_ITEMS.map((item, i) => (
            <FaqRow
              key={item.q}
              q={item.q}
              a={item.a}
              isLast={i === FAQ_ITEMS.length - 1}
            />
          ))}
        </div>
      </Reveal>
    </section>
  );
}

function FaqHeader() {
  return (
    <div className="mb-10 max-w-[44rem] md:mb-12">
      <SectionLabel>faq</SectionLabel>
      <h2
        id="faq-heading"
        className="mt-3 font-hero-serif text-[clamp(1.9rem,4vw,3.2rem)] font-normal leading-[1.04] tracking-tight"
        style={{ color: INK.pearl }}
      >
        <span style={{ color: "rgba(232,217,184,0.48)" }}>Common questions.</span>{" "}
        Eight answers before you install.
      </h2>
    </div>
  );
}

/* ============================================================ */
/*  Row — disclosure pattern. Button toggles aria-expanded; the  */
/*  panel uses the grid 0fr→1fr trick so smooth expand works     */
/*  with any answer length, no JS height measurement needed.     */
/* ============================================================ */

function FaqRow({ q, a, isLast }: { q: string; a: string; isLast: boolean }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  return (
    <div
      style={{
        borderBottom: isLast ? "none" : "1px solid rgba(232,217,184,0.06)",
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center justify-between gap-4 px-6 py-5 text-left transition-colors duration-200 hover:bg-[rgba(232,217,184,0.025)] md:px-7 md:py-6"
      >
        <span
          className="text-[14.5px] font-medium tracking-tight md:text-[15.5px]"
          style={{ color: INK.pearl }}
        >
          {q}
        </span>
        <Chevron open={open} />
      </button>

      <div
        id={panelId}
        role="region"
        aria-hidden={!open}
        style={{
          display: "grid",
          gridTemplateRows: open ? "1fr" : "0fr",
          transition: "grid-template-rows 0.32s cubic-bezier(0.22, 1, 0.36, 1)",
        }}
      >
        <div style={{ overflow: "hidden" }}>
          <p
            className="px-6 pb-6 text-[13.5px] font-light leading-relaxed md:px-7 md:pb-7 md:text-[14px]"
            style={{ color: "rgba(232,217,184,0.7)" }}
          >
            {a}
          </p>
        </div>
      </div>
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  // Bone-stroked v-mark that flips to caret-up when open. Transition is
  // transform-only so it never reflows the surrounding button content.
  return (
    <svg
      aria-hidden
      width={18}
      height={18}
      viewBox="0 0 16 16"
      style={{
        flexShrink: 0,
        transform: open ? "rotate(180deg)" : "rotate(0deg)",
        transition: "transform 0.32s cubic-bezier(0.22, 1, 0.36, 1)",
        color: open ? INK.ember : INK.sand,
      }}
    >
      <path
        d="M 4 6 L 8 10 L 12 6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}
