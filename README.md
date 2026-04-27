# TraceBase

**Agents that compound their own intelligence.**

TraceBase captures every solved problem as a reasoning trace and feeds it back into future runs. Your agents don't just execute — they accumulate expertise. Every run is built on every run before it.

```
1st call: "CORS error in Express"  → agent solves from scratch       → trace stored
2nd call: "Access-Control missing" → prior solution injected as hint → faster, cheaper
3rd call: same class of problem    → solved in one shot              → tokens saved
```

---

## Why

AI agents are stateless. They forget everything between sessions. When a similar problem comes up again — for you or a teammate — the agent re-derives the same solution from scratch. Same tokens. Same latency. Same risk of a different (wrong) answer.

TraceBase gives agents **institutional memory**:
- **Capture** — every problem-solution pair is stored as a reasoning trace
- **Recall** — before each LLM call, check if a similar problem was solved before
- **Inject** — if a high-confidence match is found, add it to the system prompt
- **Learn** — feedback improves recall quality over time (Thompson Sampling)

The result: agents that get **more reliable** and **cheaper** with every run.

---

## Install

```bash
npm install tracebase-ai
```

## Three Ways to Use TraceBase

### 1. SDK Middleware (recommended — zero friction)

Wrap your OpenAI or Anthropic client. Every call automatically recalls prior solutions, injects them as hints, and stores the result.

```typescript
import OpenAI from "openai";
import { ReasoningLayer, wrapOpenAI } from "tracebase-ai";

const layer = new ReasoningLayer();
const openai = wrapOpenAI(new OpenAI(), layer, {
  // recall-before-call: inject prior solutions into system prompt
  minScore: 0.72,     // only high-confidence matches (default)
  skipExactMatch: true // don't inject if user is re-asking the same question
});

// That's it. Every call is now optimized.
const response = await openai.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Fix the CORS error in our Express API" }],
});

// Behind the scenes:
// 1. recall() checked memory → found a prior CORS solution (score: 0.85)
// 2. Injected into system prompt: <prior_solution confidence="85%">...</prior_solution>
// 3. GPT-4o used the hint → faster, more accurate response
// 4. Result stored as new trace → future recalls benefit

// Works identically for Anthropic:
import Anthropic from "@anthropic-ai/sdk";
const anthropic = wrapAnthropic(new Anthropic(), layer, { minScore: 0.72 });
```

**Streaming is fully supported** — traces are captured after the stream completes.

### 2. MCP Server (for Claude Code / AI IDEs)

Connect TraceBase as an MCP server. Claude Code automatically recalls before solving and stores after solving.

```bash
npx tracebase serve --mcp
```

Add to `~/.claude/claude_desktop_config.json`:

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

Claude Code gets two key tools:
- **recall** — "Before solving any problem, check institutional memory"
- **store** — "After solving any problem, save the solution for future agents"

### 3. Direct SDK

Full control over when to store and recall.

```typescript
import { ReasoningLayer } from "tracebase-ai";

const layer = new ReasoningLayer();

// Store
layer.storeTrace({
  problem: {
    description: "ECONNREFUSED when calling payment API",
    errorType: "ECONNREFUSED",
    language: "typescript",
    framework: "express",
    tags: ["api", "payments"],
  },
  solution: {
    summary: "Payment service container crashed — restarted via docker compose",
    steps: [
      { type: "analysis", description: "Checked logs, saw connection refused on port 3001" },
      { type: "action", description: "docker compose restart payments" },
      { type: "verification", description: "Confirmed API responding" },
    ],
    outcome: "success",
    explanation: "The payments service OOMed due to a memory leak in webhook handler",
  },
});

// Recall
const results = layer.recall({
  problem: "Connection refused to payment service",
  context: { language: "typescript", framework: "express" },
});

// Each result includes signal breakdown
console.log(results[0].signals);
// { fingerprint: 0, bm25: 0.72, jaccard: 0.45, structural: 0.38, cosine: 0 }

// Feedback improves future recalls (Thompson Sampling)
layer.feedback(results[0].trace.id, true);

layer.close();
```

---

## Host Parity

