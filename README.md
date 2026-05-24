# TraceBase

**Memory layer for coding agents.** Your agents stop re-solving the same problem.

[![MIT License](https://img.shields.io/badge/license-MIT-orange.svg)](https://github.com/64envy64/tracebase/blob/main/LICENSE)
[![npm](https://img.shields.io/npm/v/tracebase-ai?color=orange)](https://www.npmjs.com/package/tracebase-ai)
[![tracebase.ink](https://img.shields.io/badge/site-tracebase.ink-orange)](https://tracebase.ink)

```
 1st run  ─  "Fix the CORS error in Express"   ─►  agent solves from scratch     ─►  trace stored
 2nd run  ─  "Access-Control header missing"   ─►  prior trace surfaces as hint  ─►  faster, cheaper
 3rd run  ─  same class of problem             ─►  resolved in one shot          ─►  tokens saved
```

Agents are stateless. They forget everything between sessions, so the same bug gets re-derived from scratch, the same file gets re-read, the same loop spins again — every run, on your tokens. TraceBase keeps the resolved work and feeds it back into the next run.

---

## What it catches

Five failure modes agents hit at runtime — one runtime, five arms:

| Arm | What it does |
| --- | --- |
| **Recall** | Surfaces past solutions when a similar problem returns. Vector + heuristic match against the project-scoped pattern DB. |
| **Gist** | Recalls what a file *means* without re-reading the bytes. Survives window compaction on long sessions. |
| **Loop** | Catches doom-loops mid-run on a six-turn window and suggests a redirect. Never overrides agent judgement. |
| **Guard** | Spots redundant fetches and repeat searches before they compound on the bill. Tool-call dedup window. |
| **Fold** | Folds older turns into gist summaries so 100+ turn horizons stay coherent without thrashing. |

---

## Numbers

**SWE-bench Verified** (40-task paired benchmark · mini-swe-agent v2.2.8 · Docker):

| | Baseline | With TraceBase | Δ |
| --- | :---: | :---: | :---: |
| Accuracy | 63% | 83% | **+20 pp** |
| Cost / run (avg) | — | — | **−43%** |
| Steps / run (avg) | — | — | **−26%** |
| Regressions | — | — | **0** |

Best paired run: 31 steps → 11 steps (**−65% steps**, **−70% cost**). Full whitepaper at [tracebase.ink/whitepaper](https://tracebase.ink/whitepaper).

---

## Install

One command. Auto-detects Claude Code / Cursor / Codex, writes the adapter, registers MCP, and initializes the local pattern DB.

```bash
npx tracebase-ai init
```

Verify the install:

```bash
npx tracebase-ai doctor      # integrity check — exit 0 on healthy
npx tracebase-ai status      # one-screen snapshot
npx tracebase-ai savings     # what was actually saved (since 7d)
```

`status` prints something like this:

```
TraceBase  workspace 6c27c71a…

  project:  /Users/you/repo
  storage:  /Users/you/repo/.tracebase/memory.db  (1.33 MB)
  cloud:    s1z-3q (https://tracebase.ink)

Agents (2 wired up):
  Claude Code  claude mcp registry (local)  ok · CLAUDE.md ok
               hooks  UserPromptSubmit ok · Stop ok · PreCompact ok
  Cursor       ~/.cursor/mcp.json ok · AGENTS.md ok

Blocks (active / candidate / demoted / merged / retired):
  5 / 0 / 0 / 0 / 0

Events (total 291):
  retrieval 24 · injection 10 · agent_used 0 · outcome 5
```

---

## Integrations

| Surface | Adapter |
| --- | --- |
| **Claude Code 2.x** | `.mcp.json` + managed `CLAUDE.md` block |
| **Cursor** | `~/.cursor/mcp.json` + `AGENTS.md` |
| **Codex CLI** | codex MCP registry + `AGENTS.md` |
| **OpenAI SDK** | `wrapOpenAI(client, layer)` middleware |
| **Anthropic SDK** | `wrapAnthropic(client, layer)` middleware |
| **Generic (LangChain, LangGraph, Agent SDK)** | `wrapGeneric(...)` |
| **HTTP service boundary** | `npx tracebase-ai serve --port 3781` |

SDK example — wrap the client, every call is now optimized:

```typescript
import OpenAI from "openai";
import { ReasoningLayer, wrapOpenAI } from "tracebase-ai";

const layer = new ReasoningLayer();
const openai = wrapOpenAI(new OpenAI(), layer, {
  minScore: 0.72,      // only high-confidence matches
  skipExactMatch: true // don't inject on exact re-asks
});

// recall → inject (if match) → call → store
const response = await openai.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Fix the CORS error in our Express API" }],
});
```

Streaming, tool calls, prompt caching — all supported. See [tracebase.ink/docs](https://tracebase.ink/docs).

---

## Where it earns its keep

Four shapes of agent work where memory compounds value run-over-run:

- **Coding agents** — Claude Code, Cursor, Codex. Pattern DB compounds across PRs and migrations.
- **Long-horizon runs** — 100+ turn sessions stay coherent. Older turns fold into gists — no window thrashing.
- **Document & research** — Gist remembers what long PDFs and reports mean. Past extractions surface on revisit.
- **Customer & support ops** — Same-shape tickets, same playbook. Past resolutions surface before re-derivation.

Detailed walkthroughs and benchmarks at [tracebase.ink](https://tracebase.ink).

---

## Built for teams running agents at scale

Tracebase is the memory primitive teams deploy like infrastructure. The runtime is the same self-hosted binary whether one developer runs it locally or a platform team deploys it across many hosts. The features that matter at scale:

- **Atomic writes** — concurrent agent runs don't trample each other's patterns.
- **Audit trail** — every retrieval, injection, `agent_used`, and outcome event is logged to a local event log.
- **Deletion + rollback** — patterns that disprove themselves get demoted by the lifecycle repair loop; you can also delete and rollback explicitly.
- **On-prem deployment** — local SQLite, MIT license. Same binary on-prem and in CI. Code never leaves your perimeter.
- **Holdout-based proof of lift** — enable with `init --holdout-rate 0.1` to verify with A/B baseline that memory actually improves outcomes, not just that it fires.

```bash
# turn on the impact measurement holdout — 10% of runs go without memory
# so you can compare cohorts cleanly
npx tracebase-ai init --holdout-rate 0.1
npx tracebase-ai impact     # 30-day funnel: injected vs used vs resolved
```

---

## CLI

```bash
npx tracebase-ai init                      # initialize / re-detect adapters
npx tracebase-ai status                    # one-screen install snapshot
npx tracebase-ai doctor                    # integrity check (CI-friendly)
npx tracebase-ai events --limit 20         # recent events from the local log
npx tracebase-ai impact                    # 30-day reuse + saved-tokens funnel
npx tracebase-ai savings                   # value-first summary (7d default)
npx tracebase-ai recall "<problem shape>"  # surface matching past solutions
npx tracebase-ai search "<query>"          # full-text search across the store
npx tracebase-ai remove                    # uninstall: drop store + adapters
npx tracebase-ai serve [--mcp] [--port]    # boot MCP or HTTP server manually
```

Every command supports `--json` for machine-readable output. Wire `doctor --json` into CI for rollout gates.

---

## HTTP API

```bash
npx tracebase-ai serve --port 3781

curl -X POST localhost:3781/recall   -d '{"problem": "CORS error Express"}'
curl -X POST localhost:3781/store    -d '{"problem": {...}, "solution": {...}}'
curl -X POST localhost:3781/feedback -d '{"traceId": "...", "helpful": true}'
curl localhost:3781/health
```

---

## Host Parity

Every cell in this table is backed by an integration test in `tests/parity/host-matrix.test.ts`. Nothing here is aspirational.

| Host                          | Recall | FileMem | Fold | PromptCache | Tool         | Loop         |
| ----------------------------- | :----: | :-----: | :--: | :---------: | :----------: | :----------: |
| Claude Code (hooks)           |   ✓    |    ✓    |  ✓   |     n/a¹    | ✓ preventive | ✓ preventive |
| `wrapAnthropic`               |   ✓    |    ✓    |  ✓   |      ✓      | ◐ post-hoc²  | ◐ post-hoc²  |
| `wrapOpenAI`                  |   ✓    |    ✓    |  ✓   |      ✓      | ◐ post-hoc²  | ◐ post-hoc²  |
| `wrapAgent` (string→string)   |   ✓    |    ✓    |  ✓   |     n/a³    | ◐ post-hoc²  | ◐ post-hoc²  |
| `wrapGeneric` (LangChain)     |   ✓    |    ✓    |  ✓   |     n/a³    | ◐ post-hoc²  | ◐ post-hoc²  |
| `wrapGeneric` (LangGraph)     |   ✓    |    ✓    |  ✓   |     n/a³    | ◐ post-hoc²  | ◐ post-hoc²  |
| `wrapGeneric` (Agent SDK)     |   ✓    |    ✓    |  ✓   |     n/a³    | ◐ post-hoc²  | ◐ post-hoc²  |

Legend: **✓** end-to-end via the host's real path · **◐** capability exists but observed AFTER the call · **preventive** decided BEFORE the tool runs (block / warn / allow) · **post-hoc** loop redirect surfaces on the NEXT turn.

Footnotes: ¹ Claude Code's prompt cache is provider-side. ² Bare wrappers don't intercept tool dispatch — wire `runtime.observeToolBatch(...)` to enable Tool/Loop on the next call. ³ Generic wrappers don't see provider request shapes. Cache savings, when supported, **may reduce billed/processed prefix tokens** — TraceBase never estimates cache savings, only what the provider reports back (`cache_read_input_tokens` / `prompt_tokens_details.cached_tokens`).

---

## How it works (in one paragraph)

The pattern DB is project-scoped SQLite. Retrieval starts with fingerprint + FTS5/BM25, then combines structural/Jaccard/cosine signals with Thompson-sampled weights; when enabled, the B1 cascade over-fetches candidates, reranks with a local or cloud cross-encoder, applies MMR diversity, and gates through calibration. Above the threshold, the resolved trace gets injected into the prompt as context - never as a directive. After the run, an outcome event closes the loop: was the injected pattern actually used? Did the run resolve? Patterns that stop earning their keep get demoted automatically (Wilson interval lower bound on the helpfulness rate). Signal weights aren't hardcoded - they update via Thompson sampling on the outcome stream, and `tracebase cascade compare` / `tracebase impact` show whether the new ranker is helping before you ramp it.

Full architecture and the SWE-bench whitepaper at [tracebase.ink/whitepaper](https://tracebase.ink/whitepaper).

---

## Status & roadmap

- **Self-hosted is live, MIT, in production today.** v0.9.0 on npm.
- **Hosted dashboard** at [tracebase.ink](https://tracebase.ink) — read-only view over the same local event log. Optional, never required.
- **Hobby ($15/mo), Startup ($159/mo), Enterprise** paid tiers — draft packaging, not on checkout yet. Talk to us for early access at [tracebase.ink/#pricing](https://tracebase.ink/#pricing).

---

## Links

- **Landing** — [tracebase.ink](https://tracebase.ink)
- **Docs** — [tracebase.ink/docs](https://tracebase.ink/docs)
- **Whitepaper** — [tracebase.ink/whitepaper](https://tracebase.ink/whitepaper)
- **npm** — [npmjs.com/package/tracebase-ai](https://www.npmjs.com/package/tracebase-ai)
- **License** — MIT

Part of the [Daytona Startup Grid](https://www.daytona.io/startups).
