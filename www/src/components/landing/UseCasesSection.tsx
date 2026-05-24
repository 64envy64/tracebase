import type { ReactNode } from "react";
import { SectionLabel } from "./brand/Primitives";
import { Reveal } from "./brand/Reveal";
import { INK } from "./brand/tokens";

/* ============================================================ */
/*  UseCasesSection — four team shapes where the same runtime    */
/*  earns its keep today. Engineering is the validated primary,  */
/*  the other three are adjacent surfaces where MCP / SDK        */
/*  middleware architecturally applies on the same store.        */
/* ============================================================ */

type UseCase = {
  id: string;
  title: string;
  body: string;
  Icon: () => ReactNode;
};

const USE_CASES: readonly UseCase[] = [
  {
    id: "engineering",
    title: "Engineering",
    body: "Claude Code, Cursor, Codex. Resolved fixes and migrations compound across PRs — no re-derivation.",
    Icon: IconCode,
  },
  {
    id: "support",
    title: "Support & customer ops",
    body: "Same-shape tickets, same playbook. Past resolutions surface for the next agent before re-work.",
    Icon: IconChat,
  },
  {
    id: "sales",
    title: "Sales & RevOps",
    body: "Won-deal motions and CRM workflows reused across reps. The next outreach starts from what closed.",
    Icon: IconTimeline,
  },
  {
    id: "internal-ops",
    title: "Internal ops & research",
    body: "Runbooks, docs, and long PDFs keep their meaning. Past extractions surface on revisit.",
    Icon: IconDocument,
  },
] as const;

/* ============================================================ */
/*  Section                                                       */
/* ============================================================ */

export function UseCasesSection() {
  return (
    <section
      id="use-cases"
      aria-labelledby="use-cases-heading"
      className="scroll-mt-20 py-16 md:py-24"
      style={{ color: INK.bone }}
    >
      <Reveal>
        <UseCasesHeader />
      </Reveal>

      <Reveal delayMs={120}>
        <div
          className="grid gap-px overflow-hidden rounded-xl border sm:grid-cols-2 lg:grid-cols-4"
          style={{
            borderColor: "rgba(232,217,184,0.1)",
            background: "rgba(232,217,184,0.1)",
          }}
        >
          {USE_CASES.map((uc) => (
            <UseCaseTile key={uc.id} useCase={uc} />
          ))}
        </div>
      </Reveal>
    </section>
  );
}

function UseCasesHeader() {
  return (
    <div className="mb-10 max-w-[44rem] md:mb-12">
      <SectionLabel>use cases</SectionLabel>
      <h2
        id="use-cases-heading"
        className="mt-3 font-hero-serif text-[clamp(1.9rem,4vw,3.2rem)] font-normal leading-[1.04] tracking-tight"
        style={{ color: INK.pearl }}
      >
        <span style={{ color: "rgba(232,217,184,0.48)" }}>One memory layer.</span>{" "}
        Earning its keep across teams.
      </h2>
      <p
        className="mt-5 max-w-[34rem] text-[14px] font-light leading-relaxed md:text-[15px]"
        style={{ color: "rgba(232,217,184,0.68)" }}
      >
        Engineering is the validated wedge; the other three are surfaces where the same runtime — MCP, SDK middleware, hosted control plane — architecturally fits on the same store.
      </p>
    </div>
  );
}

/* ============================================================ */
/*  Tile — icon + title + one-line body. Compact, scannable.    */
/*  Same hairline-gap rhythm as the FAQ grid: 1px overlay        */
/*  background shows through gap-px, so dividers feel native.    */
/* ============================================================ */

function UseCaseTile({ useCase }: { useCase: UseCase }) {
  const Icon = useCase.Icon;
  return (
    <article
      className="flex h-full min-h-[170px] flex-col gap-4 p-6 md:p-7"
      style={{ background: INK.inkDeep }}
    >
      <span
        className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border"
        style={{
          borderColor: "rgba(232,217,184,0.14)",
          background: "rgba(232,217,184,0.04)",
        }}
        aria-hidden
      >
        <Icon />
      </span>
      <h3
        className="text-[15px] font-medium tracking-tight md:text-[15.5px]"
        style={{ color: INK.pearl }}
      >
        {useCase.title}
      </h3>
      <p
        className="text-[13px] font-light leading-relaxed"
        style={{ color: "rgba(232,217,184,0.66)" }}
      >
        {useCase.body}
      </p>
    </article>
  );
}

/* ============================================================ */
/*  Icons — line-art glyphs in bone with a single ember accent.  */
/*  Each is 22×22 inside the 40×40 inset square so the four      */
/*  tiles read as one visual set, not four different sources.   */
/* ============================================================ */

const STROKE = INK.bone;
const ACCENT = INK.ember;

function IconCode() {
  // Classic angle-bracket pair `< >` with an ember dot between —
  // marks "code is what passes through".
  return (
    <svg viewBox="0 0 24 24" width={22} height={22} aria-hidden>
      <path
        d="M 9 7 L 4 12 L 9 17"
        stroke={STROKE}
        strokeWidth="1.7"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M 15 7 L 20 12 L 15 17"
        stroke={STROKE}
        strokeWidth="1.7"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="1.6" fill={ACCENT} />
    </svg>
  );
}

function IconTimeline() {
  // Horizontal axis with three marks; middle is the ember accent —
  // the runtime stays present across the whole horizon.
  return (
    <svg viewBox="0 0 24 24" width={22} height={22} aria-hidden>
      <line x1="3" y1="12" x2="21" y2="12" stroke={STROKE} strokeWidth="1.7" strokeLinecap="round" />
      <circle cx="6" cy="12" r="2" stroke={STROKE} strokeWidth="1.6" fill="none" />
      <circle cx="12" cy="12" r="2.2" fill={ACCENT} />
      <circle cx="18" cy="12" r="2" stroke={STROKE} strokeWidth="1.6" fill="none" />
    </svg>
  );
}

function IconDocument() {
  // Page outline with a folded corner and three text lines.
  // Ember dot on the corner fold marks "we know what this file means".
  return (
    <svg viewBox="0 0 24 24" width={22} height={22} aria-hidden>
      <path
        d="M 7 4 L 14 4 L 18 8 L 18 20 L 7 20 Z"
        stroke={STROKE}
        strokeWidth="1.6"
        fill="none"
        strokeLinejoin="round"
      />
      <path
        d="M 14 4 L 14 8 L 18 8"
        stroke={STROKE}
        strokeWidth="1.6"
        fill="none"
        strokeLinejoin="round"
      />
      <line x1="9.5" y1="13" x2="15.5" y2="13" stroke={STROKE} strokeWidth="1.4" strokeLinecap="round" />
      <line x1="9.5" y1="16" x2="14" y2="16" stroke={STROKE} strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="14" cy="8" r="1.4" fill={ACCENT} />
    </svg>
  );
}

function IconChat() {
  // Speech bubble with tail — customer / support ops. Ember dot
  // inside marks "the resolution is already in here".
  return (
    <svg viewBox="0 0 24 24" width={22} height={22} aria-hidden>
      <path
        d="M 4 7 C 4 5.9 4.9 5 6 5 L 18 5 C 19.1 5 20 5.9 20 7 L 20 14 C 20 15.1 19.1 16 18 16 L 12 16 L 8 19 L 8 16 L 6 16 C 4.9 16 4 15.1 4 14 Z"
        stroke={STROKE}
        strokeWidth="1.6"
        fill="none"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="10.5" r="1.7" fill={ACCENT} />
    </svg>
  );
}
