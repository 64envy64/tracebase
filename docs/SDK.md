# TraceBase SDK

> Framework-neutral memory + observability for LLM apps. The same
> five capabilities Claude Code gets through hooks
> (TB TRACE / MEMORY / CONTEXT / TOOL / LOOP) — exposed to
> OpenAI / Anthropic / LangChain / your own runtime.
>
> Released in 0.5.4. See `docs/PLAN-0.5.4.md` for the full design.

## What you get

| Capability | What it does | When it fires |
|---|---|---|
| **TB TRACE** | Recalls reusable patterns from prior debugging sessions | On every non-trivial prompt |
| **TB MEMORY** | Surfaces semantic project facts (file roles, conventions, env requirements) | On every non-trivial prompt |
| **TB CONTEXT** | Stores a session digest with TTL so context survives compaction | When you call `runtime.saveContext()` |
| **TB TOOL** | Detects duplicate tool calls within a session | On the next prompt after `runtime.observeToolBatch()` |
| **TB LOOP** | Detects straight loops + ping-pong patterns in tool sequences | Same — louder badge label |

All five run **locally**. The cloud allowlist forbids any prompt /
response / tool body / file path / session id / argSummary / argKey
from ever leaving the machine — only aggregate counts ship.

## Quick start

```bash
npx tracebase init
```

That's it for Claude Code users. For SDK consumers:

```ts
import { ReasoningLayer, createRuntime } from "tracebase-ai";

const layer = new ReasoningLayer();
const runtime = createRuntime(layer, {
  source: "openai",
  sessionId: "user-123",
  onBadge: (ev) => console.log(ev.label),
});

const before = await runtime.beforeRun({ prompt: userQuestion });
// inject `before.additionalContext` into your LLM call however you want
const response = await openai.chat.completions.create({...});
await runtime.afterRun({ userText: userQuestion, assistantText: response.choices[0].message.content });
```

## Wrappers

Each wrapper has the same lifecycle: `beforeRun → injectContext →
LLM call → observeTools? → afterRun → return original output`.
**TraceBase failures NEVER break the wrapped call**. Throws inside
`onBadge` are swallowed.

### OpenAI

```ts
import OpenAI from "openai";
import { ReasoningLayer, wrapOpenAI } from "tracebase-ai";

const layer = new ReasoningLayer();
const openai = wrapOpenAI(new OpenAI(), layer, {
  minScore: 0.72,
  onBadge: (ev) => console.log(ev.label),
  // sessionId: "your-session-id",   // optional, enables TB CONTEXT/TOOL/LOOP
  // projectPath: "/path/to/repo",   // optional, defaults to findProjectRoot(cwd)
});

await openai.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "..." }],
});
```

### Anthropic

```ts
import Anthropic from "@anthropic-ai/sdk";
import { ReasoningLayer, wrapAnthropic } from "tracebase-ai";

const layer = new ReasoningLayer();
const anthropic = wrapAnthropic(new Anthropic(), layer, {
  minScore: 0.72,
  onBadge: (ev) => console.log(ev.label),
});

await anthropic.messages.create({
  model: "claude-opus-4-7",
  max_tokens: 1024,
  messages: [{ role: "user", content: "..." }],
});
```

### wrapAgent (string → string)

```ts
import { ReasoningLayer, wrapAgent } from "tracebase-ai";

const layer = new ReasoningLayer();
const wrapped = wrapAgent(
  layer,
  async (input, priorContext) => {
    // your agent logic; `priorContext` carries the recalled patterns
    return await myAgentFn(input + (priorContext ?? ""));
  },
  {
    agent: "my-agent",
    onBadge: (ev) => console.log(ev.label),
  },
);

const { output, priorSolutions, traceId } = await wrapped("Fix the bug in auth.ts");
```

### LangGraph (via wrapGeneric)

LangGraph nodes are async functions over a state object. The same
`wrapGeneric` shape works — pull the prompt out of state and write
the runtime's `additionalContext` into a known slot the next node
reads.

