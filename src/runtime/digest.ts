/**
 * Session-digest extractor + scope helper. Shared between the
 * Claude Code `PreCompact` hook
 * (`src/cli/commands/capture-context.ts`) and the SDK
 * `runtime.saveContext()` method (`src/sdk/runtime.ts`) per
 * PLAN-0.5.4 §4 / 0.5.5 §3a.
 *
 * Same extraction rationale as `src/runtime/recall.ts` and
 * `src/runtime/observe-tools.ts`: the canonical digest extractor
 * lives here so the SDK runtime cannot drift from the Claude Code
 * behaviour the 0.5.3 test suite pins down.
 *
 * Privacy invariants (PLAN-0.5.4 §2.2):
 *   - The digest is bounded at `MAX_DIGEST_CHARS` (1200) chars.
 *   - `detectLeakageExtended` runs on the final string before
 *     return — absolute paths / API keys / env-line shapes
 *     reject the whole digest rather than storing a partial.
 *   - No paraphrase, no code blocks, no tool args.
 */

import { createHash } from "node:crypto";
import { boundField, detectLeakageExtended } from "../core/guard.js";

// ---------------------------------------------------------------------------
// Bounds — load-bearing privacy gates
// ---------------------------------------------------------------------------

/** Hard cap on the digest character length. */
export const MAX_DIGEST_CHARS = 1200;
/** Most recent user-question first lines kept. */
export const MAX_USER_LINES = 5;
/** Most recent assistant section headers kept. */
export const MAX_ASSISTANT_HEADERS = 4;
/** Most recent assistant bullet first-items kept. */
export const MAX_ASSISTANT_BULLETS = 6;

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * Scope key for `session_digest` facts. Uses the dotted hierarchy
 * BlockStore's scope resolver understands so a query at this scope
 * recalls digests for THIS session AND parent-scope facts (TB MEMORY
 * file_semantic at `project`, plus any `global` overrides).
 *
 * Sibling scopes (different sessions under the same project) are
 * NEVER prefixes of each other, so cross-session digests stay
 * isolated by construction.
 *
 * The hash is sha256 truncated to 12 hex chars — selectivity
 * helper, not a security boundary. Raw `session_id` would land
 * verbatim in the scope column; hashing keeps the column free of
 * PII-shaped opaque ids.
 */
export function sessionScope(sessionId: string): string {
  const hash = createHash("sha256").update(sessionId).digest("hex").slice(0, 12);
  return `project.session.${hash}`;
}

/**
 * Distil a bounded digest from a JSONL transcript tail. Rules per
 * PLAN-0.5 §5.2: last N user-question first lines + assistant
 * section headers + assistant bullet list first-items. No
 * paraphrase. No code blocks. No tool args.
 *
 * Returns `null` when no section clears the bar — the caller treats
 * that as "skipped, no content".
 */
