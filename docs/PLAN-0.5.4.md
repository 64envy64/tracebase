# PLAN-0.5.4 — SDK parity + automatic aggregate sync

> Status: **approved with amendments — ready to implement**.
>
> Reviewer-approved with four amendments folded in below:
> §4 approved as-is · §5.1 amended (no global process exit handlers from a
> library; timers must `unref()` where available; explicit `flush()` / `close()`
> are the durability path) · §6 amended (normalised tool *families* not literal
> Claude tool names) · §7 amended (50 ms is target, 150 ms is fallback ceiling
> with documented reason — never add network I/O to hit a bench) · §10 amended
> (0.5.4 must ship through §8.8; auto-sync is in-scope).
>
> Successor to PLAN-0.5.md (0.5.0–0.5.3 covered there). This file is the single
> source of truth for 0.5.4 scope, performance budgets, and privacy invariants.
> A potential 0.5.5 release split is described in §10.

## §1 Goal

Bring framework-neutral SDK / enterprise / LangChain users to **full five-capability
parity** with what `npx tracebase init` ships for Claude Code today:

| Capability | Claude Code surface (0.5.3) | SDK surface (0.5.4) |
|---|---|---|
| TB TRACE — reasoning reuse | `UserPromptSubmit` hook | `runtime.beforeRun()` |
| TB MEMORY — semantic project facts | `UserPromptSubmit` hook | `runtime.beforeRun()` |
| TB CONTEXT — session digest | `PreCompact` hook | `runtime.saveContext()` |
| TB TOOL — duplicate / repeat tool detection | `PostToolBatch` write + `UserPromptSubmit` detect | `runtime.observeToolBatch()` write + `runtime.beforeRun()` detect |
| TB LOOP — straight / ping-pong tool loops | same | same |

And replace the manual `tracebase sync` UX with a debounced, batched, best-effort
**background auto-sync** that never touches the hot path.

## §2 Non-negotiable invariants

These are enforced by tests at every layer and gate the release.

### §2.1 Hot-path latency
- `beforeRun`, `observeToolBatch`, `afterRun`, `saveContext` **never await network I/O**.
- Failed cloud sync never throws into user code.
- Auto-sync runs on its own timer; runtime methods only mark a dirty bit and return.

### §2.2 Privacy
- **`BadgeEvent` carries counts + labels + queryId only.** No `prompt`, `response`,
  `assistantText`, `tool_input`, `tool_response`, `argSummary`, `argKey`,
  `sessionId`, file paths, code, transcript text.
- **Cloud sync remains aggregate-only.** Forbidden over the wire (existing
  forbidden + new): memory rows, reasoning block body fields (`situation`,
  `mechanism`, `unlock`, `verification`, `dead_ends`, `keywords`), project
  facts, session digests, `tool_observations` rows, `arg_key`, `arg_summary`,
  `tool_use_id`, raw `session_id`, prompts, responses, tool input/output, file
  paths, code.
- `tool_response` body is never read at any layer. Defense-in-depth: per-tool
  projection (`src/core/tool-arg.ts`) only reads named fields off `tool_input`.
- All inputs bounded by `boundField` and scanned by `detectLeakageExtended`
  before any write.

### §2.3 Compatibility
- **No breaking wrapper signatures.** `wrapOpenAI(client, layer, recallConfig?)`,
  `wrapAnthropic(client, layer, recallConfig?)`, `wrapAgent(layer, fn, options)`
  retain their current shapes. New options are additive on `recallConfig` /
  `WrapOptions`.
- **No mandatory peer deps** on LangChain / LangGraph / Claude Agent SDK. SDK
  recipes assume userland imports the framework themselves.
- TraceBase failures never propagate into the wrapped client / agent call.
  `try/catch` boundary in every wrapper around every TraceBase call.

## §3 Public surface

### §3.1 BadgeEvent

```ts
// src/types.ts (new — exported via src/index.ts)
export type BadgeEventKind = "trace" | "memory" | "context" | "tool" | "loop";

export interface BadgeEvent {
  kind: BadgeEventKind;
  /** Human-readable line, e.g. "▣ TB LOOP  straight × 3 (Read)". */
  label: string;
  /** Counts only (pattern hits, fact hits, repeated/loop count). */
  count?: number;
  /** Tool name on tool / loop kinds. NEVER argSummary / argKey. */
  toolName?: string;
  /** Stable per-call recall id (queryId) so callers can correlate logs. */
  queryId?: string;
  /** Approximate token cost of injected context (recall-side only). */
  tokens?: number;
  /** Wall-clock ms when the wrapper observed the event. */
  ts: number;
  /** Wrapper source: "openai" | "anthropic" | "agent" | "generic" | … */
  source?: string;
}
```

