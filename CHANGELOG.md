# Changelog

All notable changes to `tracebase-ai` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [SemVer](https://semver.org/spec/v2.0.0.html).

For pre-0.8.0 releases the changelog was reconstructed from the npm
publish log; entries are coarse summaries rather than per-PR notes.

## [Unreleased]

### Added

- `tracebase distill --from-block <id>` — manual LLM upgrade lane for
  heuristically-captured blocks. Reconstructs a `ReasoningTrace` from
  an existing block and runs it through the full
  `DistillationPipeline` against `AnthropicDistiller`, defaulting to
  Haiku 4.5 (or Sonnet 4.6 with `--quality`). Result is either a new
  candidate block (LLM rephrased enough to shift the fingerprint) or
  a supporting case ref attached to the source block (fingerprint
  matched — dedupe path). Requires `ANTHROPIC_API_KEY` and the
  optional `@anthropic-ai/sdk` peer.

## [0.8.0] — 2026-05-12

### Fixed

- Added an explicit `tracebase-ai` bin alias alongside `tracebase`.
  Fresh users can now run `npx tracebase-ai init` directly instead of
  relying on npm's single-bin heuristic, which failed on Windows in
  some installs with `"tracebase" is not recognized`.

- Documentation and CLI fix hints now consistently use
  `npx tracebase-ai ...` for package execution. The shorter
  `tracebase` command remains available after install.

### Changed

- `tracebase savings` is now the daily-driver value view for regular
  coders: tasks helped, estimated minutes saved, tokens recycled, top
  memories, and memories that need attention. The deeper event/rate
  numbers stay available behind `--debug`, `tracebase report`, and
  `tracebase events --json`.

- The hosted dashboard's impact page now leads with value-first copy:
  tasks helped, memories shown/used, tokens saved, and a clearer
  "with TraceBase vs held-out" measurement section.

### Added

- `www/public/octopus.svg` for the empty savings state and brand
  accent.

## [0.7.x] — 2026-04 (summary)

- Phase 6.0 hardening: nested-cwd resolution, strict config parsing,
  v2 block schema migration, doctor + events + report + sync + status
  CLI surfaces.

## [0.6.x] — 2026-04 (summary)

- Distillation pipeline (trace → block) with held-out verifier; isotonic
  calibrator wiring.

## [0.5.x] — 2026-04 (summary)

- v2 block-store layer, FTS5 + Jaccard recall, fact-side recall.

## [0.4.x] — 2026-04 (summary)

- Analytics events, lifecycle calibrator, MCP `get_reasoning_patterns`
  and `record_reasoning_outcome` tools.

## [0.3.x] — 2026-04 (summary)

- Initial public release. v1 recall / store / search / explain /
  stats over single-table SQLite store. Wilson-interval quality;
  multi-signal ranking (fingerprint, BM25, Jaccard, structural,
  cosine).
