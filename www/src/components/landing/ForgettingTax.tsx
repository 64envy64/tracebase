import { InkDrop, InkSplatter } from "./brand/Marks";
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
const PAIN_ROWS: readonly PainRow[] = [
  {
    n: "01",
    label: "Re-derivation",
    example: "Same CORS fix derived from scratch — seventeen times this month.",
    cost: "×17 / mo",
    tone: "coral",
  },
  {
    n: "02",
    label: "Amnesic files",
    example: "40k tokens spent re-reading a module your agent owned yesterday.",
    cost: "40k tokens",
    tone: "amber",
  },
  {
    n: "03",
    label: "Doom-loops",
    example: "Four attempts, three re-greps, same region of code.",
    cost: "3 re-greps",
    tone: "coral",
  },
  {
    n: "04",
    label: "Redundant fetches",
    example: "One answer, billed three times across the same run.",
    cost: "×3 billed",
    tone: "amber",
  },
  {
    n: "05",
    label: "Context thrash",
    example: "Monday's decision dropped out of the window by Wednesday.",
    cost: "−12 turns",
    tone: "sand",
  },
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
  return (
    <header className="mb-10 max-w-[44rem] md:mb-12">
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
      <p
        className="mt-5 max-w-[36rem] text-[14px] font-light leading-relaxed md:text-[15px]"
        style={{ color: "rgba(232,217,184,0.68)" }}
      >
        The same bug. The same file, re-read. The same loop. Your agent
        rediscovers it from scratch — with your tokens, every time.
      </p>
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
  return (
    <li
      className="grid items-baseline gap-4 px-5 py-4 md:px-7 md:py-5"
      style={{
        gridTemplateColumns: "34px minmax(0, 1fr) auto",
        borderBottom: isLast ? "none" : "1px solid rgba(232,217,184,0.06)",
      }}
    >
      <span
        className="font-mono text-[11px] tracking-[0.16em]"
        style={{ color: INK.sand }}
      >
        {row.n}
      </span>

      <div className="min-w-0">
        <span
          className="text-[14px] font-medium tracking-tight md:text-[15px]"
          style={{ color: INK.pearl }}
        >
          {row.label}
        </span>
        <span
          className="mt-1 block text-[12.5px] font-light italic leading-relaxed md:text-[13px]"
          style={{ color: "rgba(232,217,184,0.56)" }}
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
  return (
    <div className="mt-10 flex flex-col gap-3 md:mt-12">
      <p
        className="font-hero-serif text-[clamp(1.15rem,2.2vw,1.55rem)] font-normal leading-[1.25] tracking-tight"
        style={{ color: INK.pearl }}
      >
        Intelligence without memory isn&apos;t intelligence.{" "}
        <span style={{ color: "rgba(232,217,184,0.54)" }}>It&apos;s a receipt.</span>
      </p>
      <p
        className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.2em]"
        style={{ color: INK.sand }}
      >
        <InkDrop size={8} color={INK.ember} className="ink-pulse" />
        <span>What if every solved problem stayed solved?</span>
      </p>
    </div>
  );
}