The forbidden-field set is asserted by `tests/sdk/badge-event-privacy.test.ts`
which iterates every BadgeEvent emitted by every wrapper across a fixture suite.

### §3.2 Runtime

```ts
// src/sdk/runtime.ts (new)
export interface CreateRuntimeOptions {
  sessionId?: string;
  projectPath?: string;
  source?: "openai" | "anthropic" | "agent" | "generic" | "langchain" | "langgraph" | "claude-agent-sdk";
  onBadge?: (ev: BadgeEvent) => void;

  // Per-capability switches — default true; users can opt out individually.
  enableTrace?: boolean;
  enableMemory?: boolean;
  enableContext?: boolean;
  enableTool?: boolean;
  enableLoop?: boolean;

  // Auto-sync behaviour. Defaults: autoSync = true iff cloud is linked;
  // 30 s debounce; 5 min max coalesce window.
  autoSync?: boolean;
  syncDebounceMs?: number;
  syncMaxIntervalMs?: number;
}

export interface Runtime {
  beforeRun(input: { prompt: string; sessionId?: string; projectPath?: string }):
    Promise<{ additionalContext: string; badgeEvents: BadgeEvent[]; queryId?: string }>;

  afterRun(input: { userText: string; assistantText: string; sessionId?: string; projectPath?: string }):
    Promise<void>;  // returns immediately; capture queued

  observeToolBatch(input: {
    sessionId: string;
    projectPath?: string;  // alias: cwd
    toolCalls: Array<{ toolName: string; toolInput: unknown; toolUseId?: string; outcome?: "ok" | "error" | "unknown" }>;
  }): Promise<{ recorded: number }>;

  saveContext(input: {
    sessionId: string;
    projectPath?: string;
    turns?: Array<{ role: "user" | "assistant"; content: string }>;
    digest?: string;
  }): Promise<{ factId: string | null }>;

  /** Wait for pending async capture + sync jobs. Tests + enterprise shutdown. */
  flush(): Promise<void>;

  /** Close DB handles, clear sync timers. Idempotent. */
  close(): Promise<void>;
}

export function createRuntime(layer: ReasoningLayer, options?: CreateRuntimeOptions): Runtime;
```

### §3.3 Wrappers (additive options only)

```ts
// existing — signatures preserved, new optional fields added
wrapOpenAI(client, layer, {
  ...existingRecallInjectConfig,
  onBadge?: (ev: BadgeEvent) => void,
  runtime?: Runtime,        // bring-your-own runtime; otherwise wrapper builds one
  source?: string,          // default "openai"
})

wrapAnthropic(client, layer, { ...same shape })

wrapAgent(layer, fn, {
  ...existingWrapOptions,
  onBadge?: (ev: BadgeEvent) => void,
  runtime?: Runtime,
})

// new — framework-neutral
wrapGeneric<TIn, TOut>(layer, call, {
  source: "langchain" | "langgraph" | "claude-agent-sdk" | string,
  sessionId?: string,
  projectPath?: string,
  extractPrompt: (input: TIn) => string,
  injectContext?: (input: TIn, ctx: string) => TIn,  // default: no injection (caller wires)
  extractOutput?: (output: TOut) => string,          // default: stringify
  observeTools?: (input: TIn, output: TOut) => Array<{ toolName: string; toolInput: unknown; toolUseId?: string; outcome?: string }>,
  onBadge?: (ev: BadgeEvent) => void,
}): (input: TIn) => Promise<TOut>
```

**Wrapper flow** (all four wrappers):

```
beforeRun → injectContext into prompt → original call → observeTools? → afterRun (queued) → return original output
                ↑                                                ↑
         additionalContext                              one tx, sanitised
                                                                 ↓
                                                         mark sync dirty
```

Wrapper owns the runtime if not passed. `onBadge` runs in `try/catch` —
throwing inside callbacks is swallowed.

## §4 Internal architecture — extraction map

The 0.5.3 CLI commands (`inject-context`, `capture-turn`, `capture-context`,
`capture-tool-use`) hold the canonical implementations of each capability. The
runtime must reuse those canonical implementations, not re-derive them.

