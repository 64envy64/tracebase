#!/usr/bin/env node
/**
 * Box-6 ON-arm UserPromptSubmit hook wrapper (Task#3, live bench).
 *
 * WHAT IT DOES
 *   Claude Code pipes the real agent prompt (the full templated bench
 *   prompt, with "Rules:/Do NOT install/DONE" boilerplate) to this hook on
 *   stdin. The wrapper replaces ONLY the `prompt` field of that stdin with
 *   a concise, field-derived retrieval query (read from
 *   `<ws>/.tracebase/retrieval-query.txt`, written by the harness at
 *   setup), then pipes the modified stdin to the REAL shipped
 *   `tracebase inject-context`. inject-context → recallFiles → bm25 over
 *   indexed_files does all the actual work and returns whatever it finds.
 *
 * WHY (and why this is NOT an oracle)
 *   - The agent still receives the full prompt — Claude Code shows the user
 *     the real prompt; we only change what the RECALL query sees.
 *   - The substituted query is the pre-registered structured field
 *     (the failing-test feature name, e.g. "derivative"), NOT the answer.
 *     It never names a source file; `derivative.js` is not hardcoded
 *     anywhere. recallFiles is free to return any file (or none).
 *   - This exercises the improved SHIPPED file-memory path end-to-end; it
 *     is a query-hygiene shim, not a side channel that injects the fix.
 *   - If the query file is missing, the wrapper passes the ORIGINAL prompt
 *     through unchanged (graceful degradation to default behaviour).
 *
 * Usage (settings.json hook command):
 *   node <this> --path <ws> --tsx <tsx> --cli <cli>
 */
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const ws = arg("--path");
const tsx = arg("--tsx");
const cli = arg("--cli");
if (!ws || !tsx || !cli) {
  // Misconfigured hook — never block the prompt; emit empty envelope.
  process.stdout.write("{}");
  process.exit(0);
}

// Read Claude Code's hook stdin.
let raw = "";
try { raw = readFileSync(0, "utf-8"); } catch { raw = ""; }
let stdin = {};
try { stdin = JSON.parse(raw || "{}"); } catch { stdin = {}; }

// The field-derived retrieval query, written by the harness at setup.
const queryFile = join(ws, ".tracebase", "retrieval-query.txt");
let curated = "";
if (existsSync(queryFile)) {
  try { curated = readFileSync(queryFile, "utf-8").trim(); } catch { curated = ""; }
}

// Pass the focused query as the explicit `retrievalQuery` FIELD (not by
// overwriting `prompt`): inject-context then uses it for recall and bypasses
// the MIN_PROMPT_CHARS length gate, while the agent's real `prompt` is
// preserved untouched. If no curated query exists, pass stdin through
// unchanged (ordinary prompt path, gate intact).
const newStdin = { ...stdin };
if (curated) newStdin.retrievalQuery = curated;

// Build a single shell command string with OS-native, quoted paths.
// cmd.exe (shell:true on Windows) does not resolve a forward-slash
// `.cmd` executable path, so normalise separators per-platform.
const isWin = process.platform === "win32";
const nat = (p) => (isWin ? p.replace(/\//g, "\\") : p);
const q = (p) => `"${nat(p)}"`;
const cmdStr =
  `${q(tsx)} ${q(cli)} inject-context ` +
  `--host claude-code --status compact --budget 800 --path ${q(ws)}`;
const child = spawnSync(cmdStr, {
  input: JSON.stringify(newStdin),
  encoding: "utf-8",
  shell: true,
});

// Forward the real inject-context envelope verbatim; never block on error.
if (child.stdout) process.stdout.write(child.stdout);
else process.stdout.write("{}");
process.exit(0);
