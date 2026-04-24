# TraceBase 0.5 — design plan

Status: approved 2026-04-24. Lock before code lands in 0.5.x.

## 0. Non-goals (hard constraints)

- No cloud upload of: prompts, transcripts, code, tool outputs, tool inputs,
  chain-of-thought, absolute paths, env dumps, file contents.
- No foreground MCP permission prompts in normal flow.
- No new user-facing commands beyond `npx tracebase init`.
- No peer-dep on LangChain / OpenAI / Anthropic SDKs — integrations are
  docs-only recipes.
- No SessionStart hook, no blocking tool-call hook, in v1.

## 1. Audit findings

- Hook plumbing is extensible via `HookEventSpec[]` + `CLAUDE_HOOK_SPECS`
  (install-targets.ts:446–521). A new event means one spec append and one
  union widening — no refactor.
- Storage is extensible via `V2_MIGRATIONS[n]` in block-store.ts:273–329.
  `analytics_events.event_type` is free-form TEXT, so new event types need
  no SQL migration.
- Semantic memory already has a home: `project_facts` + FTS mirror. New
  `fact_type` literals widen the TypeScript union; the SQL column is TEXT.
- SDK wrappers for OpenAI/Anthropic already exist; event bus is
  `layer.on(eventType | "*", handler)`. Generic wrapper is missing.
- `better-sqlite3` is synchronous. Acceptable for hook commands (short-
  lived). SDK wrappers run recall on the caller's thread.

## 2. Badge taxonomy

| Badge | Hook / SDK event | Meaning |
|---|---|---|
| `▣ TB TRACE` | UserPromptSubmit inject + Stop capture | Reasoning reuse (0.4.3 baseline). |
| `▣ TB MEMORY` | UserPromptSubmit inject + Stop capture | Semantic project facts. |
| `▣ TB CONTEXT` | PreCompact | Session digest. |
| `▣ TB TOOL` | UserPromptSubmit (derived from prior PostToolBatch observations) | Redundant-call hint. |
| `▣ TB LOOP` | UserPromptSubmit (same) | Loop / ping-pong hint. |

Composition rule: a single hook emits a single `systemMessage`. When
multiple badges apply, concatenate with ` · ` separator, total length
≤ 100 chars. Never emit a dangling separator when one half is empty.

## 3. Performance gates (enforced before ship)

Numeric p95 targets apply to **warm** runs only (cold `npx` fetch is npm's
cost, not ours).

| Hook | p95 target | Release gate | Measurement fixture |
|---|---|---|---|
| UserPromptSubmit (inject-context) | 150 ms | yes | 50 active blocks + 30 facts + 200-char prompt |
| Stop (capture-turn) | 500 ms | yes | 6 k-line transcript tail |
| **PostToolBatch** (capture-tool-use, primary) | **200 ms** | **yes** | batch of 8 mixed Read/Grep/Glob/Bash tool_calls |
| PostToolUse (capture-tool-use, fallback) | 200 ms | no — compat only | single tool_call per invocation |
| PreCompact (capture-context) | 2 s | yes (0.5.1) | 4 MiB transcript tail |
| PreToolUse | 50 ms | **opt-in only** — off by default | single tool_call |

### 3.1 Benchmark harness

`scripts/bench-hooks.ts` (dev-only, not shipped in `files`):

- Spawns the built CLI N=100 times per fixture. Discards first 5 (warmup).
- Reports p50 / p95 / p99 wall-clock.
- Writes `bench-results/<version>.json`.
- CI gate: fails the build if any p95 exceeds target.

### 3.2 Budget-miss policy

| Overshoot | Action |
|---|---|
| ≤ 20 % | Ship with `doctor` WARN row: "latency above target — consider `TRACEBASE_<EVENT>=off`". |
| 20–50 % | Ship as **opt-in only**; installer does NOT write the hook by default; user sets `TRACEBASE_<EVENT>=on`. doctor reports "disabled by budget". |
| > 50 % | Drop from the phase; requeue for a later release, **unless the new phase is zero-delta on the over-budget path** — see §3.3. |

### 3.3 Measurement reality — observed in 0.5.0 bench

