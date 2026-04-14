import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import type { ReasoningTrace } from "../types.js";

/**
 * JSONL (JSON Lines) utilities for TraceBase knowledge sharing.
 *
 * JSONL is chosen over JSON for knowledge base files because:
 *   - Git-diff friendly (one trace per line → clean diffs in PRs)
 *   - Streams naturally (no need to load entire file into memory)
 *   - Append-friendly (new traces = new lines, no rewrite)
 *   - Standard format used by OpenAI, Anthropic, and most ML tools
 */

/** Write traces to a JSONL file. */
export function writeJsonl(traces: ReasoningTrace[], filePath: string): void {
  const stream = createWriteStream(filePath, { encoding: "utf-8" });
  for (const trace of traces) {
    stream.write(JSON.stringify(trace) + "\n");
  }
  stream.end();
}

/** Read traces from a JSONL file. Returns parsed traces, skipping malformed lines. */
export async function readJsonl(filePath: string): Promise<ReasoningTrace[]> {
  const traces: ReasoningTrace[] = [];
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue; // skip empty lines and comments
    try {
      const parsed = JSON.parse(trimmed) as ReasoningTrace;
      if (parsed.id && parsed.problem?.description && parsed.solution?.summary) {
        traces.push(parsed);
      }
    } catch {
      // Skip malformed lines silently
    }
  }

  return traces;
}

/** Write traces to a JSONL string (for in-memory use). */
export function toJsonl(traces: ReasoningTrace[]): string {
  return traces.map((t) => JSON.stringify(t)).join("\n") + "\n";
}

/** Parse a JSONL string into traces. */
export function fromJsonl(content: string): ReasoningTrace[] {
  return content
    .split("\n")
    .filter((line) => line.trim() && !line.trim().startsWith("#"))
    .map((line) => {
      try {
        return JSON.parse(line) as ReasoningTrace;
      } catch {
        return null;
      }
    })
    .filter((t): t is ReasoningTrace => t !== null && !!t.id);
}
