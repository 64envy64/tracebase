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

### Two-Stage Retrieval

Follows the standard IR two-stage architecture (Bruch et al. 2023):

**Stage 1 — Candidate Generation** (fast, broad):
- Exact fingerprint lookup — O(1) index scan
- FTS5 full-text search with BM25 ranking
- Pre-filtered SQL by language/framework/errorType

**Stage 2 — Re-ranking** (precise, narrow):
- Jaccard token similarity (from pre-cached tokens — zero recomputation)
- Structural feature matching (from pre-cached features)
- Quality-adjusted final score, clamped to [0, 1]

### Adaptive Weight Learning (Thompson Sampling)

Signal weights are **not hardcoded** — they learn from your feedback.

Each recall result includes a per-signal breakdown (`signals` field in `RecallResult`). When you call `feedback(traceId, helpful)`, the system updates Beta distribution parameters for each signal via Thompson Sampling:

```
helpful=true  → alpha_signal += contribution
helpful=false → beta_signal  += contribution
weight = posterior_mean = alpha / (alpha + beta), normalized
```

- **Prior strength ~10** prevents wild swings early on
- **Converges** to optimal weights as feedback accumulates
- **References**: Thompson (1933), Agrawal & Goyal (2012) — provable regret bounds

```typescript
// RecallResult now includes signal attribution
const results = layer.recall({ problem: "..." });
console.log(results[0].signals);
// { fingerprint: 0, bm25: 0.72, jaccard: 0.45, structural: 0.38, cosine: 0 }

// Feedback updates weights automatically
layer.feedback(results[0].trace.id, true);

// Inspect current learned weights
console.log(layer.getWeights());
// { bm25: 0.48, jaccard: 0.31, structural: 0.21 }
```

### Deduplication

`storeTrace()` checks for existing traces with the same structural fingerprint. If found, returns the existing trace instead of creating a duplicate. This prevents middleware from polluting the database when the same prompt is sent repeatedly.

### Storage

- **SQLite with WAL mode** — Battle-tested, embedded, zero-config. Fast concurrent reads.
- **FTS5 with Porter stemming** — Full-text search that understands word variations.
- **Cached tokens/features** — Pre-computed at store time, read at recall time. Zero recomputation per candidate.
- **Prepared statements** — All frequent queries are prepared once at init.
- **Schema v2** with incremental migration from v1.

### Quality Score (Wilson Score Interval)

Each trace tracks recall count and helpfulness. Quality uses the **Wilson score interval lower bound** (Wilson, 1927) — same algorithm Reddit uses:
- Starts at 0.5 (neutral prior)
- Rewards traces with consistent positive feedback
- Penalizes traces recalled but never helpful
- Properly handles small sample sizes

### HTTP API Validation

All POST endpoints validate required fields and return 400 with clear messages. Request body limited to 1MB.

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

```bash
# Export from one machine
npx tracebase export team-knowledge.json

# Import on another
npx tracebase import team-knowledge.json
```

Duplicate traces (by ID) are automatically skipped during import.

## License

MIT