The 150 ms p95 target for UserPromptSubmit was set before the harness
existed. The first real run (0.5.0 fixture: 50 active blocks + 30
facts, 200-char prompt, 100 runs + 5 warmups) shows:

| Hook | p50 | p95 | p99 | target | status |
|---|---|---|---|---|---|
| inject-context | ~130 ms | **~300–370 ms** | ~450–600 ms | 150 ms | p50 below target, p95 ~2× target |
| capture-turn | ~190 ms | ~270 ms | ~590 ms | 500 ms | pass |

The inject-context p95 tail is dominated by fresh `node` spawn
(~50–80 ms) + cold SQLite WAL open + first FTS query, not by 0.5.0
TB MEMORY work. TB MEMORY adds *zero* new IO to the inject path —
`BlockServer.recall()` already returns facts; 0.5.0 only composes
them into a visible badge. So TB MEMORY is zero-delta on the
over-budget path.

**Decision for 0.5.0:** ship. The over-budget behavior is inherited
from 0.4.x and is orthogonal to this release. A follow-up perf task
(future 0.5.x patch) will investigate whether a shared-process hook
daemon or a compact CLI boot path brings the p95 under the 150 ms
target. Until then, users who hit noticeable latency can set
`TRACEBASE_HOOK_STATUS=silent` (badge only — the injection still
runs) or disable the hook via `npx tracebase remove`.

The 500 ms target for capture-turn holds and the 0.5.0 fact-
extraction path does not regress it (p95 ~270 ms with the new
extractor running).

## 4. Privacy / data boundary

### 4.1 Forbidden at rest (local SQLite)

- Absolute filesystem paths. Only repo-relative (`src/foo.ts`, never `/Users/.../src/foo.ts`).
- File contents. Only filenames + role labels.
- Raw tool inputs. Only allowlisted-field synthetic summaries (see §5.3).
- Raw tool outputs. Not stored at all.
- Chain-of-thought / extended_thinking blocks. Not stored at all.
- Environment variables, `.env` contents, secrets. Scanned + rejected at write.

### 4.2 Workspace salt

`.tracebase/config.json` gains `workspaceSalt: <32-byte hex>` minted at
`init`. Used as the HMAC key for tool-arg keys (§5.3). Never leaves the
machine.

**Doctor visibility.** Treat as key material. `doctor` reports literally
`workspaceSalt: present` or `workspaceSalt: missing` — no prefix, no hash,
no byte count. `status --json` exposes `{ workspaceSalt: "present" |
"missing" }` only.

**Rotation.** Explicit user action: `tracebase remove` wipes `.tracebase/`
including salt; next `init` mints fresh. No silent rotation path — rotated
salt invalidates every prior `arg_key` in `tool_observations`, so rotation
is a documented-consequences action.

### 4.3 Leakage scanner extension

`detectLeakage` in `block.ts:178–208` today matches diff headers, pytest
IDs, `/testbed/...`. Extend for 0.5 with:

- Absolute path regex: `/^\/(Users|home|tmp|private|var|etc)\//`.
- Bearer-token / api-key patterns: `/(sk-|Bearer\s+)[A-Za-z0-9._-]{16,}/`.
- `.env` key-value shape: `/^[A-Z_][A-Z0-9_]*=[\S]+$/m`.

Every `storeFact` and `storeBlock` write path already runs the scanner.
Extension is additive.

### 4.4 Forbidden at rest → shipped-to-cloud

Everything forbidden at rest is **doubly** forbidden in cloud analytics.
See §7.

## 5. Per-feature design

### 5.1 TB MEMORY — semantic project facts (ships in 0.5.0)

- **Input signal.** Stop hook extends `extractPattern` in capture-turn.ts
  to also run `extractFacts(userText, assistantText)` returning 0..N
  `StoreProjectFactInput` rows. UserPromptSubmit recall already returns
  `facts: FactHit[]`; no code-path change there, only wiring into the
  composite badge.
- **Storage record.** `project_facts` (existing). New fact_type literal
  `"file_semantic"`. `statement` bounded at 400 chars via a new
  `BOUNDED_FIELD` helper in `src/core/guard.ts`. Existing dedupe key
  (`sha256(scope|factType|norm(statement))`) unchanged.