Capabilities by host integration. Every cell in this table is backed by an integration test in `tests/parity/host-matrix.test.ts`.

| Host                          | Recall | FileMem | Fold | PromptCache | Tool          | Loop          |
| ----------------------------- | :----: | :-----: | :--: | :---------: | :-----------: | :-----------: |
| Claude Code (hooks)           |   ✓    |    ✓    |  ✓   |     n/a¹    | ✓ preventive  | ✓ preventive  |
| `wrapAnthropic`               |   ✓    |    ✓    |  ✓   |      ✓      | ◐ post-hoc²   | ◐ post-hoc²   |
| `wrapOpenAI`                  |   ✓    |    ✓    |  ✓   |      ✓      | ◐ post-hoc²   | ◐ post-hoc²   |
| `wrapAgent` (string→string)   |   ✓    |    ✓    |  ✓   |     n/a³    | ◐ post-hoc²   | ◐ post-hoc²   |
| `wrapGeneric` (LangChain)     |   ✓    |    ✓    |  ✓   |     n/a³    | ◐ post-hoc²   | ◐ post-hoc²   |
| `wrapGeneric` (LangGraph)     |   ✓    |    ✓    |  ✓   |     n/a³    | ◐ post-hoc²   | ◐ post-hoc²   |
| `wrapGeneric` (Agent SDK)     |   ✓    |    ✓    |  ✓   |     n/a³    | ◐ post-hoc²   | ◐ post-hoc²   |

Legend:
- **✓** — exercised end-to-end via the host's real path.
- **◐** — partial: capability exists but is observed AFTER the call rather than blocking before it.
- **preventive** — TraceBase decides BEFORE the tool runs (block / warn / allow).
- **post-hoc** — TraceBase records what happened; the loop redirect hint surfaces on the NEXT turn, not this one.

Footnotes:
1. Claude Code's prompt cache is provider-side — attached by the model server itself; no hook-layer involvement. Effective in your Claude Code session regardless.
2. Bare wrappers don't intercept tool dispatch. Wire `runtime.observeToolBatch(...)` after each tool batch (or use `wrapGeneric`'s `observeTools` callback) to enable Tool/Loop signals on the NEXT call.
3. Generic agent wrappers don't see provider request shapes. If the underlying call goes through `wrapAnthropic` / `wrapOpenAI` inside the generic flow, prompt cache fires from there. Cache savings (when supported by the provider) **may reduce billed/processed prefix tokens** on cache hits; the actual reduction is what the provider reports back via `cache_read_input_tokens` (Anthropic) or `prompt_tokens_details.cached_tokens` (OpenAI). TraceBase never estimates cache savings — it counts only what the provider reports.

Capability glossary:
- **Recall** — prior-fix lookup (`ReasoningLayer.recall` / `runtime.beforeRun`).
- **FileMem** — file-index-backed snippet recall (`recallFiles`).
- **Fold** — same-session chunk recall from rolling context fold (`recallChunks`).
- **PromptCache** — provider-side prefix caching (Anthropic `cache_control` + cached-token reporting; OpenAI auto-cache + cached-token reporting).
- **Tool** — duplicate / shape-of-loop tool detection.
- **Loop** — anchor-recall redirect when a duplicate / pingpong / straight-line tool pattern fires.

---

## How It Works

### The Recall-Before-Call Loop

```
User message arrives
        │
        ├── 1. recall()  ──── fingerprint match? ──── O(1) index lookup
        │                ──── FTS5 BM25 search   ──── full-text ranking
        │                ──── structural filter   ──── language/framework/error
        │                ──── cosine similarity   ──── (when embeddings enabled)
        │
        ├── 2. Score ≥ 0.72?
        │     YES → inject <prior_solution> into system prompt
        │     NO  → proceed without hint
        │
        ├── 3. LLM call (with or without hint)
        │
        └── 4. store() → trace saved for future recalls
```

### Multi-Signal Ranking

TraceBase combines four signals for matching, following the two-stage retrieval architecture (Bruch et al., 2023):

