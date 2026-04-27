"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Chip, ResultBox, StepRow } from "../brand/Primitives";
import { type CapabilityId, type ChipTone, INK } from "../brand/tokens";
import { useInView } from "../brand/useInView";

/* ============================================================ */
/*  Shared row shape — every demo speaks the same data language  */
/* ============================================================ */

type DemoRow = {
  n?: ReactNode;
  tool?: string;
  args?: ReactNode;
  note?: ReactNode;
  trailing?: ReactNode;
  muted?: boolean;
};

type ResultConfig = {
  tone: "success" | "danger" | "warning" | "info";
  title: string;
  trailing?: ReactNode;
  body: ReactNode;
};

type DemoConfig = {
  meter: { label: string; dot: string };
  headline?: ReactNode;
  rows: DemoRow[];
  result: ResultConfig;
};

/* ============================================================ */
/*  Demo configs — one per capability                            */
/* ============================================================ */

function chip(tone: ChipTone, label: string) {
  return <Chip tone={tone}>{label}</Chip>;
}

const RECALL_DEMO: DemoConfig = {
  meter: { label: "trace lookup · 190k traces indexed", dot: INK.ember },
  headline: (
    <span>
      <span style={{ color: INK.sand }}>prompt&nbsp;</span>
      <span style={{ color: INK.pearl, fontWeight: 600 }}>refactor the auth module</span>
    </span>
  ),
  rows: [
    { n: "#1842", args: "refactor auth.py module", trailing: chip("ember", "match") },
    { n: "#1207", args: "move auth to middleware", trailing: chip("sand", "similar") },
    { n: "#0931", args: "rename auth_token env", trailing: chip("sand", "similar") },
  ],
  result: {
    tone: "info",
    title: "Trace available",
    trailing: <Chip tone="ember">#1842</Chip>,
    body: "Past run resolved the same shape of problem. Agent decides whether to use it — the runtime never overrides judgement.",
  },
};

const GIST_DEMO: DemoConfig = {
  meter: { label: "semantic index · 218 files indexed", dot: INK.sand },
  rows: [
    {
      n: "py",
      tool: "src/auth.py",
      note: "Loads AUTH_TOKEN via os.getenv, validates JWT, exposes authenticate() and refresh().",
      trailing: <span style={{ color: INK.sand, fontSize: 11 }}>12.4kb · cached</span>,
    },
    {
      n: "py",
      tool: "src/config/loader.py",
      note: "Parses .env and merges with defaults. Returns Config dataclass.",
      trailing: <span style={{ color: INK.sand, fontSize: 11 }}>8.1kb · cached</span>,
    },
    {
      n: "py",
      tool: "src/middleware.py",
      note: "Mounts auth + rate-limit middleware on FastAPI app.",
      trailing: <span style={{ color: INK.sand, fontSize: 11 }}>6.7kb · cached</span>,
    },
  ],
  result: {
    tone: "success",
    title: "Recall hit",
    trailing: <Chip tone="ember">27kb saved</Chip>,
    body: "Agent recalled file meaning without re-reading bytes. Context stays lean across long horizons.",
  },
};

const LOOP_DEMO: DemoConfig = {
  meter: { label: "trace monitor · window 6 turns", dot: INK.coral },
  rows: [
    { n: "22", tool: "grep", args: <code>-r &quot;auth_token&quot; src/</code>, muted: true },
    { n: "23", tool: "grep", args: <code>-ri &quot;AUTH_TOKEN&quot; src/</code>, muted: true },
    { n: "24", tool: "rg", args: <code>&quot;auth[_-]token&quot; --hidden</code>, muted: true },
    { n: "25", tool: "grep", args: <code>-r &quot;getenv&quot; src/</code>, trailing: chip("coral", "loop") },
  ],
  result: {
    tone: "danger",
    title: "Loop detected",
    trailing: <Chip tone="coral">4 / 5 turns</Chip>,
    body: "Same approach, no new information retrieved. Suggested redirect: src/config/ — matched a resolved run.",
  },
};