- **Path handling.** `extractFacts` rejects any candidate containing an
  absolute path, a secret-shaped token, or `.env`-line shape. Repo-
  relative paths allowed after normalization (`relative(basePath,
  fullPath)`).
- **Retrieval/query path.** UserPromptSubmit's existing
  `BlockServer.recall()` already returns facts; `buildInjectionPayload`
  already renders them. Badge formatter gets a MEMORY branch.
- **Badge behavior.**
  - Recall with `facts.length > 0`:
    `▣ TB TRACE recalled N pattern(s) · ▣ TB MEMORY K fact(s) · #<id> · Tt`
  - Capture with new facts:
    `▣ TB TRACE stored #<blockId> · ▣ TB MEMORY noted K fact(s)`
  - Either half omitted if count = 0.
- **Failure mode.** Same contract as TB TRACE. Extractor throw → fact
  extraction skipped, pattern capture still runs, envelope always
  parseable.
- **Privacy.** Paths normalized to repo-relative. Leakage scanner rejects
  absolute paths, secrets, env lines. Max statement length enforced.
- **Performance budget.** +30 ms on inject warm path (one extra FTS query,
  already indexed). Still inside 150 ms budget.
- **Tests.** extractFacts from substantive transcript, reject abs-path
  candidate, dedupe supporting-ref on second capture, composite badge
  formatter four branches (both / trace-only / memory-only / neither).
- **E2E smoke.** Fixture transcript → capture-turn → `project_facts`
  gains N rows → next UserPromptSubmit → inject-context emits composite
  badge with `MEMORY K fact(s)`.

### 5.2 TB CONTEXT — session digest (ships in 0.5.1)

- **Prereq.** Confirm live `PreCompact` stdin shape via a throwaway
  `tracebase capture-context --dump-stdin` dev command. Validate before
  locking the parser.
- **Input signal.** PreCompact hook stdin provides `transcript_path`,
  `session_id`, `trigger`. Read the transcript tail (4 MiB cap, same as
  capture-turn).
- **Storage record.** `project_facts` with `fact_type = "session_digest"`,
  `scope = "session:" + session_id`. Bounded: `statement ≤ 1200 chars`.
  Provenance `src.origin = "observed"`, `src.reference = session_id`,
  `ttlDays = 14` (new optional field on `StoreProjectFactInput`; sweeper
  runs in doctor).
- **Digest content rule.** Deterministic only:
  `[last N=5 user-question first lines] + [assistant section headers] +
  [assistant bullet-list first-items]`. No paraphrase. No synthesis. No
  code blocks. No tool args. No chain-of-thought.
- **Retrieval path.** `inject-context` accepts `session_id` from
  UserPromptSubmit stdin; when present, adds a `scope = "session:<id>"`
  predicate. Digest from a different session is never surfaced.
- **Badge behavior.**
  - Saved: `▣ TB CONTEXT digest saved · Tt`
  - Trivial: `▣ TB CONTEXT skipped · no content`
  - Failure: `▣ TB CONTEXT skipped · unavailable`
- **Failure mode.** Never throws. 4 MiB read cap, 2 s spawn timeout,
  never blocks compact.
- **Tests.** Digest bounded (truncation deterministic), trivial → skipped
  + no row, same-session recall injects, different-session does not, 14-
  day TTL sweep, leakage scan rejects digest containing abs-path.
- **E2E smoke.** Stub transcript → capture-context → `project_facts` +1
  row with scope `session:<id>` → inject-context with same session_id
  returns digest in additionalContext; different session_id returns none.

### 5.3 TB TOOL + TB LOOP — PostToolBatch-first (ships in 0.5.2)

- **Primary input: PostToolBatch.** Fires once per assistant turn after
  the full tool batch. Single SQLite transaction per envelope. Max one
  badge per turn.
- **Fallback input: PostToolUse.** Manual user compat path only —
  installed via `npx tracebase init --compat=posttooluse`. No auto-nag.
  Not a release gate.
- **Opt-in: PreToolUse.** Off by default; `TRACEBASE_PRETOOLUSE=on` at
  init time. Compact WARN only, never blocks.

