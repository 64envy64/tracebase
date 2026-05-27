// Probe inject-context against each ON workspace. Confirm file_memory
// section appears in the additionalContext.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPT_DIR, "..", "..");
const BENCH = join(ROOT, "bench-runs", "file-memory");
const TSX = join(ROOT, "node_modules", ".bin", "tsx.cmd");
const CLI = join(ROOT, "bin", "cli.ts");
const OUT = join(BENCH, "probe-injections");
mkdirSync(OUT, { recursive: true });

const PROMPTS = {
  "alpha-http-retry":
    "The HTTP client's retry backoff isn't growing exponentially — under load, retries fire too quickly. The retry config says factor: 2 (doubling), but actual delays are flat. Fix the bug in the retry module and ensure tests pass.",
  "beta-slug":
    "The slug() function drops non-ASCII characters instead of folding them. 'café-récipé' becomes 'caf-rcip' instead of 'cafe-recipe'. Fix and ensure tests pass.",
  "gamma-ttl-cache":
    "The TTL cache leaks memory under write-only steady-state workloads. set() needs to reap expired entries. Fix and ensure tests pass.",
};

for (const [pair, prompt] of Object.entries(PROMPTS)) {
  const ws = join(BENCH, "workspaces", `${pair}.ON`);
  const payload = JSON.stringify({ prompt, cwd: ws });
  const child = spawnSync(
    TSX,
    [CLI, "inject-context", "--host", "claude-code", "--status", "compact", "--budget", "1200", "--path", ws],
    {
      cwd: ROOT,
      input: payload,
      encoding: "utf-8",
      shell: process.platform === "win32",
      env: { ...process.env, TRACEBASE_DISABLED: "0", TRACEBASE_SKIP_HOOK_SELF_HEAL: "1" },
    },
  );
  let envelope = { hookSpecificOutput: { additionalContext: "" }, systemMessage: "<parse-failed>" };
  try { envelope = JSON.parse(child.stdout); } catch {}
  const additional = envelope.hookSpecificOutput?.additionalContext ?? "";
  const hasFileMemory = additional.includes("<file_memory>");
  const hasTracebase = additional.includes("<tracebase");
  writeFileSync(join(OUT, `${pair}.txt`), additional);
  console.log(`${pair.padEnd(25)} inject_chars=${additional.length}b  has<file_memory>=${hasFileMemory}  has<tracebase>=${hasTracebase}  status='${envelope.systemMessage}'`);
}
