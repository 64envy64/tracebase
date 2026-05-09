/**
 * Public types for the agentic demo harness.
 *
 * Each fixture task is run twice — once with TraceBase OFF (no
 * inject-context, no supervision, no capture), once with it ON. Both
 * runs produce a `RunArtifact`. `computeComparison(off, on)` is the
 * pure derivation of the demo's headline numbers.
 *
 * No demo-runner code lives in this file — it's the contract.
 */

export type Variant = "off" | "on";

/**
 * Provenance of a `RunArtifact`. The two are NOT interchangeable in
 * the report — synthetic numbers are illustrative for the harness
 * contract; only `real` numbers are eligible for an external demo
 * overlay or investor-facing claim.
 */
export type RunSource = "synthetic" | "real";

export interface TokenUsage {
  /** Input tokens charged by the provider, or estimated by char/4. */
  input: number;
  /** Output tokens. */
  output: number;
  /** input + output. */
  total: number;
  /** Where the numbers came from. "estimate" = char/4 fallback. */
  source: "provider" | "estimate";
}

export interface ToolCallSummary {
  /** Total tool calls the agent made (including duplicates). */
  total: number;
  /**
   * Consecutive same-tool same-arghash calls — what TraceBase's
   * supervision targets. Counted post-hoc from the trajectory; the
   * value lives in the artifact even when the variant is OFF, so the
   * report can show how many duplicates the agent would have made
   * without supervision.
   */
  duplicates: number;
  /** Per-tool counts (`Read: 6, Bash: 4, ...`). */
  byName: Record<string, number>;
}

export interface VerifierResult {
  /** Verifier shell command (run inside the workspace). */
  command: string;
  /** Process exit code. */
  exitCode: number;
  /** True iff exitCode === 0. */
  pass: boolean;
  /** Stdout + stderr, truncated to ~500 chars. */
  outputExcerpt: string;
}

export interface TraceBaseTelemetry {
  /**
   * Total tokens introduced by every `<tracebase queryId="…">…
   * </tracebase>` block injected during this run. Net token savings
   * subtract this from the off-vs-on token delta.
   */
  injectedTokens: number;
  /** Wall time the agent spent waiting on TraceBase hooks. */
  overheadMs: number;
  /** Distinct queryIds emitted by `get_reasoning_patterns` calls. */
  queryIds: string[];
  /**
   * Count of tool calls that were actually blocked by supervision
   * (block-after-N for search loops, safe-read dedup). Counted only
   * when a real block event exists in the trajectory; an OFF run
   * always reports 0 here because no events are emitted.
   */
  blockedToolCalls: number;
}

export interface RunArtifact {
  task: string;
  variant: Variant;
  /**
   * Where the agent-side numbers came from. The verifier result is
   * always real (the runner re-runs the verifier command against a
   * fresh workspace before writing the JSON), but the wall-clock,
   * token, and tool-call numbers may be:
   *   - "synthetic": authored-by-hand fixture (illustrative, NOT for
   *     external demos);
   *   - "real": captured from a real-agent recording (Anthropic API
   *     usage + tool-use trace).
   */
  source: RunSource;
  /** Epoch ms when the run started. */
  timestamp: number;
  model: string;
  wallClockMs: number;
  tokens: TokenUsage;
  toolCalls: ToolCallSummary;
  /** null on OFF runs (no TraceBase activity to summarise). */
  tracebase: TraceBaseTelemetry | null;
  verifier: VerifierResult;
  /** Optional free-form note (e.g. "synthetic baseline" / "replay of <date>"). */
  notes?: string;
}

export interface ComparisonDelta {
  /** off.wallClockMs − on.wallClockMs.  Positive → ON faster. */
  timeMs: number;
  /** off.toolCalls.total − on.toolCalls.total. */
  toolCalls: number;
  /** off.toolCalls.duplicates − on.toolCalls.duplicates. */
  duplicates: number;
  /** off.tokens.total − on.tokens.total (raw, before crediting injection). */
  tokensTotal: number;
  /** Net = tokensTotal − on.tracebase.injectedTokens. The honest savings number. */
  tokensTotalNet: number;
  /** Pulled from on.tracebase. Zero when tracebase is null. */
  injectedTokens: number;
  /** Pulled from on.tracebase. Zero when tracebase is null. */
  blockedToolCalls: number;
  /** Pulled from on.tracebase. Zero when tracebase is null. */
  overheadMs: number;
  /** Pass-fail agreement between the two runs — the load-bearing demo signal. */
  verifierAgreement:
    | "both-pass"
    | "both-fail"
    | "off-pass-on-fail"
    | "off-fail-on-pass";
}

export interface ComparisonReport {
  task: string;
  off: RunArtifact;
  on: RunArtifact;
  delta: ComparisonDelta;
}

export interface TaskDefinition {
  /** Task id (matches directory name under demo-tasks/). */
  id: string;
  /** One-sentence description for the report. */
  description: string;
  /** Verifier shell command run from the workspace root. */
  verifier: string;
  /** Agent model used for the recorded transcripts (informational). */
  model: string;
  /** Path (relative to the task dir) to the user prompt — required by the real-agent runner; the synthetic runner ignores it. */
  prompt?: string;
  /** Path (relative to the task dir) to a seeded-patterns JSON file used by the ON variant of the real-agent runner. */
  seededPatterns?: string;
  /** Hard ceiling on agent turns in the real-agent runner. */
  maxTurns?: number;
  /** Free-form note describing how the recorded numbers were obtained. */
  notes?: string;
}