**Strategy**: extract pure cores from each command into `src/runtime/*.ts`,
keep CLI commands as thin wrappers around the cores, and have the SDK runtime
call the same cores. This holds the 0.5.3 CLI tests as the ground truth — no
behavior drift.

| 0.5.3 CLI command | Pure core (new) | Used by |
|---|---|---|
| `inject-context.ts` | `src/runtime/recall.ts` — `recallForPrompt(store, server, opts) → { text, queryId, badgeEvents, payload }` | CLI hook + `runtime.beforeRun()` |
| `capture-turn.ts` | `src/runtime/capture-turn.ts` — `captureTurn(store, opts) → { blockId?, factIds[] }` | CLI hook + `runtime.afterRun()` |
| `capture-context.ts` | `src/runtime/digest.ts` — `extractAndStoreDigest(store, opts) → { factId }` | CLI hook + `runtime.saveContext()` |
| `capture-tool-use.ts` | `src/runtime/observe-tools.ts` — `observeToolBatch(store, opts) → { recorded }` | CLI hook + `runtime.observeToolBatch()` |
| `tool-loop-detect.ts` (already pure) | unchanged | both |
| `tool-arg.ts` (already pure) | unchanged | both |

**Refactor invariant**: every existing CLI test in `tests/cli/` continues to pass
with zero changes. Each extraction lands in its own commit so a regression
bisects to a single move.

## §5 Auto-sync coordinator

```ts
// src/sdk/sync-coordinator.ts (new)
export interface SyncCoordinator {
  markDirty(reason: string): void;     // called by runtime methods
  flush(): Promise<void>;              // forces a final attempt
  close(): void;                       // clears timers
}

export function createSyncCoordinator(layer, options): SyncCoordinator;
```

### §5.1 State machine

```
idle → (markDirty) → debouncing → (timeout fires + cloud linked + autoSync on) → sending
                          ↑                                                          ↓
                          └──────────────── (markDirty during debounce) ──────  (success: clear dirty)
                                                                                     ↓
                                                                              (failure: backoff retry,
                                                                               max 6 attempts, jitter)
```

