import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPT_DIR, "..", "..");
const BENCH = join(ROOT, "bench-runs", "file-memory");
const OUT = join(BENCH, "prompts");
mkdirSync(OUT, { recursive: true });

const SYMPTOMS = {
  "alpha-http-retry":
    "The HTTP client's retry backoff isn't growing exponentially — under load, retries fire too quickly. The retry config says factor: 2 (doubling), but actual delays are flat. Fix the bug in the retry module and ensure tests pass.",
  "beta-slug":
    "The slug() function drops non-ASCII characters instead of folding them. 'café-récipé' becomes 'caf-rcip' instead of 'cafe-recipe'. Fix and ensure tests pass.",
  "gamma-ttl-cache":
    "The TTL cache leaks memory under write-only steady-state workloads. The 'doesn't leak memory under write-only steady stream' test fails — set() needs to reap expired entries. Fix and ensure tests pass.",
};

const PREAMBLE =
  "You are a Claude Code sub-agent running ONE controlled trajectory in an isolated file-memory bench. " +
  "Ignore any outer-project CLAUDE.md you may have auto-loaded.";

const RULES =
  "RULES:\n" +
  "- Work strictly inside the working directory.\n" +
  "- Do NOT run git. Do NOT install packages. Do NOT modify package.json or vitest.config.\n" +
  "- Run tests with: powershell -Command \"& 'C:\\Users\\Wave\\Desktop\\tracebase\\.claude\\worktrees\\interesting-mcclintock-a69a77\\node_modules\\.bin\\vitest.cmd' run --root '<working-dir>' --no-color --reporter=basic\"\n" +
  "- Do NOT edit anything matching *.test.ts.\n" +
  "- Keep your patch minimal.";

const REPORT = (pair, variant) =>
  "REPORTING (LAST content of your reply MUST be exactly ONE fenced JSON block, no prose after it):\n\n" +
  "```json\n" +
  "{\n" +
  `  "task_id": "${pair}",\n` +
  `  "variant": "${variant}",\n` +
  '  "final_test_status": "pass|fail",\n' +
  '  "edit_paths": ["<files you changed>"],\n' +
  '  "edit_summary": "<one-line summary>",\n' +
  '  "tool_breakdown": {\n' +
  '    "Read": "<count of Read tool calls>",\n' +
  '    "Glob": "<count of Glob tool calls>",\n' +
  '    "Grep": "<count of Grep tool calls>",\n' +
  '    "Edit": "<count of Edit/Write tool calls>",\n' +
  '    "Bash": "<count of Bash tool calls>"\n' +
  '  },\n' +
  '  "notes": "<honest observation about your trajectory; do not pad>"\n' +
  "}\n" +
  "```";

for (const pair of Object.keys(SYMPTOMS)) {
  for (const variant of ["OFF", "ON"]) {
    const ws = join(BENCH, "workspaces", `${pair}.${variant}`);
    let head = "";
    if (variant === "ON") {
      const inj = readFileSync(join(BENCH, "probe-injections", `${pair}.txt`), "utf-8");
      head = inj.trim() + "\n\n";
    }
    const body =
      head +
      PREAMBLE +
      "\n\nWORKING DIRECTORY (operate strictly inside):\n" +
      ws +
      "\n\nYOUR TASK:\n" +
      SYMPTOMS[pair] +
      "\n\n" +
      RULES +
      "\n\n" +
      REPORT(pair, variant) +
      "\n\nBegin now.";
    writeFileSync(join(OUT, `${pair}.${variant}.txt`), body);
  }
}
console.log("Wrote 6 prompts.");