export function extractDigest(raw: string): string | null {
  const lines = raw.split("\n");
  const userQuestions: string[] = [];
  const assistantHeaders: string[] = [];
  const assistantBullets: string[] = [];

  // Walk lines as JSONL transcript entries. Anything that doesn't
  // parse as JSON is skipped (meta lines, partial writes). Only
  // `type: "user"` string content + `type: "assistant"` text blocks
  // are mined.
  for (const line of lines) {
    if (!line || line.length === 0) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const e = entry as {
      type?: string;
      message?: { role?: string; content?: unknown };
    };

    if (e.type === "user" && typeof e.message?.content === "string") {
      const first = firstLineStripped(e.message.content);
      if (first && first.length >= 12 && first.length <= 200) {
        userQuestions.push(first);
      }
    } else if (e.type === "assistant" && Array.isArray(e.message?.content)) {
      for (const block of e.message!.content as unknown[]) {
        if (!block || typeof block !== "object") continue;
        const b = block as { type?: string; text?: unknown };
        if (b.type !== "text" || typeof b.text !== "string") continue;
        const text = stripCodeBlocks(b.text);
        for (const header of extractMarkdownHeaders(text)) {
          assistantHeaders.push(header);
        }
        for (const bullet of extractBulletFirstItems(text)) {
          assistantBullets.push(bullet);
        }
      }
    }
  }

  // Pick the tail slice of each collection — most recent signal wins.
  const userKeep = userQuestions.slice(-MAX_USER_LINES);
  const headerKeep = assistantHeaders.slice(-MAX_ASSISTANT_HEADERS);
  const bulletKeep = assistantBullets.slice(-MAX_ASSISTANT_BULLETS);

  const sections: string[] = [];
  if (userKeep.length > 0) {
    sections.push("Recent user questions:\n" + userKeep.map((q) => `- ${q}`).join("\n"));
  }
  if (headerKeep.length > 0) {
    sections.push("Discussion topics:\n" + headerKeep.map((h) => `- ${h}`).join("\n"));
  }
  if (bulletKeep.length > 0) {
    sections.push("Key points:\n" + bulletKeep.map((b) => `- ${b}`).join("\n"));
  }
  if (sections.length === 0) return null;

  const joined = sections.join("\n\n");
  const bounded = boundField(joined, MAX_DIGEST_CHARS, "digest").value;
  if (bounded.length < 40) return null;

  // Leakage scanner runs on the exact string that would land in
  // SQLite. Absolute paths / API keys / env lines at this boundary
  // kill the digest — we refuse to store partial content.
  if (detectLeakageExtended(bounded)) return null;

  return bounded;
}

/**
 * Bridge between the SDK's `{ role, content }[]` shape and the
 * `extractDigest` helper above (which expects a JSONL transcript).
 * The SDK runtime calls this from `saveContext({ turns })` so
 * SDK-derived digests look identical to PreCompact-derived ones —
 * same rules, same bounds, same leakage scan.
 */
export function extractDigestFromTurns(
  turns: ReadonlyArray<{ role: "user" | "assistant"; content: string }>,
): string | null {
  const lines: string[] = [];
  for (const t of turns) {
    if (typeof t.content !== "string" || t.content.length === 0) continue;
    if (t.role === "user") {
      lines.push(JSON.stringify({ type: "user", message: { role: "user", content: t.content } }));
    } else if (t.role === "assistant") {
      lines.push(
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: t.content }],
          },
        }),
      );
    }
  }
  if (lines.length === 0) return null;
  return extractDigest(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function firstLineStripped(content: string): string {
  // Skip Claude Code meta wrappers — NOT real user input. The
  // list is kept in lock-step with `extractUserText` in
  // `capture-turn.ts` (0.5.6 §5 added local-command-stdout /
  // local-command-output).
  const trimmed = content.trim();
  if (!trimmed) return "";
  if (/^<(command-name|local-command-caveat|local-command-stdout|local-command-output|system-reminder|tracebase)[\s>]/.test(trimmed)) {
    return "";
  }
  const firstLine = trimmed.split("\n", 1)[0]!.trim();
  return firstLine;
}

function stripCodeBlocks(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "");
}

function extractMarkdownHeaders(text: string): string[] {
  const headers: string[] = [];
  for (const raw of text.split("\n")) {
    const m = /^#{1,4}\s+(.+?)\s*$/.exec(raw.trim());
    if (m && m[1]) {
      const h = m[1].trim();
      if (h.length >= 4 && h.length <= 120) headers.push(h);
    }
  }
  return headers;
}

function extractBulletFirstItems(text: string): string[] {
  const bullets: string[] = [];
  const lines = text.split("\n");
  let prevWasBullet = false;
  for (const raw of lines) {
    const line = raw.trim();
    const m = /^[-*•]\s+(.+)$/.exec(line);
    if (!m) {
      prevWasBullet = false;
      continue;
    }
    if (prevWasBullet) continue; // only the FIRST item of each list
    prevWasBullet = true;
    const b = m[1]!.trim();
    // Skip bullet lines that themselves look like code / paths.
    if (b.startsWith("`") && b.endsWith("`")) continue;
    if (b.length >= 10 && b.length <= 180) bullets.push(b);
  }
  return bullets;
}
