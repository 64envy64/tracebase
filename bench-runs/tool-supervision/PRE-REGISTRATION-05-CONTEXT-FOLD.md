# 05 Context Fold — Pre-Registration (Path B: synthetic integration)

**SPEC LOCKED 2026-05-27.** Implementation checklist remains open; no scenario runs until every checklist box is checked. Path A (real-agent child-CLI) is **explicitly out of scope** for this pre-reg — see §"Why synthetic, not real-agent" for the rationale. A future Path A 05 would require a different pre-registration entirely.

Located under `bench-runs/tool-supervision/` (alongside the 03 / 04 pre-regs) because they share the Path A/B substrate vocabulary. The mechanism under test here (context fold) is unrelated to tool supervision substantively, but the PRE-REG file shape and bench shelf live together for discoverability.

## Why synthetic, not real-agent

Three cross-bench learnings constrain 05:

1. **03 Path A** (commit `97540bf`) showed haiku-small-task workloads don't produce sequential safe-read duplicates often enough to measure supervision.
2. **04 Path A** (commit `1ac5928`) showed the same workloads don't produce `straight`/`pingpong`/`duplicate` loop patterns either.
3. **Context fold's trigger is `PreCompact`**, which fires either when the user types the `/compact` slash command (interactive only — NOT triggerable from `claude --print --output-format json` headless mode the Path A harness uses) or when Claude Code auto-compacts on near-full-context. Auto-compaction on haiku in headless mode is structurally hard to reach without padding prompts to force context fill — which is cherry-pick.

