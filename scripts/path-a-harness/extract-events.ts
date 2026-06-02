#!/usr/bin/env tsx
/**
 * Path A harness: event extractor.
 *
 * Given a workspace and the trajectory's transcript path, returns:
 *   - tool_observations row count by tool (from workspace memory.db)
 *   - tool_supervision.* event counts (from analytics_events payloads)
 *   - tool_use counts by tool (from per-instance transcript jsonl)
 *   - parallel batches by tool (assistant turns with >=2 same-name tool_use)
 *   - hook attachment summary (Pre/Post counts + exit code distribution)
 *   - sequential-read-after-bash signal (>=1 Read tool_use AFTER a Bash
 *     tool_result, used by the smoke gate check 4)
 *
 * Also copies the transcript jsonl into
 * `bench-runs/tool-supervision-path-a/transcripts/<task>.<variant>.jsonl`
 * for local audit (raw transcripts are gitignored; per-trajectory JSON
 * summaries are not).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..", "..");
const PATH_A = join(ROOT, "bench-runs", "tool-supervision-path-a");

export interface EventSummary {
  toolObservationsByTool: Record<string, number>;
  toolObservationsTotal: number;
  toolSupervisionEvents: Record<string, number>;
  toolUseCountsByTool: Record<string, number>;
  parallelBatchesByTool: Record<string, number>;
  hookAttachments: {
    preCount: number;
    postCount: number;
    nonZeroExit: number;
  };
  sequentialReadAfterBash: number;
  transcriptCopiedTo: string | null;
}

function readDbEvents(workspace: string): {
  obs: Record<string, number>;
  events: Record<string, number>;
} {
  const dbPath = join(workspace, ".tracebase", "memory.db");
  if (!existsSync(dbPath)) {
    return { obs: {}, events: {} };
  }
  const db = new Database(dbPath, { readonly: true });
  const obs: Record<string, number> = {};
  const events: Record<string, number> = {};
  try {
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    ).map((t) => t.name);
    if (tables.includes("tool_observations")) {
      const rows = db.prepare("SELECT tool_name, COUNT(*) as c FROM tool_observations GROUP BY tool_name").all() as Array<{ tool_name: string; c: number }>;
      for (const r of rows) obs[r.tool_name] = r.c;
    }
    if (tables.includes("analytics_events")) {
      const rows = db.prepare("SELECT payload FROM analytics_events").all() as Array<{ payload: string }>;
      for (const r of rows) {
        let p: { event?: string } = {};
        try { p = JSON.parse(r.payload); } catch { continue; }
        if (!p.event?.startsWith("tool_supervision.")) continue;
        const key = p.event.replace("tool_supervision.", "");
        events[key] = (events[key] ?? 0) + 1;
      }
    }
  } finally {
    db.close();
  }
  return { obs, events };
}

interface TranscriptStats {
  toolUseCounts: Record<string, number>;
  parallelBatches: Record<string, number>;
  hookAttachments: { preCount: number; postCount: number; nonZeroExit: number };
  sequentialReadAfterBash: number;
}

function readTranscript(transcriptPath: string | null): TranscriptStats {
  const stats: TranscriptStats = {
    toolUseCounts: {},
    parallelBatches: {},
    hookAttachments: { preCount: 0, postCount: 0, nonZeroExit: 0 },
    sequentialReadAfterBash: 0,
  };
  if (!transcriptPath || !existsSync(transcriptPath)) return stats;

  const text = readFileSync(transcriptPath, "utf-8");
  const lines = text.split("\n").filter((l) => l.trim());

  let lastSawBashResult = false;
  for (const line of lines) {
    let row: any;
    try { row = JSON.parse(line); } catch { continue; }

    // Hook attachments
    if (row?.attachment?.type === "hook_non_blocking_error" || row?.attachment?.hookEvent) {
      const att = row.attachment;
      if (att.hookEvent === "PreToolUse") stats.hookAttachments.preCount++;
      else if (att.hookEvent === "PostToolUse") stats.hookAttachments.postCount++;
      if (typeof att.exitCode === "number" && att.exitCode !== 0) {
        stats.hookAttachments.nonZeroExit++;
      }
      continue;
    }

    // Assistant tool_use blocks
    if (row?.message?.role === "assistant" && Array.isArray(row.message.content)) {
      const tu = row.message.content.filter((c: any) => c?.type === "tool_use");
      // Per-tool counts
      const sameNameCounts = new Map<string, number>();
      for (const c of tu) {
        if (typeof c.name === "string") {
          stats.toolUseCounts[c.name] = (stats.toolUseCounts[c.name] ?? 0) + 1;
          sameNameCounts.set(c.name, (sameNameCounts.get(c.name) ?? 0) + 1);
        }
      }
      // Parallel batches: same-name appearing >=2 in one assistant turn
      for (const [name, n] of sameNameCounts) {
        if (n >= 2) stats.parallelBatches[name] = (stats.parallelBatches[name] ?? 0) + 1;
      }
      // Sequential-read-after-bash: any Read tool_use here, with lastSawBashResult set
      if (lastSawBashResult && tu.some((c: any) => c.name === "Read")) {
        stats.sequentialReadAfterBash++;
        lastSawBashResult = false;
      }
      continue;
    }

    // tool_result rows: detect Bash results
    if (row?.message?.role === "user" && Array.isArray(row.message.content)) {
      for (const c of row.message.content) {
        if (c?.type === "tool_result") {
          // tool_use_use_id alone doesn't tell us tool — defer to context:
          // mark lastSawBashResult based on presence of a recent Bash tool_use
          // (heuristic). Since we just want >=1 signal, a simpler check:
          // if any content text mentions typical bash output markers, flag.
          const text = typeof c.content === "string" ? c.content : JSON.stringify(c.content ?? "");
          if (/Test Files|tests? (?:failed|passed)|vitest|exit code|\$\s/.test(text)) {
            lastSawBashResult = true;
          }
        }
      }
    }
  }
  return stats;
}

export function extractEvents(opts: {
  workspace: string;
  transcriptPath: string | null;
  taskId: string;
  variant: "OFF" | "ON";
}): EventSummary {
  const { workspace, transcriptPath, taskId, variant } = opts;
  const { obs, events } = readDbEvents(workspace);
  const t = readTranscript(transcriptPath);

  // Copy transcript locally for audit (gitignored).
  let copiedTo: string | null = null;
  if (transcriptPath && existsSync(transcriptPath)) {
    const transcriptsDir = join(PATH_A, "transcripts");
    mkdirSync(transcriptsDir, { recursive: true });
    copiedTo = join(transcriptsDir, `${taskId}.${variant}.jsonl`);
    copyFileSync(transcriptPath, copiedTo);
  }

  const obsTotal = Object.values(obs).reduce((a, b) => a + b, 0);
  return {
    toolObservationsByTool: obs,
    toolObservationsTotal: obsTotal,
    toolSupervisionEvents: events,
    toolUseCountsByTool: t.toolUseCounts,
    parallelBatchesByTool: t.parallelBatches,
    hookAttachments: t.hookAttachments,
    sequentialReadAfterBash: t.sequentialReadAfterBash,
    transcriptCopiedTo: copiedTo,
  };
}

// CLI: tsx scripts/path-a-harness/extract-events.ts <workspace> <transcript-path> <task> <OFF|ON>
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  const [ws, tr, task, variant] = process.argv.slice(2);
  if (!ws || !task || (variant !== "OFF" && variant !== "ON")) {
    console.error("usage: extract-events.ts <workspace> <transcript-path-or-empty> <task> <OFF|ON>");
    process.exit(2);
  }
  const summary = extractEvents({
    workspace: ws,
    transcriptPath: tr || null,
    taskId: task,
    variant,
  });
  console.log(JSON.stringify(summary, null, 2));
}
