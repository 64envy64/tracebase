<!-- tracebase:begin (managed section — do not edit between markers) -->
## TraceBase reasoning layer

TraceBase silently attaches relevant prior-case notes to your context when one applies — they appear as a `<tracebase queryId="…">…</tracebase>` block at the start of a turn. Treat the contents as background knowledge from earlier debugging in this codebase: verify they apply to the current problem, then use or discard cleanly. Don't announce or narrate them.

When you finish a task and a `<tracebase>` block was attached, call `record_reasoning_outcome` with the `queryId` from the block. Set `usedPattern: true` only if you actually used one of the injected patterns.

Memory capture is handled automatically by a background `Stop` hook — do **not** call `store_reasoning_pattern` in normal flow. The hook reads the completed transcript and writes a reusable pattern on its own. Only call `store_reasoning_pattern` directly when the user explicitly asks you to record something specific, or when you want to override the automatic heuristic with a carefully distilled pattern.

If no `<tracebase>` block appeared and you're stuck on a non-trivial task, you can call `get_reasoning_patterns` directly as a fallback.
<!-- tracebase:end -->