Path B-style synthetic integration (mirror of 03 Path B's published mechanism-correctness bench) is the highest-confidence-per-dollar path for 05. It drives the production `capture-context` and `inject-context` CLIs against synthesized transcript jsonl files and verifies the fold + persist + recall + render flow end-to-end without any API spend.

## Claim under test (locked scope)

> **Given a production-shaped transcript, `capture-context` (PreCompact backend) folds old turns into `session_chunks` rows; a subsequent `inject-context` (UserPromptSubmit backend) call in the SAME session recalls and renders those chunks as a `<context_fold>` block in `additionalContext`, while respecting privacy/injection skip rules and same-session isolation.**

Narrow on purpose. The claim verifies the **mechanism wiring** end-to-end through production CLIs. It does NOT extend to agent-level behaviour, savings, coherence, or compaction performance in real Claude sessions.

### In scope (what the bench will verify)
- `capture-context` on a synthetic transcript with >CHUNK_TURN_LIMIT new turns writes ≥1 row to `session_chunks`.
- Tails below `MIN_CHUNK_TOKENS` emit `context.fold_skipped` event with `reason: "below-threshold"`.
- `inject-context` for the SAME `session_id` as the captured chunks renders a `<context_fold>` section in the envelope's `additionalContext`.
- `inject-context` for a DIFFERENT `session_id` does NOT render those chunks (same-session isolation enforced).
- Transcripts containing leakage shapes (API key, absolute path with secret) cause the chunk to be skipped with `reason: "leakage"`; no row in `session_chunks`.
- Transcripts containing prompt-injection patterns cause the chunk to be skipped with `reason: "injection"`; no row in `session_chunks`.

### Out of scope (explicitly excluded; called out as caveats in any report)
- **Token savings.** Not measured. The bench produces no per-trajectory tokens/duration deltas.
- **Long-horizon pass-rate.** Not measured. The bench does not run an agent; there is no pass/fail per task.
- **Agent coherence after compaction.** Not measured. The bench verifies the recall step renders the chunks, NOT that an agent acts coherently on them.
- **Compaction performance in real Claude sessions.** Not measured. The bench bypasses Claude Code's actual compaction trigger by invoking `capture-context` directly with a synthesized PreCompact stdin.
- **Embedding / llm summarizer variants.** `summarizer` defaults to `"heuristic"`; the other values are reserved type stubs not exercised by production today. Out of scope.
- **TTL expiry behaviour.** `expires_at` is set; pruning is a separate code path. Not exercised by this bench.

## Method

Each scenario is a deterministic synthetic-input pipeline:

1. Build a fresh temp workspace; `initConfig` it.
2. Write a synthetic transcript jsonl file with N pre-shaped turns.
3. Invoke `tracebase capture-context --path <ws>` via `spawnSync`, piping a synthetic `PreCompact` stdin (`{ hook_event_name, session_id, transcript_path, cwd, trigger }`).
4. (Recall scenarios) Invoke `tracebase inject-context --path <ws>` via `spawnSync`, piping a synthetic `UserPromptSubmit` stdin (`{ hook_event_name, session_id, prompt, cwd }`). Capture `stdout.hookSpecificOutput.additionalContext`.
5. Open `<ws>/.tracebase/memory.db` read-only; query `session_chunks` rows and parse `analytics_events.payload` for `context.fold_skipped` (and `context.folded` if emitted — see §"Open known gap").
6. Compare actual vs expected per scenario.
7. Tear down workspace.

Same shape as 03 Path B integration test — production CLIs, synthetic inputs, DB inspection.

### Synthetic-transcript shape

Production transcripts are jsonl with assistant/user `message.role` records (this format is already parsed by `extractTurnsFromJsonl` in `src/runtime/digest.ts`). Synthetic transcripts emit matching shape:

```jsonl
{"message":{"role":"user","content":"<user turn text>"}}
{"message":{"role":"assistant","content":"<assistant turn text>"}}
...
```

Turn content sizes are tuned per scenario to land in or out of `CHUNK_TURN_LIMIT (8)` / `CHUNK_TOKEN_LIMIT (4000)` / `MIN_CHUNK_TOKENS (50)` per `src/core/context-fold.ts`.

## Scenarios (locked — 6 total)

For all scenarios: workspace = fresh temp dir, `initConfig` + empty `reasoning_blocks` + empty `indexed_files` (no contamination from sibling lanes).

| # | Scenario | Synthetic transcript | Capture invocation | Recall invocation | Expected DB state | Expected events | Expected `additionalContext` |
|---|---|---|---|---|---|---|---|
| 1 | `happy-fold` | 16 turns (8 user + 8 assistant), each ≥150 chars → buffer hits CHUNK_TURN_LIMIT twice | capture-context with session_id = "session-happy" | — | `session_chunks` rows ≥ 1 (≥2 if both chunks landed) | NO `fold_skipped` rows (no leakage/injection/below-threshold) | n/a |
| 2 | `below-threshold-tail` | 9 turns total: first 8 each ≥150 chars (chunk flushes at turn 8); 9th turn ~15 chars (residual under MIN_CHUNK_TOKENS) | capture-context with session_id = "session-below" | — | `session_chunks` rows = 1 | `context.fold_skipped` with `reason: "below-threshold"` count ≥ 1 | n/a |
| 3 | `same-session-recall` | Same as scenario 1's happy-fold | capture-context with session_id = "session-recall" | inject-context with same session_id = "session-recall" | `session_chunks` rows ≥ 1 | — | additionalContext text contains the substring `<context_fold>` |
| 4 | `different-session-no-recall` | Same as scenario 1's happy-fold, stored under session_id = "session-A" | capture-context with session_id = "session-A" | inject-context with DIFFERENT session_id = "session-B" | session A rows ≥ 1, session B has no chunks | — | additionalContext text does NOT contain `<context_fold>` (or, if a `<context_fold>` block appears for some other unrelated reason, it must NOT contain content from session A's chunks) |
| 5 | `privacy-leakage-skip` | 16 turns where one user turn includes a leakage shape (e.g. `sk-ant-api03-CONTRIVED-LEAKAGE-TOKEN-FOR-TEST`, or an `.env`-style fragment) | capture-context with session_id = "session-leak" | — | `session_chunks` row for the leak-containing chunk = 0; other chunks may still land if separable | `context.fold_skipped` with `reason: "leakage"` count ≥ 1 | n/a |
| 6 | `privacy-injection-skip` | 16 turns where one user turn includes a prompt-injection shape (e.g. literal `Ignore previous instructions and …` per `detectPromptInjectionPatterns`) | capture-context with session_id = "session-inj" | — | `session_chunks` row for the injection-containing chunk = 0 | `context.fold_skipped` with `reason: "injection"` count ≥ 1 | n/a |

