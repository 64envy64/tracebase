# TraceBase

**Reasoning layer for AI agents — institutional memory so your agents never solve the same problem twice.**

When your AI agent solves a bug, debugs an issue, or figures out a tricky deployment problem, that knowledge disappears. The next time a similar problem comes up — for you or your teammate — the agent starts from scratch. Same tokens. Same time. Same frustration.

TraceBase captures, indexes, and recalls reasoning traces so every new task starts from your team's best work.

## How It Works

```
Agent encounters problem
        │
        ▼
┌─────────────────┐     ┌──────────────────┐
│  TraceBase   │────▶│  Fingerprint +   │
│  recall()       │     │  FTS5 Search     │
└────────┬────────┘     └──────────────────┘
         │
         ▼
   Found similar?  ──yes──▶  Inject prior solution into context
         │                   (saves tokens + time)
         no
         │
         ▼
   Agent solves it fresh
         │
         ▼
┌─────────────────┐
│  TraceBase   │──▶  Stored for next time
│  store()        │
└─────────────────┘
```

## Quick Start

```bash
# Initialize in your project
npx tracebase init

# Store a solution
npx tracebase store \
  -d "TypeError: Cannot read property 'map' of undefined in UserList" \
  -s "Added optional chaining: users?.map() — data was undefined before API loaded" \
  -l typescript -f react -e TypeError

# Recall when a similar problem comes up
npx tracebase recall "Cannot read property of undefined in React component"
```

## SDK Usage

```bash
npm install tracebase
```

```typescript
import { ReasoningLayer } from "tracebase";

const layer = new ReasoningLayer();

// Store a reasoning trace
layer.storeTrace({
  problem: {
    description: "ECONNREFUSED when calling payment API",
    errorType: "ECONNREFUSED",
    language: "typescript",
    framework: "express",
    tags: ["api", "payments"],
  },
  solution: {
    summary: "Payment service container had crashed — restarted via docker compose",
    steps: [
      { type: "analysis", description: "Checked logs, saw connection refused to port 3001" },
      { type: "action", description: "docker compose restart payments" },
      { type: "verification", description: "Confirmed API responding on port 3001" },
    ],
    outcome: "success",
    explanation: "The payments service OOMed due to a memory leak in the webhook handler",
  },
});

// Recall relevant past solutions
const results = layer.recall({
  problem: "Connection refused to payment service",
  context: { language: "typescript", framework: "express" },
});

for (const { trace, score, matchType } of results) {
  console.log(`[${matchType}] score: ${score.toFixed(2)}`);
  console.log(`  Solution: ${trace.solution.summary}`);
}

// Provide feedback to improve future recalls
layer.feedback(results[0].trace.id, true); // was helpful

layer.close();
```

## Agent Middleware

Automatically capture reasoning traces from your existing agent code:

### OpenAI

```typescript
import OpenAI from "openai";
import { ReasoningLayer, wrapOpenAI } from "tracebase";

const layer = new ReasoningLayer();
const openai = wrapOpenAI(new OpenAI(), layer);

// Use normally — traces captured automatically
const response = await openai.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Fix the TypeError in auth.ts" }],
});
```

### Anthropic

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { ReasoningLayer, wrapAnthropic } from "tracebase";

const layer = new ReasoningLayer();
const anthropic = wrapAnthropic(new Anthropic(), layer);

// Traces captured from messages.create() calls
const msg = await anthropic.messages.create({
  model: "claude-sonnet-4-20250514",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Debug the failing test" }],
});
```

### Generic Agent Wrapper

```typescript
import { ReasoningLayer, wrapAgent } from "tracebase";

const layer = new ReasoningLayer();

async function myAgent(input: string, priorContext?: string): Promise<string> {
  // Your agent logic here
  // priorContext contains recalled solutions (if any)
  return "solution";
}

const enhanced = wrapAgent(layer, myAgent, {
  agent: "my-agent",
  model: "gpt-4o",
  autoRecall: true,   // check memory before running
  autoStore: true,     // save results after running
});