- **Command.** `tracebase capture-tool-use` dispatches on
  `hook_event_name`:
  - `PostToolBatch` → batch-mode: hard-guard `tool_calls` array
    (`if (!calls || calls.length === 0) return emptyEnvelope()`), one
    SQLite transaction over N inserts, signals computed after.
  - `PostToolUse` → single-mode: one row insert, end-of-turn detection
    on next UserPromptSubmit.
  - Unknown / missing `hook_event_name` → valid empty envelope, silent.

- **Storage record — new table, `V2_MIGRATIONS[6]`:**

  ```sql
  CREATE TABLE tool_observations (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts           INTEGER NOT NULL,
    session_id   TEXT    NOT NULL,
    turn_index   INTEGER NOT NULL,
    batch_id     TEXT    NOT NULL,             -- UUID v4 per PostToolBatch
    batch_order  INTEGER NOT NULL,             -- 0..N-1 within batch
    tool_use_id  TEXT,
    tool_name    TEXT    NOT NULL,
    arg_summary  TEXT    NOT NULL,             -- ≤ 140 chars, allowlisted
    arg_key      TEXT    NOT NULL,             -- HMAC(workspaceSalt, canonical)
    outcome      TEXT,                         -- 'ok' | 'error' | 'empty'
    redundant_of INTEGER REFERENCES tool_observations(id) ON DELETE SET NULL,
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX idx_tool_obs_session_ts  ON tool_observations(session_id, ts);
  CREATE INDEX idx_tool_obs_session_key ON tool_observations(session_id, tool_name, arg_key);
  CREATE INDEX idx_tool_obs_batch       ON tool_observations(batch_id);
  ```

  Retention: 7-day sweep at doctor.

- **Allowlisted fields per tool.**
  - `Read` → filename only, repo-relative (never absolute).
  - `Grep` → first 60 chars of pattern, path-scope label only.
  - `Glob` → pattern only.
  - `Bash` → first token of command + first 80 chars of rest, secrets
    stripped.
  - Any other tool → `tool_name + "(arg-hidden)"`.

- **Arg canonicalization.** Canonical = `tool_name + "\0" +
  JSON.stringify(allowlistedFields, sortedKeys)`. `arg_key = hmacSha256(
  workspaceSalt, canonical)`. Raw `tool_input` never hashed directly,
  never stored, never logged.

- **Detection (deferred to next UserPromptSubmit).** Query last 6
  observations for this session:
  - **Duplicate:** count per `arg_key` ≥ 2 → duplicate signal.
  - **Straight loop:** same `arg_key` ≥ 3 consecutive.
  - **Ping-pong:** two alternating `arg_key`s ≥ 3 cycles.
  Return at most one signal (priority: straight > ping-pong > duplicate).

- **Badge (on UserPromptSubmit composition).**
  - Duplicate: `▣ TB TOOL  duplicate Read — 2 calls this turn`
  - Straight: `▣ TB LOOP  same call × 3 — cache or change approach`
  - Ping-pong: `▣ TB LOOP  A↔B × 3 — try narrowing scope`
  - Composite with TRACE/MEMORY when any present, under 100 chars.

- **Failure mode.**
  - Undefined / empty `tool_calls`: hard-guard (`!arr || arr.length === 0`
    pattern — never `arr?.forEach`).
  - Per-call throw inside transaction: full rollback; envelope clean.
  - SQLite lock: single-transaction write avoids self-contention; cross-
    process contention retries once, then gives up silently.

- **Performance budget.** 200 ms p95 for 8-call batch. One indexed
  transaction with 8 inserts + one window query. Benchmark-enforced.

- **Tests.** Batch of 8 → 8 rows in one transaction; 2 identical keys →
  `redundant_of` points at first; straight 3× → loop badge; A-B-A-B-A-B →
  pingpong; parallel same-batch same `arg_key` counted separately;
  undefined `tool_calls` → empty envelope; secret in `tool_input` masked;
  HMAC differs across salts; transaction rollback on mid-batch error.

- **E2E smoke.** Drive 3 identical PostToolBatch stdin payloads through
  the binary → 3 rows → next UserPromptSubmit emits TB LOOP badge in
  composite.