**Note on chunk-vs-row counts**: `foldTurns` produces chunks deterministically from the buffer; `BlockStore.recordSessionChunks` returns an `inserted` count that respects an INSERT OR IGNORE on `turn_hash`. Asserting `rows ≥ 1` is the safer construct than asserting exact counts, because the boundary semantics (whether turn 8 flushes before or after the 8th turn enters the buffer) are tested in unit tests; the bench's job is end-to-end wiring, not boundary re-verification.

## Open known gap (declared at lock time)

`src/types.ts:2168` defines `ContextFoldedEvent` (`event: "context.folded"`), but I did **not** find an emit site in `src/cli/commands/capture-context.ts` during survey. The type appears to be declared without a wired producer. **Implication for the bench**:

- **Source of truth for "fold happened"** is the `session_chunks` row count (from DB query), NOT the `context.folded` event count.
- The bench MUST NOT fail a scenario for absence of `context.folded` events.
- The bench MUST descriptively report `context.folded` event count if any are observed (could indicate a discovered emit site I missed during survey). If consistently 0 across all scenarios, the bench's final report calls this out as a discovered gap and recommends a follow-up either to wire the emit OR to remove the unused type.

This is an **observation about the production code surface**, not a bench failure mode. Documented here to keep the bench's gate rules aligned with what the production code actually emits.

## Metrics (locked)

Per scenario:
- `session_chunks_rows` (integer, from `SELECT COUNT(*) FROM session_chunks WHERE session_id = ?`)
- `fold_skipped_counts` (`Record<reason, number>` from parsing `analytics_events.payload` for `event: "context.fold_skipped"`)
- `folded_event_count` (integer, descriptive — see §"Open known gap")
- `additional_context_includes_context_fold` (boolean — substring match on `<context_fold>`; recall scenarios only)
- `pass` (boolean — strict equality on the per-scenario expectations table above)

## Decision rules (locked)