```ts
import { StateGraph } from "@langchain/langgraph";
import { ReasoningLayer, createRuntime, wrapGeneric } from "tracebase-ai";

interface AgentState {
  messages: { role: "user" | "assistant"; content: string }[];
  priorContext?: string;
}

const layer = new ReasoningLayer();
const runtime = createRuntime(layer, {
  source: "langgraph",
  sessionId: "user-123",
  onBadge: (ev) => console.log(ev.label),
});

async function plannerNode(state: AgentState): Promise<AgentState> {
  // your planner LLM call ...
  return { ...state, messages: [...state.messages, { role: "assistant", content: "..." }] };
}

const wrappedPlanner = wrapGeneric(layer, plannerNode, {
  source: "langgraph",
  sessionId: "user-123",
  runtime,                                    // share one runtime across nodes
  extractPrompt: (s) => s.messages.at(-1)?.content ?? "",
  injectContext: (s, ctx) => ({ ...s, priorContext: ctx }),
  extractOutput: (s) => s.messages.at(-1)?.content ?? "",
});

const graph = new StateGraph<AgentState>({ /* ... */ })
  .addNode("planner", wrappedPlanner)
  .addEdge(/* ... */);
```

**TB TOOL / TB LOOP for LangGraph** — wire `runtime.observeToolBatch`
to your tool-end callback handler (see the LangChain example
below); the runtime handles cross-node detection automatically
because all nodes share the same `sessionId`.

Don't forget `await runtime.flush()` and `await runtime.close()` at
graph teardown so the auto-sync coordinator drains cleanly.

### Claude Agent SDK style

The Claude Agent SDK exposes a session-oriented async loop. Wrap
each turn through the runtime; tool calls observed by the SDK
flow into `observeToolBatch`.

```ts
import { ReasoningLayer, createRuntime } from "tracebase-ai";

const layer = new ReasoningLayer();
const runtime = createRuntime(layer, {
  source: "claude-agent-sdk",
  sessionId: session.id,
  onBadge: (ev) => session.log(ev.label),
});

for await (const turn of session.turns()) {
  // BEFORE the model call — recall + emit BadgeEvents
  const before = await runtime.beforeRun({ prompt: turn.userMessage });
  if (before.additionalContext) {
    turn.system = (turn.system ?? "") + "\n\n" + before.additionalContext;
  }

  const response = await turn.run();

  // AFTER — record observed tool calls + queue capture
  if (response.toolCalls.length > 0) {
    await runtime.observeToolBatch({
      sessionId: session.id,
      toolCalls: response.toolCalls.map((t) => ({
        toolName: t.name,
        toolInput: t.input,
        toolUseId: t.id,
        outcome: t.error ? "error" : "ok",
      })),
    });
  }
  await runtime.afterRun({
    userText: turn.userMessage,
    assistantText: response.text,
    sessionId: session.id,
  });
}

await runtime.flush();
await runtime.close();
```

The Claude Agent SDK has no mandatory peer dep — userland imports
the SDK; TraceBase only needs the per-turn input/output shapes the
example destructures.

### LangChain (via wrapGeneric)

```ts
import { ChatOpenAI } from "@langchain/openai";
import { ReasoningLayer, wrapGeneric } from "tracebase-ai";

const layer = new ReasoningLayer();
const model = new ChatOpenAI();

const invokeWithMemory = wrapGeneric(
  layer,
  model.invoke.bind(model),
  {
    source: "langchain",
    sessionId: "user-123",
    extractPrompt: (input) => {
      // pull the user-facing prompt out of the LangChain input
      if (typeof input === "string") return input;
      if (Array.isArray(input)) return input.map(m => m.content).join("\n");
      return String(input);
    },
    extractOutput: (output) => output.content as string,
    onBadge: (ev) => console.log(ev.label),
  },
);

const response = await invokeWithMemory("What's the migration order in this codebase?");
```

To enable **TB TOOL / TB LOOP** for LangChain runs, wire
`observeToolBatch` to your callback handler:

```ts
import { createRuntime } from "tracebase-ai";

const runtime = createRuntime(layer, { sessionId: "user-123" });

// In your LangChain agent's tool-end callback:
await runtime.observeToolBatch({
  sessionId: "user-123",
  toolCalls: [{ toolName: "search", toolInput: { query: "..." } }],
});

// On the next runtime.beforeRun(), TB TOOL/LOOP will fire if a
// pattern is detected.
```

## BadgeEvent

```ts
type BadgeEventKind = "trace" | "memory" | "context" | "tool" | "loop";

interface BadgeEvent {
  kind: BadgeEventKind;
  label: string;             // "▣ TB LOOP  straight × 3 (Read)"
  count?: number;
  toolName?: string;
  queryId?: string;
  tokens?: number;           // recall-side only
  ts: number;                // wall-clock ms
  source?: string;           // "openai" | "anthropic" | "agent" | "langchain" | ...
}
```

