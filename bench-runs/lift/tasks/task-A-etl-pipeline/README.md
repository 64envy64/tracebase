# Task A — ETL Pipeline

`npm test` is failing. The `Pipeline.run()` orchestrator is supposed to fetch records, transform them, and persist every one to the DB before returning. The reported count says the records were processed, but the DB ends up empty (or partial). Tests assert that `db.size()` equals the input count after `run()` resolves.

Investigate. Fix the source so the tests pass. Do not edit tests.

Files:
- `src/pipeline.ts` — orchestrator
- `src/ingester.ts` — fetches records
- `src/transformer.ts` — transforms records
- `src/loader/loader.ts` — public loader API
- `src/loader/batchWriter.ts` — does the per-record writes
- `src/loader/retryPolicy.ts` — retry / backoff helpers
- `src/db.ts` — async fake DB
- `src/types.ts` — shared types
- `tests/pipeline.test.ts` — acceptance tests (fixed)