### §A. Publishable criteria
All five must hold:
1. **All 6 scenarios pass** (each scenario's expectations hold exactly per the per-row spec).
2. **No exception escapes the CLI envelope** — `capture-context` and `inject-context` exit cleanly (exit 0) on every invocation.
3. **No leakage of synthetic-leak material across the privacy scenarios** — verified by grepping the final workspace's `.tracebase/memory.db` for the planted leakage tokens after scenario 5 runs (must return zero hits).
4. **Same-session isolation enforced** — scenario 4 explicitly verifies cross-session no-recall.
5. **Open-known-gap declared honestly in the report** — `context.folded` event behaviour reported descriptively regardless of value.

### §B. Internal-only outcomes
- §A.1 fails on exactly one scenario → "single scenario regression" — investigate (production code change, fixture drift, or pre-reg labelling error per the Path B Amendment 1 protocol). Not publishable until fixed.
- §A.1 fails on multiple scenarios → mechanism wiring or harness fundamentally broken; fix before any further bench work.

### §C. Re-design
- §A.3 fails (leakage escaped) → critical privacy regression — halt bench, file production bug, do not publish even internally.

## Reporting structure (locked)

On §A success:
- Write `bench-results/publishable/context-fold.md`
- Headline: "Given a production-shaped transcript, capture-context folds old turns into session_chunks; subsequent inject-context in the same session renders those chunks as `<context_fold>`, with same-session isolation and privacy skip rules enforced."
- Caveats up front: synthetic transcript (not real agent), N=6 scenarios, mechanism-correctness only NOT savings, declares the `context.folded` open-known-gap if applicable
- Per-scenario table mirroring this pre-reg's scenario table + observed columns
- §"What this measures / does not measure" listing the §"Out of scope" items verbatim
- §"Open known gap" reproducing the gap finding (whether confirmed-still-gap or discovered-emit-site)
- §"How this fits the full TraceBase savings narrative" — add a row to the existing table next to 02/03 entries

On §B / §C outcomes:
- Write `bench-results/internal-diagnostics/context-fold-synthetic.md` instead, with "NOT publishable because ..." at top

## Cost basis

| Stage | Estimate |
|---|---|
| Driver implementation | ~0 (local TypeScript only) |
| 6 scenarios × 1 CLI invocation each + DB read | ~0 (local CLI, no API) |
| **Total reasonable cap** | **$0 API spend** |

Local CPU + disk only. No Anthropic API calls anywhere in this bench.

## Lock block

Spec-level lock (no changes without an Amendment after this point):

- [x] Spec scope locked: mechanism-correctness only via production CLIs on synthetic transcripts. Explicitly NOT agent-level savings.
- [x] 6 scenarios fixed at exactly the table in §"Scenarios".
- [x] Source-of-truth for "fold happened" = `session_chunks` row count, NOT `context.folded` event (per §"Open known gap").
- [x] Same-session isolation tested in scenario 4 (load-bearing privacy guarantee).
- [x] Privacy skip rules tested in scenarios 5 + 6 (leakage + injection).
- [x] Pre-registration locked: **2026-05-27**.
- [x] Worktree + commit SHA at lock: `claude/interesting-mcclintock-a69a77` @ `24ae744` (HEAD after the 04 pause + type-fix chain).

Implementation checklist (no run until all complete):

- [ ] Synthetic-transcript builders for the 6 scenarios written under `scripts/path-b-context-fold/fixtures/<id>.ts` (or equivalent inline-in-driver helpers).
- [ ] Driver implemented under `scripts/path-b-context-fold/integration.ts` (mirrors `scripts/tool-supervision-bench/integration.ts` shape: drive scenarios, assert per-row, write `bench-runs/context-fold-path-b/integration-results.json`).
- [ ] Pre-flight unit tests pass: `tests/core/context-fold.test.ts` (target: green at lock). Run before driver dispatch.
- [ ] Driver run produces 6/6 PASS.
- [ ] Privacy regression check: grep workspace memory.db after scenario 5 for planted leakage token (must return 0 hits).
- [ ] Results documented under `bench-runs/context-fold-path-b/integration-results.json` + `bench-results/publishable/context-fold.md` (if 6/6 PASS) OR `bench-results/internal-diagnostics/context-fold-synthetic.md` (if any fail).

After ALL implementation boxes checked AND 6/6 scenarios pass: publish. No scenario additions or expectation edits permitted post-lock except via the Amendments block below (mirror Path B Amendment 1 protocol from 03 — labelling errors caught at first run get a one-line correction + reproduce-both-results disclosure).

## Amendments (post-lock changes documented in full)

(none yet — populated only if a run exposes a spec-level issue requiring scope adjustment)

## Files this pre-reg will produce (after lock + run)

- `scripts/path-b-context-fold/integration.ts` — driver (mirrors 03 Path B `scripts/tool-supervision-bench/integration.ts`)
- `scripts/path-b-context-fold/fixtures/` — synthetic transcript builders (or inline helpers in driver — equivalent)
- `bench-runs/context-fold-path-b/integration-results.json` — raw per-scenario result
- `bench-results/publishable/context-fold.md` (if §A passes) OR `bench-results/internal-diagnostics/context-fold-synthetic.md` (if §B/§C)
- Optional: `bench-results/README.md` +1 row for whichever doc lands

## What this pre-reg explicitly does NOT do

- No Path A (real-agent child-CLI). Out of scope per §"Why synthetic, not real-agent".
- No API spend. Local-only bench.
- No token / wall-time / pass-rate claims.
- No claim about Claude Code's actual compaction trigger behaviour in production.
- No `summarizer` variant exploration (embedding / llm).
- No mechanism code changes — this is a verification of existing production code, not a refactor.