| Signal | Stage | What it catches |
|--------|-------|----------------|
| **Fingerprint** | 1 | Exact same problem (O(1) lookup) |
| **BM25 (FTS5)** | 1 | Same keywords, different phrasing |
| **Jaccard** | 2 | Overlapping technical tokens |
| **Structural** | 2 | Same error type / language / framework |
| **Cosine** | 2 | Semantically similar (when embeddings enabled) |

### Adaptive Weights (Thompson Sampling)

Signal weights are **not hardcoded** — they learn from your feedback.

Each signal has a Beta distribution prior. When you call `feedback(traceId, helpful)`:
- `helpful=true` → `alpha += contribution`
- `helpful=false` → `beta += contribution`
- Weight = `alpha / (alpha + beta)`, normalized across active signals

References: Thompson (1933); Agrawal & Goyal (2012) — provable regret bounds; Chapelle & Li (2011).

### Semantic Embeddings (Optional)

Add OpenAI embeddings for semantic recall — catches problems where the words are different but the meaning is the same.

```typescript
import OpenAI from "openai";
import { ReasoningLayer, createOpenAIEmbeddings } from "tracebase-ai";

const layer = new ReasoningLayer();
layer.setEmbeddingProvider(createOpenAIEmbeddings(new OpenAI()));

// Async API when embeddings are active
const trace = await layer.storeTraceAsync({ ... });  // computes + stores vector
const results = await layer.recallAsync({ ... });     // cosine similarity included
```

### Quality Score (Wilson Interval)

Each trace tracks recall count and helpfulness. Quality uses the **Wilson score interval lower bound** (Wilson, 1927) — same algorithm Reddit uses:
- Starts at 0.5 (neutral prior)
- Rewards traces with consistent positive feedback
- Penalizes traces that are recalled but never confirmed helpful
- Properly handles small sample sizes

### Deduplication

`storeTrace()` detects duplicate problems by structural fingerprint. Same problem = same fingerprint = returns the existing trace instead of creating a duplicate. Prevents database pollution from repeated middleware calls.

---

## CLI

```bash
npx tracebase init                     # Initialize in current project
npx tracebase store -d "..." -s "..."  # Store a reasoning trace
npx tracebase recall "..."             # Find relevant past solutions
npx tracebase search "..."             # Full-text search
npx tracebase stats                    # Storage statistics
npx tracebase serve [--mcp] [-p PORT]  # Start server (MCP or HTTP)
npx tracebase export [file]            # Export traces to JSON
npx tracebase import <file>            # Import traces from JSON
npx tracebase prune [-t threshold]     # Remove low-quality traces
```

All commands support `--json` for machine-readable output.

## HTTP API

```bash
npx tracebase serve --port 3781

curl -X POST localhost:3781/recall -d '{"problem": "CORS error Express"}'
curl -X POST localhost:3781/store  -d '{"problem": {...}, "solution": {...}}'
curl -X POST localhost:3781/feedback -d '{"traceId": "...", "helpful": true}'
curl localhost:3781/search?q=TypeError
curl localhost:3781/stats
curl localhost:3781/health
```

## Team Sharing

```bash
npx tracebase export team-knowledge.json   # one machine
npx tracebase import team-knowledge.json   # another machine
```

Duplicate traces (by ID) are automatically skipped.

---

## Self-Hosted vs TraceBase Cloud

TraceBase is fully open source and runs locally with zero external dependencies. For teams that need more, **TraceBase Cloud** (coming soon) adds:

| Feature | Self-Hosted (OSS) | Cloud |
|---------|-------------------|-------|
| Local SQLite storage | ✓ | ✓ |
| Recall-before-call injection | ✓ | ✓ |
| Adaptive weight learning | ✓ | ✓ |
| MCP / HTTP / SDK | ✓ | ✓ |
| **Cross-team sync** | — | ✓ (shared memory across machines) |
| **Cloud backups** | — | ✓ (automatic, encrypted) |
| **Analytics dashboard** | — | ✓ (recall rates, savings, quality) |
| **Team management** | — | ✓ (roles, access control) |
| **Managed embeddings** | — | ✓ (no API keys needed) |
| **Retention policies** | — | ✓ (auto-archive, compliance) |

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

## License

MIT — [github.com/64envy64/tracebase](https://github.com/64envy64/tracebase)
