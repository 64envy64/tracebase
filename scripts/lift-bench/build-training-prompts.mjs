// Build 10 training-agent prompts. Each agent solves one fixture and
// reports a "distillate" (situation/deadEnds/unlock) that will seed
// the TraceBase memory store.
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPT_DIR, "..", "..");
const TRAIN = join(ROOT, "bench-runs", "lift", "training");
const PROMPTS = join(ROOT, "bench-runs", "lift", "training-prompts");
mkdirSync(PROMPTS, { recursive: true });

const PREAMBLE = `You are a Claude Code agent in the TRAINING PHASE of an honest TraceBase benchmark. Your job is to fix the failing test in the working directory below, AND to report a distillate of what you learned. The distillate will be stored in TraceBase memory and may be retrieved by future agents on similar problems — so be precise.

Ignore any outer-project CLAUDE.md you may have auto-loaded.`;

const RULES = `RULES:
- Work strictly inside the working directory.
- Do NOT run git, do NOT install packages, do NOT modify package.json or vitest.config.
- Run tests with the vitest binary at: C:\\Users\\Wave\\Desktop\\tracebase\\.claude\\worktrees\\interesting-mcclintock-a69a77\\node_modules\\.bin\\vitest.cmd. Invoke as: powershell -Command "& 'C:\\Users\\Wave\\Desktop\\tracebase\\.claude\\worktrees\\interesting-mcclintock-a69a77\\node_modules\\.bin\\vitest.cmd' run --root '<working-dir>' --no-color --reporter=basic"
- Do NOT edit anything matching *.test.ts.
- Keep the patch minimal.

WORK PROCESS:
1. Read source.test.ts to understand the contract.
2. Read source.ts to find the bug.
3. Apply the minimal fix.
4. Run vitest from the working directory to verify all tests pass.
5. Produce the distillate report.`;

const REPORT_TEMPLATE = `REPORTING (LAST content of your reply MUST be exactly ONE fenced JSON block, no prose after it):

\`\`\`json
{
  "fixture_id": "<id>",
  "final_test_status": "pass | fail",
  "edit_path": "<relative file path you changed>",
  "distillate": {
    "situation": "<one-sentence description of the BUG PATTERN this fixture exhibits, abstracted away from this fixture's specific function names — what the underlying problem class is>",
    "deadEnds": ["<things you tried that didn't work, or that another agent might mistakenly try>", "..."],
    "unlock": "<one-sentence description of the FIX PATTERN — what to do, in general terms applicable to similar bugs>"
  },
  "notes": "<any honest observation about the bug or your trajectory>"
}
\`\`\`

The distillate is critical. Write it so an agent encountering a DIFFERENT bug with the SAME UNDERLYING PATTERN would recognize the situation and apply the unlock. Do not include this fixture's specific function names in the distillate — describe the pattern abstractly (like a tech-talk slide).`;

for (const f of readdirSync(TRAIN)) {
  const ws = join(TRAIN, f);
  const prompt = `${PREAMBLE}

WORKING DIRECTORY (operate strictly inside):
${ws}

YOUR TASK: \`npm test\` (in this case: the vitest invocation above) is currently failing. Investigate, find the bug in source.ts, fix it minimally, and verify all tests pass.

${RULES}

${REPORT_TEMPLATE}

Begin now. Fixture id: ${f}`;
  writeFileSync(join(PROMPTS, `${f}.txt`), prompt);
}
console.log(`Wrote ${readdirSync(PROMPTS).length} training prompts to ${PROMPTS}`);