- **Debounce**: default 30 s. Restarts on every `markDirty`.
- **Cap**: default 5 min. Forces a send even if `markDirty` keeps firing
  (so a chatty session can't starve the queue).
- **Backoff**: `min(2^n + jitter, syncMaxIntervalMs)` for n ∈ [0, 5];
  after attempt 6 give up until next `markDirty` cycle.
- **Idempotency**: payload key = `installationId + windowStart + windowEnd`,
  matching the existing `usage sync --once` behaviour. Server-side dedupe.
- **On `runtime.flush()` / `runtime.close()`**: one final best-effort attempt
  with a 5 s soft timeout. Never throws.

### §5.1.1 Node lifecycle constraints (amended)

The runtime is a library, not a daemon. The coordinator **must NOT** install
process-wide handlers on `'exit'`, `'beforeExit'`, `'SIGINT'`, `'SIGTERM'`, or
`process.on('uncaughtException')`. A library that touches those globals fights
host applications (Next.js / Electron / pm2 / test runners) and surfaces as
"my process won't exit cleanly" bug reports.

Concrete rules:

- **Timers**: every `setTimeout` / `setInterval` the coordinator owns calls
  `.unref()` immediately when available (Node ≥ 0.9). Node-on-Bun and
  Deno polyfill the same API; in browser-shimmed environments the call is a
  no-op.
- **Final flush**: explicit only — `runtime.flush()` and `runtime.close()`
  are the durability surface. No magic on exit. Tests rely on `flush()`.
- **CLI**: `bin/cli.ts` may install its own exit-flush handler around CLI
  command lifetimes (e.g. wrap `usageCommand` so a manual `tracebase usage
  sync` flushes the coordinator on the way out). That's CLI-side scaffolding,
  not library-side.
- **Browser / Edge runtimes**: no `process.on` calls anywhere on the
  coordinator path. The whole sync layer must build under
  `browser` / `edge` runtime tsup targets without conditional imports.

### §5.2 What the coordinator sends

Reuses `computeUsageMetrics()` from `src/analytics/usage-metrics.ts` — no new
aggregator. Adds the four new fields below to `UsageMetrics` and to the
allowlist; coordinator drains and sanitises through `sanitizeForCloud`
before every fetch.

### §5.3 Manual `tracebase sync` command

Kept for diagnostic / enterprise durability use:

- `tracebase sync` calls the same coordinator's `flush()` with `force: true`.
- Docs gain a callout: "normal users do not need to run this; auto-sync runs in
  the background when cloud is linked".
- **Not removed in 0.5.4.** Deprecation flagged in docs only. Removal is a
  separate decision after telemetry shows it's unused.

## §6 Cloud allowlist additions (amended)

Adds aggregate-only fields to `UsageMetrics` and `USAGE_SAMPLE_ALLOWLIST`.
**Tool counts ship under normalised families, never literal Claude tool names** —
literal names (`Read`, `Grep`, `Bash`, …) are Claude Code surface vocabulary
and would leak the host's tool catalogue to the control plane. Normalisation
runs locally before the count is added to the aggregate.

```ts
metrics: {
  ...existing observed/estimated/causal/integrity ...,
  toolBatch: {
    duplicateCount: true,        // total duplicate-detector hits in window
    loopCount: true,             // total straight + pingpong hits in window
    toolFamilyCounts: TOOL_FAMILY_SPEC,  // normalised families only — see below
    errorClassCounts: ERROR_CLASS_SPEC,  // counts only, never matched values
  },
}

// Eight families, lowercase, semantic — frozen vocabulary the cloud
// understands. New tools always map into one of these, never add a slot.
const TOOL_FAMILY_SPEC = {
  read: true,    // file content reads
  search: true,  // pattern / glob lookups
  shell: true,   // process / shell command execution
  edit: true,    // mutate existing files
  write: true,   // create files
  web: true,     // outbound HTTP / web search
  task: true,    // sub-agent / skill delegation
  other: true,   // catch-all — never the literal name of an unmapped tool
};

const ERROR_CLASS_SPEC = {
  // Mirrors LEAKAGE_PATTERNS_EXTENDED names — finite enumerable set.
  // The COUNT only — the matched substring is never sent and never read.
  "abs-path-posix": true,
  "abs-path-windows": true,
  "bearer-token": true,
  "api-key-anthropic": true,
  "api-key-github": true,
  "api-key-sk": true,
  "env-line": true,
};
```

### §6.1 Local family normalisation

Lives in `src/runtime/tool-family.ts` (new). Pure function:

```ts
export function toolFamily(toolName: string): keyof typeof TOOL_FAMILY_SPEC {
  switch (toolName) {
    case "Read": return "read";
    case "Grep":
    case "Glob": return "search";
    case "Bash": return "shell";
    case "Edit":
    case "NotebookEdit": return "edit";
    case "Write": return "write";
    case "WebFetch":
    case "WebSearch": return "web";
    case "Task":
    case "Skill": return "task";
    default: return "other";  // unknown / future tool name — never echoed
  }
}
```

The aggregator increments `toolFamilyCounts[toolFamily(row.toolName)]` only.
A test (`tests/sdk/tool-family.test.ts`) seeds an unknown tool name like
`"FuturisticMystery"` and asserts the resulting cloud sample contains
`{ other: 1 }` and **does not** contain the string `FuturisticMystery`
anywhere.

### §6.2 errorClassCounts contract

- Counts only. **The matched substring of a leakage pattern is never read by
  the aggregator and never reaches the wire.**
- The seven slot names are themselves descriptive labels (e.g.
  `"abs-path-posix"`), not user content.
- If implementation reveals the aggregator needs to inspect literal matched
  values to compute the count (it shouldn't — counts are incremented at
  rejection time, before the matched substring is captured), that field
  defers to 0.5.5 instead of shipping a half-baked privacy boundary.

### §6.3 Privacy regression tests

Extends `tests/cli/cloud-allowlist.test.ts`:

- Construct a `UsageMetrics` carrying every forbidden field as a literal
  value. `sanitizeForCloud(metrics)` strips them all.
- Construct a `UsageMetrics` whose `toolFamilyCounts` map carries an extra
  unknown family slot (e.g. `{ read: 3, mystery: 7 }`). Allowlist drops
  `mystery`, keeps `read: 3`.
- Construct a `UsageMetrics` whose `errorClassCounts` carries a slot whose
  name doesn't match the seven enumerated entries. Allowlist drops it.
- Any new field on `UsageMetrics` MUST land with both an allowlist entry AND
  a regression test or it does not ship.

## §7 Performance budgets

Mirrors PLAN-0.5 §3 with SDK-warm budgets (no `npx` cold-start overhead because
the runtime lives in-process).

| Surface | p95 target | Fallback ceiling | Bench fixture | Release-gate |
|---|---|---|---|---|
| `runtime.beforeRun` warm | 50 ms | 150 ms | `bench-hooks` new fixture, modest store | yes |
| `runtime.observeToolBatch` (8 calls) | 30 ms | 200 ms | reuse 0.5.3 `capture-tool-use` shape | yes |
| `runtime.saveContext` warm | 200 ms | 2 s | reuse 0.5.2 capture-context shape | yes |
| `runtime.afterRun` (queued) | 0 ms latency to caller | 0 ms (return-before-capture is structural) | inspection: returns before capture runs | yes |
| Auto-sync hot path | 0 ms latency to caller | 0 ms (no fetch in any runtime method) | inspection | yes |
| Existing CLI hooks | unchanged from 0.5.3 | — | unchanged | yes |

### §7.1 Budget escalation rule (amended)

The "p95 target" is what the bench harness aims for. The "fallback ceiling"
matches the corresponding 0.5.3 hook budget — if a target is missed, the
bench is documented as exceeding target but still under ceiling, and the
release ships. **Network I/O is never added to hit any benchmark**; if a
target can only be met by skipping a sanitiser or eliding a leakage scan,
the target is wrong, not the implementation.

A fallback-ceiling miss is a release blocker. A target miss is a documented
deviation that lands in `bench-results/<version>.json` with a one-line
rationale.

## §8 Implementation phases

Each phase ships behind tests; lint + build clean before phase boundary.

| Phase | What ships | Touches |
|---|---|---|
| 8.1 | Type additions: `BadgeEvent`, `Runtime`, `CreateRuntimeOptions` | `src/types.ts`, `src/index.ts` |
| 8.2 | Extract `src/runtime/recall.ts` from `inject-context.ts`. Existing CLI tests pass unchanged. | inject-context delegates to core |
| 8.3 | Extract `src/runtime/observe-tools.ts` from `capture-tool-use.ts` | capture-tool-use delegates |
| 8.4 | Extract `src/runtime/digest.ts` from `capture-context.ts` | capture-context delegates |
| 8.5 | Extract `src/runtime/capture-turn.ts` from `capture-turn.ts` | capture-turn delegates |
| 8.6 | `createRuntime` + lifecycle (no auto-sync yet) | `src/sdk/runtime.ts` |
| 8.7 | `wrapGeneric` + onBadge plumbing in existing wrappers | `src/middleware/*` |
| 8.8 | Auto-sync coordinator + cloud allowlist additions | `src/sdk/sync-coordinator.ts`, `cloud-allowlist.ts` |
| 8.9 | `docs/SDK.md` recipes (OpenAI, Anthropic, wrapAgent, LangChain, LangGraph, Claude Agent SDK) | `docs/SDK.md` |
| 8.10 | Bench fixtures for runtime methods | `scripts/bench-hooks.ts` (rename or sibling: `bench-sdk.ts`) |
| 8.11 | Lint + build + bench + version bump + commit + publish + push | release |

## §9 Tests

Every phase ships its own tests. Cumulatively:

- `tests/sdk/runtime-before-run.test.ts` — recalls TRACE/MEMORY/CONTEXT, emits BadgeEvent, trivial-prompt gate
- `tests/sdk/runtime-observe-tools.test.ts` — sanitised HMAC observations land; `tool_response` never read
- `tests/sdk/runtime-loop-detect.test.ts` — observe N then beforeRun emits TB TOOL / TB LOOP
- `tests/sdk/runtime-save-context.test.ts` — digest stored, same-session beforeRun recalls it
- `tests/sdk/runtime-flush.test.ts` — afterRun returns immediately; flush() resolves after capture completes
- `tests/sdk/badge-event-privacy.test.ts` — every BadgeEvent emitted by every wrapper across a fixture suite is forbidden-field-clean
- `tests/sdk/wrap-generic.test.ts` — happy path + extractPrompt edge cases
- `tests/sdk/onBadge-throw.test.ts` — onBadge throws synchronously; wrapped call still resolves
- `tests/sdk/sync-coordinator.test.ts`:
  - `markDirty` debounces with `vi.useFakeTimers`
  - second `markDirty` during debounce extends the wait
  - cap at `syncMaxIntervalMs` forces a send
  - network failure triggers backoff; eventual success clears dirty
  - `flush()` forces a final attempt with timeout
  - hot-path inspection: every runtime method returns before any fetch is observed
- `tests/cli/cloud-allowlist.test.ts` (extended) — new aggregate fields ship; forbidden fields never reach wire
- All existing 0.5.3 CLI tests pass unchanged across 8.2–8.5 (refactor regression gate)

## §10 Release split (amended)

The product scope of 0.5.4 is **SDK parity + automatic aggregate sync**. Both
halves must land or the release does not earn the name "0.5.4 SDK parity +
auto-sync". The minimum ship line is therefore **through §8.8** (auto-sync
coordinator + cloud allowlist additions). If §8.8 is not green, the release
does not ship — period.