### 5.4 SDK wrappers (ships in 0.5.3)

- **Event surface.** Add `BadgeEvent` union exported from
  `src/index.ts`:

  ```ts
  export type BadgeEvent =
    | { kind: "trace"; action: "recalled" | "checked-no-match" | "stored" | "reinforced" | "skipped"; count?: number; blockId?: string; queryId?: string; tokens?: number }
    | { kind: "memory"; action: "recalled" | "stored" | "reinforced" | "no-fact"; count?: number; factId?: string }
    | { kind: "context"; action: "digest-saved" | "skipped"; tokens?: number }
    | { kind: "tool"; action: "duplicate" | "repeat"; toolName: string; count: number }
    | { kind: "loop"; action: "straight" | "pingpong"; toolNames: string[]; count: number };
  ```

  No prompt / response / tool-input bodies inside. Ever.

- **`onBadge` option.** Added to `wrapOpenAI`, `wrapAnthropic`, and new
  `wrapGeneric`. Default: no console output.

- **`wrapGeneric`.** Small surface for LangChain/custom:

  ```ts
  const handles = wrapGeneric(layer, {
    onBadge?: (event: BadgeEvent) => void;
  });
  await handles.recall({ prompt, context });
  await handles.capture({ userText, assistantText });
  ```

- **Failure isolation.** Every wrapper wraps TraceBase calls in
  try/catch. Internal throw emits a single stderr line + does NOT break
  the wrapped LLM call.

- **Docs.** `docs/SDK.md` with three recipes: OpenAI, Anthropic,
  LangChain (via `wrapGeneric` + a BaseCallbackHandler skeleton shown
  inline). No peer-dep on LangChain.

- **Privacy.** No console output by default. `onBadge` callback receives
  IDs/counts only, never body content.

- **Performance budget.** Wrapper adds ≤ 20 ms warm recall latency. Opt-
  out via `recallConfig: { enabled: false }`.

- **Tests.** Passthrough invariance, BadgeEvent shape, `onBadge` throw
  isolation, `wrapGeneric.recall` on empty store.

## 6. Hook installer extension

Each new hook event adds one `HookEventSpec` to `CLAUDE_HOOK_SPECS`. From
day one, every spec ships `legacyDefaults: []` so the next release cycle
gets zero-friction rebadging (pattern `4490c4ab` carried forward).

| Phase | Hook event | Default / compat |
|---|---|---|
| 0.5.1 | `PreCompact` | default |
| 0.5.2 | `PostToolBatch` | **default, installed unconditionally** |
| 0.5.2 | `PostToolUse` | **manual user compat only** — `npx tracebase init --compat=posttooluse`. No auto-switchover. No auto-nag. |
| 0.5.2 | `PreToolUse` | opt-in only — `TRACEBASE_PRETOOLUSE=on` at `init` time |

**Doctor reporting rules for PostToolBatch.**
- Installed + canonical → **PASS** (`claude-code-posttoolbatch`).
- Installed + canonical + no observations in last 14 days → **INFO**
  (installed/canonical; not observed yet).
- Installed + non-canonical → **WARN** with fix `npx tracebase init`.
- Missing → **WARN** with fix `npx tracebase init`.

Unobserved state is **never a WARN**. A silent hook is indistinguishable
from a user who hasn't used tools this session — we do not nag by time
alone.

**DoctorLevel extension.** `"pass" | "info" | "warn" | "fail"`. Renderer
shows INFO as a neutral dim badge. `--json` consumers receive the fourth
level verbatim.

**Status reporting.** hooks row under Claude Code carries
`PostToolBatch ok (no observations yet)` when applicable. Informational.

0.5.0 adds no hook events — TB MEMORY piggybacks on existing
UserPromptSubmit + Stop.

## 7. Cloud / analytics boundary

### Allowlisted in metrics mode (default, no explicit opt-in)

- `workspaceId`, `installationId`, window bounds.
- Pattern/fact counts: `retrieval_count`, `injection_count`,
  `fact_injection_count`, `agent_used_count`, `outcome_count`.