**What's NOT on a BadgeEvent** (compile-checked + runtime-tested):
`prompt`, `response`, `userText`, `assistantText`, `tool_input`,
`tool_response`, `argSummary`, `argKey`, `sessionId`, `file_path`,
`code`, `transcript`. These live in the local SQLite store; the
cloud allowlist forbids all of them from ever shipping.

## Runtime API

```ts
const runtime = createRuntime(layer, {
  // identity
  sessionId?: string,
  projectPath?: string,
  source?: "openai" | "anthropic" | "agent" | "generic" | "langchain" | "langgraph" | "claude-agent-sdk",
  onBadge?: (ev: BadgeEvent) => void,

  // capability switches (default true)
  enableTrace?: boolean,
  enableMemory?: boolean,
  enableContext?: boolean,
  enableTool?: boolean,
  enableLoop?: boolean,

  // background sync (defaults: 30 s debounce / 5 min cap)
  autoSync?: boolean,
  syncDebounceMs?: number,
  syncMaxIntervalMs?: number,
});

// Five capability surfaces:
await runtime.beforeRun({ prompt, sessionId?, projectPath? });
   // → { additionalContext, badgeEvents, queryId? }
await runtime.observeToolBatch({ sessionId, projectPath?, toolCalls });
   // → { recorded }
await runtime.saveContext({ sessionId, projectPath?, turns?, digest? });
   // → { factId }
await runtime.afterRun({ userText, assistantText, sessionId?, projectPath? });
   // → void  (queued; flush() awaits)

// Lifecycle:
await runtime.flush();   // drain queued capture + sync
await runtime.close();   // release SQLite + clear timers (idempotent)
```

## Background sync

When the project is linked to a hosted control plane and `autoSync`
is on (default: `true` iff cloud is linked), the runtime
automatically posts **aggregate counts only** to the dashboard:

- `duplicateCount`, `loopCount`
- `toolFamilyCounts` — `read` / `search` / `shell` / `edit` /
  `write` / `web` / `task` / `other`. Literal Claude tool names
  never reach the wire.
- `errorClassCounts` — seven enumerated leakage-pattern classes;
  counts only, never matched values.

Sync is **debounced** (30 s default), **capped** (5 min default),
and runs on its own timer with `.unref()` so it never holds your
process open. `runtime.flush()` and `runtime.close()` are the
explicit durability surfaces. The library installs **no global
process exit handlers** — that's the host application's job.

```ts
// Force-flush in test / shutdown paths:
await runtime.flush();   // 5 s soft timeout
```

The CLI's `tracebase sync` command is still available as an
explicit diagnostic flush — it's the same code path, just
manually invoked.

## Privacy

| Field | Local SQLite | BadgeEvent | Cloud |
|---|---|---|---|
| user prompt | no (only embeddings + retrieval scores) | no | no |
| LLM response | optional (truncated, configurable cap) | no | no |
| tool_input body | no — projected to `arg-hidden` for sensitive tools | no | no |
| tool_response body | no — never read at any layer | no | no |
| file paths | repo-relative only; outside-cwd → `arg-hidden` | no | no |
| session id | yes | no | no — only `installationId` ships |
| `argSummary` / `argKey` | yes (HMAC-keyed locally) | no | no |
| reasoning blocks | yes | no | no |
| project facts | yes | no | no |
| session digests | yes (TTL 14 d) | no | no |
| recall counts | n/a | yes (`count`) | yes (aggregated) |
| TB TOOL / LOOP detection | n/a | yes (`label` + `count`) | yes (aggregated) |

The cloud allowlist (`src/cli/cloud-allowlist.ts`) is
primitive-only-leaves with explicit nested specs. Every test
fixture seeded with a forbidden field asserts it's stripped before
the wire — `tests/cli/cloud-allowlist.test.ts` and
`tests/runtime/tool-family.test.ts` are the regression gates.

## When something fails

The runtime never throws into the wrapped LLM call. Failures are
classified:

| Failure | Behaviour |
|---|---|
| Project not initialised | `beforeRun` returns empty + no events |
| `onBadge` throws synchronously | swallowed; the wrapped call completes |
| SQLite open / read fails | empty result; the wrapped call completes |
| Cloud sync 5xx / network error | exponential backoff, max 6 attempts, never blocks the request |
| Closed runtime + further use | `runtime.beforeRun` etc. reject with `Error("runtime closed")` |
| Leakage scanner hits a stored field | the field is rejected; the call completes |