const GUARD_DEMO: DemoConfig = {
  meter: { label: "tool calls · last 5 turns", dot: INK.amber },
  rows: [
    { n: "24", tool: "read", args: "src/auth.py", trailing: <span style={{ color: INK.amber, fontSize: 11 }}>×3</span> },
    { n: "25", tool: "search", args: <code>&quot;token&quot;</code>, trailing: <span style={{ color: INK.amber, fontSize: 11 }}>×4</span> },
    { n: "26", tool: "read", args: "src/auth.py", trailing: chip("amber", "repeat") },
    { n: "27", tool: "search", args: <code>&quot;token&quot;</code>, trailing: chip("amber", "repeat") },
  ],
  result: {
    tone: "warning",
    title: "Redundancy alert",
    trailing: <Chip tone="amber">2 repeats</Chip>,
    body: "Agent is re-fetching files and re-running searches still in its context window. Redirect: work with what you have — no new fetch needed.",
  },
};

const FOLD_DEMO: DemoConfig = {
  meter: { label: "horizon · 27 turns · 10.1k tokens", dot: INK.sand },
  rows: [
    {
      n: "01–08",
      args: "explore codebase · map auth flow",
      note: "Gist: auth layer touches config, jwt refresh, 3 tests.",
      trailing: <span style={{ color: INK.sand, fontSize: 11 }}>4.2k → 340</span>,
    },
    {
      n: "09–16",
      args: "identify bug surface",
      note: "Gist: refresh() never re-reads env; stale AUTH_TOKEN persists.",
      trailing: <span style={{ color: INK.sand, fontSize: 11 }}>2.8k → 180</span>,
    },
    {
      n: "17–22",
      args: "test hypothesis on refresh path",
      note: "Gist: reproduced locally — leak confirmed.",
      trailing: <span style={{ color: INK.sand, fontSize: 11 }}>3.1k → 210</span>,
    },
    { n: "23–27", args: "live window", trailing: chip("ember", "active") },
  ],
  result: {
    tone: "info",
    title: "Folded",
    trailing: <Chip tone="sand">10.1k → 730 tokens</Chip>,
    body: "Older turns kept as gist summaries. Long horizon stays coherent — no context-window thrashing.",
  },
};

const DEMO_BY_ID: Record<CapabilityId, DemoConfig> = {
  recall: RECALL_DEMO,
  gist: GIST_DEMO,
  loop: LOOP_DEMO,
  guard: GUARD_DEMO,
  fold: FOLD_DEMO,
};

/* ============================================================ */
/*  Animation timing — one source of truth. Reasoning unfolds    */
/*  sequentially: each row lands on its own beat (as if the cmd  */
/*  just finished), then a pause, then the result, then a long   */
/*  hold before the loop restarts.                               */
/* ============================================================ */

const FIRST_ROW_DELAY_MS = 280;   // breath before the first command lands
const ROW_INTERVAL_MS = 620;      // between each subsequent command
const RESULT_DELAY_MS = 720;      // pause after the last command before the result resolves
const HOLD_RESULT_MS = 6400;      // how long the resolved result sits on screen — long enough to actually read it
const RESET_PAUSE_MS = 360;       // tiny breath between hide-reset and next cycle

/* ============================================================ */
/*  Renderer                                                     */
/* ============================================================ */

