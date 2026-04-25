/**
 * Tool-call pattern detector for the 0.5.3 TB TOOL / TB LOOP
 * substrate. Reads the most recent `tool_observations` rows in a
 * session (oldest-first) and classifies the tail into one of four
 * shapes:
 *
 *   - `straight`: ≥3 consecutive observations sharing the same
 *     `argKey`. The agent is calling the exact same tool with the
 *     exact same allowlisted arguments back-to-back. Almost always
 *     a sign that the unlock isn't landing — e.g. retrying a Read
 *     of a file that doesn't exist, or rerunning a Bash command
 *     whose env it never fixed.
 *
 *   - `pingpong`: A→B→A→B in the last four observations. Classic
 *     "I'll edit this file. Now I'll re-read it. Now I'll edit it
 *     back. Now I'll re-read it" trap. Distinct from `straight`
 *     because adjacent calls differ — but the *pair* is repeating.
 *
 *   - `duplicate`: any single `argKey` appearing ≥2 times in the
 *     window without already qualifying as straight or pingpong.
 *     Weaker signal — the agent did the same call twice but did
 *     other things in between. Surfaces as `▣ TB TOOL repeated`,
 *     not `▣ TB LOOP`.
 *
 *   - `none`: no pattern strong enough to warn about.
 *
 * Priority order is straight > pingpong > duplicate. The caller
 * gets at most one classification per call — surfacing two
 * overlapping warnings on the same UserPromptSubmit would clutter
 * the badge for no information gain (a straight loop necessarily
 * shows up as a duplicate too).
 *
 * The detector is pure and dependency-free. It reads only
 * `argKey` (the HMAC bucket) and `toolName` — never argSummary,
 * never argument bodies, never tool_response. The cloud allowlist
 * forbids shipping any of those fields anyway, but keeping the
 * detector input narrow means a future privacy refactor can drop
 * argSummary out of `recentToolObservations` entirely without
 * touching this module.
 */

import type { ToolObservation } from "../types.js";

export type ToolPatternKind = "straight" | "pingpong" | "duplicate" | "none";

export interface ToolPatternSignal {
  kind: ToolPatternKind;
  /** Number of repetitions in the matched pattern. 0 when `kind === "none"`. */
  count: number;
  /** Tool name on the most recent matching call — drives the badge label. */
  toolName?: string;
}

/**
 * Classify a window of recent tool observations.
 *
 * Caller passes them oldest-first, exactly as
 * `BlockStore.recentToolObservations` returns them. Empty / single-
 * entry windows always return `none` — there's nothing to compare.
 */
export function detectToolPattern(observations: ToolObservation[]): ToolPatternSignal {
  if (observations.length < 2) return noSignal();

  const straight = detectStraight(observations);
  if (straight) return straight;

  const pingpong = detectPingPong(observations);
  if (pingpong) return pingpong;

  const dup = detectDuplicate(observations);
  if (dup) return dup;

  return noSignal();
}

// ---------------------------------------------------------------------------
// Internal classifiers
// ---------------------------------------------------------------------------

const STRAIGHT_MIN = 3;
const PINGPONG_MIN_LEN = 4;

function detectStraight(obs: ToolObservation[]): ToolPatternSignal | null {
  // Walk backwards from the most recent. Count how far the same
  // arg_key extends. The detector needs ≥3 consecutive matches —
  // two-in-a-row is normal flow (read, edit, re-read).
  const last = obs[obs.length - 1]!;
  let run = 1;
  for (let i = obs.length - 2; i >= 0; i--) {
    if (obs[i]!.argKey === last.argKey) run++;
    else break;
  }
  if (run < STRAIGHT_MIN) return null;
  return { kind: "straight", count: run, toolName: last.toolName };
}

function detectPingPong(obs: ToolObservation[]): ToolPatternSignal | null {
  if (obs.length < PINGPONG_MIN_LEN) return null;
  const n = obs.length;
  const a = obs[n - 1]!;
  const b = obs[n - 2]!;
  const c = obs[n - 3]!;
  const d = obs[n - 4]!;
  // Last four must shape A,B,A,B with A ≠ B.
  if (a.argKey === b.argKey) return null;
  if (a.argKey !== c.argKey) return null;
  if (b.argKey !== d.argKey) return null;
  return { kind: "pingpong", count: 2, toolName: a.toolName };
}

function detectDuplicate(obs: ToolObservation[]): ToolPatternSignal | null {
  const counts = new Map<string, { n: number; lastIdx: number }>();
  for (let i = 0; i < obs.length; i++) {
    const key = obs[i]!.argKey;
    const slot = counts.get(key);
    if (slot) {
      slot.n += 1;
      slot.lastIdx = i;
    } else {
      counts.set(key, { n: 1, lastIdx: i });
    }
  }
  let bestKey: string | null = null;
  let best = { n: 0, lastIdx: -1 };
  for (const [key, slot] of counts) {
    if (slot.n > best.n || (slot.n === best.n && slot.lastIdx > best.lastIdx)) {
      best = slot;
      bestKey = key;
    }
  }
  if (!bestKey || best.n < 2) return null;
  // Tie-breaker: name the tool from the most recent matching row.
  const toolName = obs[best.lastIdx]!.toolName;
  return { kind: "duplicate", count: best.n, toolName };
}

function noSignal(): ToolPatternSignal {
  return { kind: "none", count: 0 };
}