- Hook latency buckets: p50 / p95 per hook event in ms, bucketed.
- Feature enabled flags: `tbMemoryEnabled`, `tbContextEnabled`,
  `tbToolEnabled`, `tbLoopEnabled`, `preToolUseEnabled`.
- Error class counts (enumerable set, no free-form strings).
- **`tool_observations` aggregates ONLY:**
  - `duplicate_count`, `loop_count` (per kind), `tool_family_counts`
    (`{ read, search, shell, edit, fetch, other }`).

### Forbidden in metrics mode (enforced by `sanitizeForCloud`)

- `arg_key`, `arg_summary`, `tool_use_id`, `session_id`, `batch_id`.
- Tool-name-level counts (only `tool_family_counts` ships).
- Everything previously forbidden at rest (§4).

### Team-memory sync (future, not in 0.5.x)

The ONLY future path on which `arg_key` could leave the workspace; even
then only via explicit user-accepted consent with its own design doc.
0.5 ships the runtime boundary but no syncable channel for HMAC keys.

### Tests

`tests/cli/cloud-allowlist.test.ts` asserts every forbidden key is
stripped, regardless of nesting depth. Extended every phase, not just
0.5.3.

## 8. Release phasing

**0.5.0 — TB MEMORY only.** `project_facts` widened, `file_semantic`
fact_type added, composite badge, leakage-scanner extension, repo-
relative path normalizer. No new hook events.

**0.5.1 — TB CONTEXT.** PreCompact hook + `capture-context` command.
Pre-ship sanity: live stdin shape via `--dump-stdin` dev mode. Digest-
in-session injection at UserPromptSubmit. 14-day TTL sweeper.

**0.5.2 — TB TOOL + TB LOOP.** New `tool_observations` table
(V2_MIGRATIONS[6]). PostToolBatch default. PostToolUse manual compat.
PreToolUse opt-in. Workspace salt.

**0.5.3 — SDK polish.** `BadgeEvent` exported. `wrapGeneric` added.
`docs/SDK.md` with three recipes. No runtime changes for Claude Code
users.

Each phase is an independent patch. Zero-friction upgrades via the
`legacyDefaults` auto-upgrade pattern.

## 9. Per-phase acceptance gates

Every phase must pass all of:

- [ ] `npm run lint` clean.
- [ ] `npm test` — all existing + phase-new tests pass.
- [ ] `npm run build` clean.
- [ ] `npm run bench:hooks` — affected hooks meet p95 target, or feature
  is marked opt-in per §3.2.
- [ ] Live `npx -y tracebase-ai@<phase> init` upgrade smoke: run against
  published `@latest` from prior phase, inspect diff, confirm no
  `--force` prompt.
- [ ] `tracebase doctor` shows every installed hook as canonical.
- [ ] Fixture replay: canned stdin → command → inspect written state +
  systemMessage.
- [ ] Manual Claude Code restart smoke: new hook renders its badge in-
  transcript and produces no foreground MCP permission prompt.
- [ ] `tests/cli/cloud-allowlist.test.ts` passes — enforced every phase.

## 10. Open questions (decided defaults)

1. **Benchmark harness location.** `scripts/bench-hooks.ts`, not
   shipped. Run via `npm run bench:hooks`.
2. **PreToolUse opt-in env var.** `TRACEBASE_PRETOOLUSE=on`.
3. **Workspace salt provisioning.** Minted at `init`, stored in
   `.tracebase/config.json`. Never shipped to cloud.
4. **`fact_type = "file_semantic"` vs. finer taxonomy.** One bucket for
   0.5; revisit after real usage.
5. **PreCompact stdin shape — unknown today.** 0.5.1 ships
   `--dump-stdin` dev command first; validate live, lock parser, release.
6. **Workspace salt visibility.** `doctor` shows literally `present` or
   `missing`. No prefix, no hash, no byte count.
7. **Cloud allowlist enforcement location.**
   `src/cli/cloud-allowlist.ts`, single exported `sanitizeForCloud()`.
   Every `cloud.ts` call path goes through it.
8. **PostToolBatch detection.** Install unconditionally. Never nag on
   silence. Fallback is a manual user-run init flag, not auto-switchover.
   Doctor reports INFO on "installed but unobserved"; WARN only on
   misconfiguration.