export function CapabilityDemo({ id, revealDelayMs = 0 }: { id: CapabilityId; revealDelayMs?: number }) {
  const [ref, inView] = useInView<HTMLDivElement>({ threshold: 0.3 });
  const demo = DEMO_BY_ID[id];

  // `revealed` = how many rows are currently on screen (0..rows.length).
  // `resultVisible` = whether the result has resolved at the end of a run.
  // State transitions are driven by a self-scheduling timer chain so each
  // command lands on its own beat — like it's actually being executed.
  const [revealed, setRevealed] = useState(0);
  const [resultVisible, setResultVisible] = useState(false);

  useEffect(() => {
    if (!inView || typeof window === "undefined") return;

    let cancelled = false;
    let timerId: number | undefined;

    const schedule = (ms: number, fn: () => void) => {
      timerId = window.setTimeout(() => {
        if (!cancelled) fn();
      }, ms);
    };

    const prefersReducedMotion =
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    if (prefersReducedMotion) {
      // Resolve to the final frame asynchronously so we're not calling
      // setState synchronously inside the effect body.
      schedule(0, () => {
        setRevealed(demo.rows.length);
        setResultVisible(true);
      });
      return () => {
        cancelled = true;
        if (timerId !== undefined) window.clearTimeout(timerId);
      };
    }

    const revealRow = (step: number) => {
      if (step < demo.rows.length) {
        setRevealed(step + 1);
        schedule(ROW_INTERVAL_MS, () => revealRow(step + 1));
        return;
      }
      // All rows are down — wait a beat, resolve the result, hold, reset, loop.
      schedule(RESULT_DELAY_MS, () => {
        setResultVisible(true);
        schedule(HOLD_RESULT_MS, () => {
          setResultVisible(false);
          setRevealed(0);
          schedule(RESET_PAUSE_MS, () => revealRow(0));
        });
      });
    };

    schedule(revealDelayMs + FIRST_ROW_DELAY_MS, () => revealRow(0));

    return () => {
      cancelled = true;
      if (timerId !== undefined) window.clearTimeout(timerId);
    };
  }, [inView, demo.rows.length, revealDelayMs]);

  return (
    <div
      ref={ref}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      }}
    >
      <MeterRow label={demo.meter.label} dotColor={demo.meter.dot} />

      {demo.headline ? (
        <div
          style={{
            padding: "10px 12px",
            borderRadius: 6,
            background: INK.ink,
            border: "1px solid rgba(232,217,184,0.09)",
            fontSize: 12.5,
          }}
        >
          {demo.headline}
        </div>
      ) : null}

      {/*
        Stable-height layout: rows section reserves space for the
        full row count plus a slot for the running caret AND a slot
        for the result box. Without this the page jumps every time
        the demo cycles (rows mount/unmount, result toggles), which
        cascades up through the sticky-octopus column on the left.

        The numbers: each StepRow is ~36px (px-driven via
        Primitives), the RunningCaret is ~25px, and the result box
        is reserved at 132px — enough for a two-line title + body.
        Both rows-area and result-area are `position: relative`
        children inside a fixed-height parent so their content can
        absolutely-position-overlap-free without affecting outer
        height.
      */}
      <div
        style={{
          position: "relative",
          minHeight: demo.rows.length * 36 + 144,
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", minHeight: demo.rows.length * 36 }}>
            {demo.rows.slice(0, revealed).map((row, i) => (
              <StepRow
                // Index key: React mounts each new row freshly as `revealed` grows,
                // which restarts its `step-reveal` CSS animation. On reset (revealed
                // → 0) every row unmounts, so the next cycle re-animates cleanly.
                key={i}
                n={row.n}
                tool={row.tool}
                args={row.args}
                note={row.note}
                trailing={row.trailing}
                muted={row.muted}
                inView
                delayMs={0}
              />
            ))}

            {!resultVisible && revealed > 0 && revealed < demo.rows.length ? (
              <RunningCaret color={demo.meter.dot} />
            ) : null}
          </div>

          {/*
            Result slot is ALWAYS rendered at full reserved height
            so the surrounding card height never changes when the
            demo cycles. We toggle visibility instead of unmounting.
          */}
          <div
            style={{
              minHeight: 132,
              marginTop: 12,
              opacity: resultVisible ? 1 : 0,
              transition: "opacity 220ms ease-out",
              pointerEvents: resultVisible ? "auto" : "none",
            }}
            aria-hidden={!resultVisible}
          >
            <ResultBox tone={demo.result.tone} title={demo.result.title} trailing={demo.result.trailing}>
              {demo.result.body}
            </ResultBox>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================================================ */
/*  RunningCaret — tiny "cursor still thinking" hint between     */
/*  the last revealed command and the next. Uses existing        */
/*  `ink-caret` CSS keyframes; no new animation introduced.      */
/* ============================================================ */

function RunningCaret({ color }: { color: string }) {
  return (
    <div
      aria-hidden
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "7px 0",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 11,
        color: INK.sand,
      }}
    >
      <span
        style={{ width: 28, color: INK.sand, fontSize: 11, textAlign: "left" }}
      >
        <span className="ink-caret" style={{ display: "inline-block", width: 7, height: 11, background: color, verticalAlign: "-1px" }} />
      </span>
      <span style={{ letterSpacing: "0.14em", textTransform: "uppercase", fontSize: 10, color: INK.sand }}>
        running
      </span>
    </div>
  );
}

function MeterRow({ label, dotColor }: { label: string; dotColor: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        fontSize: 10,
        letterSpacing: "0.18em",
        textTransform: "uppercase",
        color: INK.sand,
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: 999,
          background: dotColor,
        }}
        className="ink-heartbeat"
      />
      <span>{label}</span>
    </div>
  );
}
