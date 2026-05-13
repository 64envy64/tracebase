// @illustrative
//
// Illustrative mockup frames for the landing CapabilityGrid. Each mockup is a
// single static frame pulled from the same fixture shape used by
// CapabilityDemo.tsx (counts, file paths, kbs, etc.). Tagged @illustrative so
// the `dynamic-numbers` regression test (tests/www/dynamic-numbers.test.ts)
// keeps marketing-shape literals confined to the demo allowlist — see the
// header of that test for the spec.
//
// Anything that needs a "real" metric must read from a runtime path, not from
// this file.

import type { ReactNode } from "react";
import { Chip } from "../brand/Primitives";
import { INK } from "../brand/tokens";

/* ============================================================ */
/*  MockupShell — a small inset "screen" sitting at the top of   */
/*  each capability card. Slightly lighter background than the   */
/*  card body so it reads as a separate surface, plus a hairline */
/*  border + dotted grid wash for texture.                       */
/* ============================================================ */

export function MockupShell({
  meter,
  dot,
  children,
  height,
}: {
  meter: string;
  dot: string;
  children: ReactNode;
  /** Fixed height of the mockup panel. Pinned (not min) so cards in the
   *  same row are visually identical regardless of how many rows their
   *  internal trace shows. The internal flex column simply distributes
   *  whatever vertical space remains after the meter is laid out. */
  height: number;
}) {
  return (
    <div
      style={{
        position: "relative",
        // No bottom border — the lighter ink background already separates the
        // mockup from anything above it, and TentacleSection embeds this
        // panel right against the card's own outer border, so an extra
        // hairline here would read as a double line.
        background: INK.ink,
        padding: "14px 16px",
        height,
        overflow: "hidden",
      }}
    >
      <DottedGridBg />
      <div
        style={{
          position: "relative",
          display: "flex",
          flexDirection: "column",
          gap: 8,
          height: "100%",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 9.5,
            letterSpacing: "0.22em",
            textTransform: "uppercase",
            color: INK.sand,
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: 999,
              background: dot,
            }}
            className="ink-heartbeat"
          />
          <span>{meter}</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, justifyContent: "center", flex: 1 }}>
          {children}
        </div>
      </div>
    </div>
  );
}

function DottedGridBg() {
  return (
    <svg
      aria-hidden
      width="100%"
      height="100%"
      style={{ position: "absolute", inset: 0, opacity: 0.06, pointerEvents: "none" }}
    >
      <defs>
        <pattern id="cap-mock-dots" x="0" y="0" width="22" height="22" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="0.7" fill={INK.bone} />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#cap-mock-dots)" />
    </svg>
  );
}

function MockLine({
  n,
  body,
  trailing,
  muted,
  highlight,
}: {
  n: ReactNode;
  body: ReactNode;
  trailing?: ReactNode;
  muted?: boolean;
  highlight?: boolean;
}) {
  // The highlight cue (looped ember wash + inset 2px stripe on the left edge)
  // is driven entirely by the .mock-highlight-pulse class in globals.css so
  // that the animation can keyframe both background and box-shadow at once.
  // Don't set inline background here when highlighted: an inline style would
  // win against the keyframes for background-color and freeze the row.
  return (
    <div
      className={highlight ? "mock-highlight-pulse" : undefined}
      style={{
        display: "grid",
        gridTemplateColumns: "34px minmax(0,1fr) auto",
        alignItems: "center",
        gap: 8,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 11,
        lineHeight: 1.4,
        color: muted ? "rgba(232,217,184,0.42)" : INK.bone,
        opacity: muted ? 0.78 : 1,
        padding: "3px 6px",
        borderRadius: 4,
        // No inline background when highlighted — the CSS class drives it.
        background: highlight ? undefined : "transparent",
      }}
    >
      <span style={{ color: INK.sand, fontSize: 10 }}>{n}</span>
      <span style={{ minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {body}
      </span>
      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>{trailing}</span>
    </div>
  );
}

/* ============================================================ */
/*  Per-capability mockups — one static frame each. Numbers and  */
/*  file paths mirror CapabilityDemo so the cards stay truthful  */
/*  to the underlying runtime behaviour.                         */
/* ============================================================ */

export function RecallMockup() {
  return (
    <MockupShell meter="trace lookup · 190k indexed" dot={INK.ember} height={148}>
      <MockLine n="#1842" body="refactor auth.py module" trailing={<Chip tone="ember" size="sm">match</Chip>} highlight />
      <MockLine n="#1207" body="move auth to middleware" trailing={<Chip tone="sand" size="sm">similar</Chip>} />
      <MockLine n="#0931" body="rename auth_token env" trailing={<Chip tone="sand" size="sm">similar</Chip>} />
    </MockupShell>
  );
}

export function LoopMockup() {
  return (
    <MockupShell meter="trace monitor · window 6 turns" dot={INK.coral} height={148}>
      <MockLine n="22" body={<><span style={{ color: INK.pearl, fontWeight: 600 }}>grep </span>auth_token src/</>} muted />
      <MockLine n="23" body={<><span style={{ color: INK.pearl, fontWeight: 600 }}>grep </span>AUTH_TOKEN src/</>} muted />
      <MockLine n="24" body={<><span style={{ color: INK.pearl, fontWeight: 600 }}>rg </span>auth[_-]token --hidden</>} muted />
      <MockLine n="25" body={<><span style={{ color: INK.pearl, fontWeight: 600 }}>grep </span>getenv src/</>} trailing={<Chip tone="coral" size="sm">loop</Chip>} highlight />
    </MockupShell>
  );
}

export function GistMockup() {
  return (
    <MockupShell meter="semantic index · 218 files" dot={INK.sand} height={124}>
      <MockLine
        n="py"
        body={<><span style={{ color: INK.pearl, fontWeight: 600 }}>src/auth.py</span></>}
        trailing={<span style={{ color: INK.sand, fontSize: 10 }}>12.4kb · cached</span>}
      />
      <MockLine
        n="py"
        body={<><span style={{ color: INK.pearl, fontWeight: 600 }}>src/config/loader.py</span></>}
        trailing={<span style={{ color: INK.sand, fontSize: 10 }}>8.1kb · cached</span>}
      />
    </MockupShell>
  );
}

export function GuardMockup() {
  return (
    <MockupShell meter="tool calls · last 5 turns" dot={INK.amber} height={124}>
      <MockLine
        n="24"
        body={<><span style={{ color: INK.pearl, fontWeight: 600 }}>read </span>src/auth.py</>}
        trailing={<span style={{ color: INK.amber, fontSize: 10 }}>×3</span>}
      />
      <MockLine
        n="26"
        body={<><span style={{ color: INK.pearl, fontWeight: 600 }}>search </span>&quot;token&quot;</>}
        trailing={<Chip tone="amber" size="sm">repeat</Chip>}
        highlight
      />
    </MockupShell>
  );
}

export function FoldMockup() {
  return (
    <MockupShell meter="horizon · 27 turns · 10.1k" dot={INK.sand} height={124}>
      <MockLine
        n="01–08"
        body="explore codebase"
        trailing={<span style={{ color: INK.sand, fontSize: 10 }}>4.2k → 340</span>}
      />
      <MockLine
        n="17–22"
        body="test hypothesis"
        trailing={<span style={{ color: INK.sand, fontSize: 10 }}>3.1k → 210</span>}
      />
      <MockLine
        n="23–27"
        body="live window"
        trailing={<Chip tone="ember" size="sm">active</Chip>}
        highlight
      />
    </MockupShell>
  );
}
