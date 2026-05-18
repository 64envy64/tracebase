import { InkSplatter } from "./brand/Marks";
import { CardEyebrow, Chip } from "./brand/Primitives";
import { Reveal } from "./brand/Reveal";
import { type ChipTone, INK } from "./brand/tokens";

/** Coral tail used for the "leaking" pain accent — already used elsewhere as the danger-tone text colour. */
const PAIN_ACCENT = "#ef8a74";

/* ============================================================ */
/*  ForgettingTax — the "problem" beat.                          */
/*  Sits between Hero and RunSplit so the reader feels the cost  */
/*  of amnesia before the runtime appears. Five rows, one per    */
/*  capability the product later resolves — setup that foreshad- */
/*  ows the five-arm octopus without naming it yet.              */
/* ============================================================ */

type PainRow = {
  n: string;
  label: string;
  example: string;
  cost: string;
  tone: ChipTone;
};

/**
 * Each row maps to one of CAPABILITIES downstream (recall / gist / loop /
 * guard / fold). The order matches so the reader later connects the pain to
 * the arm without us spelling it out.
 */
/**
 * Compact pain rows — each row is now a single line: label · example, with a
 * cost chip on the right. We dropped the italic example sub-line; it was
 * doubling the row height without adding new information for a reader who is
 * already nodding along.
 */
const PAIN_ROWS: readonly PainRow[] = [
  { n: "01", label: "Re-derivation", example: "same fix from scratch every run", cost: "×17 / mo", tone: "coral" },
  { n: "02", label: "Amnesic files", example: "re-reading a module owned yesterday", cost: "40k tokens", tone: "amber" },
  { n: "03", label: "Doom-loops", example: "four attempts, same region of code", cost: "3 re-greps", tone: "coral" },
  { n: "04", label: "Redundant fetches", example: "one answer, billed three times", cost: "×3 billed", tone: "amber" },
  { n: "05", label: "Context thrash", example: "Monday's decision dropped by Wednesday", cost: "−12 turns", tone: "sand" },
] as const;

/* ============================================================ */
/*  Section                                                       */
/* ============================================================ */

export function ForgettingTax() {
  return (
    <section
      id="problem"
      aria-labelledby="problem-heading"
      className="scroll-mt-20 py-16 md:py-24"
      style={{ color: INK.bone, background: INK.ink }}
    >
      <div className="mx-auto max-w-[1080px] px-5 sm:px-6">
        <Reveal>
          <ProblemHeader />
        </Reveal>

        <Reveal delayMs={120}>
          <TaxList />
        </Reveal>

        <Reveal delayMs={220}>
          <Kicker />
        </Reveal>
      </div>
    </section>
  );
}

/* ============================================================ */
/*  Header — eyebrow, muted / ember headline, short body.        */
/* ============================================================ */

function ProblemHeader() {
  // Body paragraph removed — it restated the headline. The five pain rows
  // below carry the concrete examples, so the header is now just the lockup
  // and the headline.
  return (
    <header className="mb-8 max-w-[44rem] md:mb-10">
      <CardEyebrow
        number="00"
        chipLabel="Problem"
        chipTone="coral"
        status="leaking"
        accent={PAIN_ACCENT}
        numberColor={PAIN_ACCENT}
      />
      <h2
        id="problem-heading"
        className="mt-4 font-hero-serif text-[clamp(1.9rem,4vw,3.2rem)] font-normal leading-[1.04] tracking-tight"
        style={{ color: INK.pearl }}
      >
        <span style={{ color: "rgba(232,217,184,0.48)" }}>Agents are brilliant once.</span>{" "}
        You pay for it <span style={{ color: INK.ember }}>every run</span>.
      </h2>
    </header>
  );
}

/* ============================================================ */
/*  TaxList — five rows of concrete pain, each with a cost chip. */
/*  Static markup, no client state beyond the Reveal wrapper.    */
/* ============================================================ */

function TaxList() {
  return (
    <ol
      className="relative overflow-hidden rounded-xl border"
      style={{
        borderColor: "rgba(232,217,184,0.12)",
        background: INK.inkDeep,
        listStyle: "none",
      }}
    >
      <InkSplatter
        size={96}
        opacity={0.06}
        className="pointer-events-none absolute"
        style={{ right: -18, top: -22 }}
      />
      <InkSplatter
        size={64}
        color={INK.coral}
        opacity={0.08}
        className="pointer-events-none absolute"
        style={{ left: -12, bottom: -18 }}
      />

      <div className="relative">
        {PAIN_ROWS.map((row, i) => (
          <TaxRow key={row.n} row={row} isLast={i === PAIN_ROWS.length - 1} />
        ))}
      </div>
    </ol>
  );
}

function TaxRow({ row, isLast }: { row: PainRow; isLast: boolean }) {
  // Single-line layout: number · bold label · em-dash · muted example · cost.
  // The example flexes (truncates on narrow screens) so the cost chip never
  // jumps to a second row.
  return (
    <li
      className="grid items-center gap-3 px-5 py-3.5 md:gap-4 md:px-7 md:py-4"
      style={{
        gridTemplateColumns: "28px minmax(0, 1fr) auto",
        borderBottom: isLast ? "none" : "1px solid rgba(232,217,184,0.06)",
      }}
    >
      <span
        className="font-mono text-[11px] tracking-[0.16em]"
        style={{ color: INK.sand }}
      >
        {row.n}
      </span>

      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <span
          className="text-[14px] font-medium tracking-tight md:text-[15px]"
          style={{ color: INK.pearl }}
        >
          {row.label}
        </span>
        <span
          className="min-w-0 truncate text-[12.5px] font-light leading-relaxed md:text-[13px]"
          style={{ color: "rgba(232,217,184,0.5)" }}
        >
          {row.example}
        </span>
      </div>

      <Chip tone={row.tone} size="sm">
        {row.cost}
      </Chip>
    </li>
  );
}

/* ============================================================ */
/*  Kicker — the punchline + the bridge question that hands off  */
/*  to RunSplit directly below.                                  */
/* ============================================================ */

function Kicker() {
  // Bridge question removed — it was rhetorical setup the RunSplit below
  // already answers visually. One punchline is enough.
  return (
    <p
      className="mt-8 font-hero-serif text-[clamp(1.05rem,2vw,1.4rem)] font-normal leading-[1.3] tracking-tight md:mt-10"
      style={{ color: INK.pearl }}
    >
      Each line above is a paid second the agent will spend again next run.{" "}
      <span style={{ color: "rgba(232,217,184,0.54)" }}>Unless something writes it down.</span>
    </p>
  );
}