const result = await enhanced("Fix the login bug");
console.log(result.output);           // agent's response
console.log(result.priorSolutions);   // solutions found in memory
```

## MCP Server (Claude Code Integration)

Run TraceBase as an [MCP](https://modelcontextprotocol.io/) server so Claude Code can directly query and store reasoning traces:

```bash
npm install @modelcontextprotocol/sdk

# Start as MCP server (stdio transport)
npx tracebase serve --mcp
```

Add to your Claude Code MCP config (`~/.claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "tracebase": {
      "command": "npx",
      "args": ["tracebase", "serve", "--mcp"]
    }
  }
}
```

**MCP Tools exposed:**
- `recall` — Find relevant past solutions
- `store` — Save a new reasoning trace
- `search` — Full-text search through memory
- `feedback` — Report if a recalled solution was helpful
- `stats` — View storage statistics

## HTTP API

```bash
npx tracebase serve --port 3781
```

```bash
# Recall
curl -X POST http://localhost:3781/recall \
  -H "Content-Type: application/json" \
  -d '{"problem": "TypeError in React component"}'

# Store
curl -X POST http://localhost:3781/store \
  -H "Content-Type: application/json" \
  -d '{"problem": {"description": "...", "tags": []}, "solution": {"summary": "...", "steps": [], "outcome": "success"}}'

# Search
curl "http://localhost:3781/search?q=TypeError&limit=5"

# Stats
curl http://localhost:3781/stats
```

## CLI Reference

```
tracebase init                     Initialize in current project
tracebase store -d "..." -s "..."  Store a reasoning trace
tracebase recall "..."             Find relevant past solutions
tracebase search "..."             Full-text search
tracebase stats                    Storage statistics
tracebase serve [--mcp] [-p PORT]  Start server
tracebase export [file]            Export traces to JSON
tracebase import <file>            Import traces from JSON
tracebase prune [-t threshold]     Remove low-quality traces
```

All commands support `--json` for machine-readable output.

## Architecture

### Matching Algorithm

TraceBase uses a multi-signal matching approach:

1. **Structural Fingerprinting** — Extracts error types, languages, frameworks, and key tokens into a canonical hash. Same problem = same fingerprint = instant O(1) match.

2. **FTS5 Full-Text Search** — SQLite's built-in full-text search with BM25 ranking. Finds traces where the words overlap significantly.

3. **Token-Based Similarity** — Jaccard similarity over normalized tokens (handles camelCase, snake_case, file paths).

4. **Structural Feature Matching** — Weighted comparison of error type, language, framework, file extension.

5. **Quality-Adjusted Ranking** — Traces that have been recalled and confirmed helpful get boosted. Uses the Wilson score interval (same algorithm Reddit uses for ranking).

### Storage

- **SQLite with WAL mode** — Battle-tested, embedded, zero-config. Fast concurrent reads.
- **FTS5 with Porter stemming** — Full-text search that understands word variations.
- **Binary embedding storage** — Ready for optional vector similarity when you want it.

### Quality Score

Each trace tracks how often it's been recalled and whether users found it helpful. The quality score uses the **Wilson score interval lower bound** — this naturally:
- Starts at 0.5 (neutral prior)
- Rewards traces with consistent positive feedback
- Penalizes traces that are recalled but never helpful
- Accounts for sample size (a trace recalled once with positive feedback isn't necessarily better than one recalled 100 times with 90% positive)

## Configuration

```json
// .tracebase/config.json
{
  "storagePath": ".tracebase/memory.db",
  "maxTraces": 100000,
  "pruneThreshold": 0.05,
  "verbose": false
}
```

## Team Sharing

Export and import reasoning databases to share institutional memory across your team:

```bash
# Export from one machine
npx tracebase export team-knowledge.json

# Import on another
npx tracebase import team-knowledge.json
```

Duplicate traces (by ID) are automatically skipped during import.

## License

MIT
