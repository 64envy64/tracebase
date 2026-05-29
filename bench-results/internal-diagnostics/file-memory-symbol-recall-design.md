# Symbol-level recall — scoped design note (internal)

**Why.** File-level lexical recall plateaus on two repo shapes (offline eval):
- **Monolithic files** (zod: `packages/zod/src/v4/classic/schemas.ts` holds
  `ZodRecord`, `ZodNumber`, `ZodTransform`, … for many tasks). A concept query
  ("record") never matches the file summary — the file's summary only holds
  ~12 of hundreds of symbols, and FTS does not split `ZodRecord` into "record".
  → zod recall@5 = 1/9.
- Per-feature repos (mathjs/rich) already do well (5/7, 5/6) via filename boost.

**Idea (general, no repo rules).** Index **symbols** alongside files. Each
exported/top-level symbol becomes a searchable row carrying its name, its
camelCase/snake split tokens, a short signature/context line, and its parent
file path. At recall, query tokens hit symbol rows; we **roll up** symbol hits
to their parent files and feed those files into the existing file-recall
candidate set as a new match signal. "record" → symbol `ZodRecord` (split
"record") in `schemas.ts` → `schemas.ts` becomes a recalled candidate.

## Slice (smallest correct)

1. **Schema (`block-store.ts`).** New `indexed_symbols`:
   `(id, rel_path, name, kind, signature, tokens, language, indexed_at)` +
   FTS5 `indexed_symbols_fts(name, tokens, signature)` (porter unicode61) +
   insert/delete/update triggers, mirroring `indexed_files_fts`. `tokens` =
   space-joined camelCase/snake/kebab split of `name` (so FTS matches concept
   queries). Add DDL to base `V2_SCHEMA` (fresh installs) + a v16 migration
   step (idempotent `CREATE … IF NOT EXISTS`) for existing stores; bump
   `V2_SCHEMA_VERSION` 15→16. On file re-index (hash change) symbols are
   replaced (delete-by-rel_path then insert).

2. **Extraction (`file-summarizer.ts`).** `extractFileSymbols(content, lang)`
   → `{name, kind, signature}[]`, reusing the existing per-language regex
   extractors, extended to (a) capture a short signature line and (b) scan more
   of the file (bounded: ≤ N symbols/file, ≤ M lines). Pure; no I/O.

3. **Indexing (`file-indexer.ts`).** In `persistFile`, after writing the file
   row, delete prior symbols for that rel_path and insert the extracted set
   (bounded total via the existing budget). Privacy: symbol name + signature
   only (same surface as the heuristic summary; no full bodies). Cloud
   allowlist already ships counts only — extend the spec note.

4. **Recall (`file-indexer.ts`).** `recallSymbols(store, query, k)`: FTS over
   `indexed_symbols_fts`, group by `rel_path`, score = count of distinct
   matching symbols (tie-break best bm25). Integrate into `recallFiles`:
   union the symbol-rollup files into the candidate set, and add a
   **symbol-match boost tier** to the existing rank key
   `(boost desc, bm25 asc)` so a file matched only via a symbol still surfaces.
   Keep doc/test suppression + filename boost unchanged. Single entry point —
   no caller churn.

## Principles / guardrails
- General only: no repo names, no per-repo branches, no expected-file hardcodes.
- No gate lowering (0.4 serving gate + MIN_PROMPT_CHARS untouched).
- Bounded: symbol count/file + total capped; summaries stay ≤600/≤256.
- Every behavior covered by deterministic synthetic tests; measured on the
  25-task offline eval (recall@3/@5, per-repo, doc-FP count) after the change.

## Success gate (before any paid pilot)
overall recall@5 ≥ 70% · mathjs/rich ≥ 80% · zod ≥ 5/9 · doc/README FP ≈ 0 ·
no gate lowering · no hardcodes. If the slice misses, iterate extraction/rollup
— do not tune thresholds or add repo rules.