- **0.5.4 (minimum ship line, must-have):**
  §8.1 (types) · §8.2 (recall extract + delegation) · §8.3 (observe extract +
  delegation) · §8.6 (runtime core) · §8.7 (BadgeEvent + onBadge in existing
  wrappers + `wrapGeneric`) · §8.8 (auto-sync coordinator + cloud allowlist
  additions per §6) · §8.9 minimum recipes (OpenAI, Anthropic, `wrapAgent`,
  LangChain via `wrapGeneric`) · §8.10 (bench fixtures) · §8.11 (release).

- **0.5.5 (deferred if 0.5.4 grows too large, nice-to-have):**
  §8.4 (digest extract + delegation) · §8.5 (capture-turn extract +
  delegation) · LangGraph + Claude Agent SDK recipe additions to
  `docs/SDK.md` · optional `tracebase sync` deprecation removal · deeper
  helper adapters.

The deferred items are pure refactor / documentation polish — they do not
change shipped behaviour and can land separately without a major-version
implication. The §4 invariant (existing 0.5.3 CLI tests pass unchanged) holds
for both releases.

## §11 Out of scope (explicit)

- No new `.claude/settings.json` hook events. `POSTTOOLBATCH_EVENT_SPEC` etc. unchanged.
- No new SQLite schema (V2_SCHEMA_VERSION stays at 8).
- No syncing of memory rows, blocks, facts, digests, or `tool_observations` rows over the wire.
- No streaming / mid-batch BadgeEvents — one `BadgeEvent[]` set per LLM call.
- No major-version bump; all wrapper signatures are additive-compatible.
- No mandatory peer deps on LangChain / LangGraph / Claude Agent SDK.

## §12 Release checklist

1. Implement §8.1–§8.10 phase-by-phase
2. `npm run lint && npm run build && npx vitest run` — all green
3. `npm run bench:hooks` — new SDK fixtures within budget
4. `package.json` → `0.5.4`
5. Commit message: `0.5.4 — SDK parity (BadgeEvent + runtime + wrapGeneric) + automatic background aggregate sync`
6. `npm publish`
7. `git push origin production`
8. `npm view tracebase-ai@latest version` confirms `0.5.4`
9. Fresh-install smoke (mirroring 0.5.3 verification): `npx tracebase init` → `doctor` → 4 hooks canonical → simulated PostToolBatch flow surfaces TB TOOL/LOOP

---

**Approved with amendments. Implementation begins at §8.1.**

Recorded amendments (folded above):

- §4 — approved as-is; refactor must hold the 0.5.3 CLI tests as the
  regression gate, phase by phase.
- §5.1 — approved with §5.1.1 added: no global process exit handlers from
  the library; timers must `unref()` where available; explicit
  `runtime.flush()` / `runtime.close()` are the only durability path.
- §6 — amended: `toolFamilyCounts` ships normalised eight-family vocabulary
  (`read` / `search` / `shell` / `edit` / `write` / `web` / `task` / `other`),
  not literal Claude tool names. Local mapping in
  `src/runtime/tool-family.ts`. `errorClassCounts` keeps counts only — no
  matched values; defers to 0.5.5 if implementation forces touching matched
  substrings to compute the count.
- §7 — added §7.1 escalation rule: targets are aspirations, fallback
  ceilings (matching 0.5.3 hook budgets) are the actual release gates; a
  target miss is documented in `bench-results/<version>.json` rather than
  blocking; network I/O is never added to hit a bench.
- §10 — fixed split-point inconsistency. 0.5.4 minimum ship line is
  **through §8.8**. Auto-sync is in-scope by name; without §8.8 the release
  is not "0.5.4 SDK parity + auto-sync".
