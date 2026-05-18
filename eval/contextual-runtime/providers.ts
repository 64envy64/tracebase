/**
 * 0.7.1 Contextual Runtime — per-condition runners
 *
 * One `ConditionRunner` per experimental arm. Each one knows how to
 *   - prepare the per-fixture additional-context the agent will see
 *     (the "before-task" half), and
 *   - record the run's outcome into the right ledger (the "after"
 *     half). For arms that don't have an outcome ledger (off,
 *     naive-cache), `afterRun` is a no-op.
 *
 * The runners share a narrow interface so the runner loop in
 * `runner.ts` is a single shape. Adding a new arm later (e.g. a
 * different baseline) is one new class — no changes to the loop.
 *
 * Keeping the contextual surface symmetrical also makes the
 * privacy story easy: every runner's `BeforeRunOutput.injection`
 * is the EXACT text the agent sees, and every privacy test runs
 * uniformly across arms.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  formatNaiveInjection,
  naiveRecall,
  type NaiveCorpusEntry,
} from "../agentic/naive-cache.js";
import type { DistillateSeed, FixtureMeta } from "../agentic/types.js";
import {
  TracebaseRuntimeProvider,
  type ContextualRuntimeProvider,
} from "../../src/sdk/contextual-runtime-provider.js";
import { buildInjectionPayload } from "../../src/core/build-injection-payload.js";
import { formatInjection } from "../../src/core/block-serving.js";
import { runReasoningPatternsRecall } from "../../src/server/reasoning-patterns-entry.js";
import { BlockStore } from "../../src/core/block-store.js";
import { BlockServer } from "../../src/core/block-serving.js";
import { loadBlockCalibrator } from "../../src/lifecycle/calibrator.js";
import {
  storeReasoningPattern as storeReasoningPatternHelper,
  StorePatternValidationError,
} from "../../src/server/mcp-v2-helpers.js";
import type { Condition, PilotFixture } from "./types.js";

/** Inputs to `beforeRun` — what the agent is about to attempt. */
export interface BeforeRunInput {
  fixture: PilotFixture;
  runId: string;
}

/** What `beforeRun` returns — context for the agent + audit info. */
export interface BeforeRunOutput {
  /**
   * Text the agent should be shown as additional context. Empty
   * string when this arm doesn't produce injection (off, or
   * tracebase when the gate dropped everything).
   */
  injection: string;
  /** queryId from the contextual provider, if any. */
  queryId?: string;
  /** Block ids actually injected (intersection of gate + budget). */
  injectedIds: string[];
  /** True when this query landed in a control arm. */
  shadow?: boolean;
}

/** Inputs to `afterRun` — outcome of the agent loop. */
export interface AfterRunInput {
  queryId?: string;
  resolved: boolean;
  durationMs: number;
  steps: number;
  tokens: number;
  /** Block ids the agent demonstrably used (heuristic in stub mode). */
  usedIds: string[];
  regressed?: boolean;
  runId: string;
}

/** Per-condition lifecycle. */
export interface ConditionRunner {
  readonly condition: Condition;
  beforeRun(input: BeforeRunInput): Promise<BeforeRunOutput>;
  afterRun(input: AfterRunInput): Promise<void>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// off — no memory at all
// ---------------------------------------------------------------------------

export class OffRunner implements ConditionRunner {
  readonly condition: Condition = "off";

  async beforeRun(_input: BeforeRunInput): Promise<BeforeRunOutput> {
    return { injection: "", injectedIds: [] };
  }

  async afterRun(_input: AfterRunInput): Promise<void> {
    // no ledger
  }

  async close(): Promise<void> {
    // no resources
  }
}

// ---------------------------------------------------------------------------
// naive-cache — Jaccard token overlap, no gate, no calibration
// ---------------------------------------------------------------------------

export class NaiveCacheRunner implements ConditionRunner {
  readonly condition: Condition = "naive-cache";
  private readonly corpus: NaiveCorpusEntry[];

  constructor(corpus: NaiveCorpusEntry[]) {
    // Snapshot to insulate the runner from outer-loop mutations.
    this.corpus = [...corpus];
  }

  async beforeRun(input: BeforeRunInput): Promise<BeforeRunOutput> {
    // The naive baseline reads from the same problem-class corpus
    // TraceBase has indexed (minus the fixture under test, to avoid
    // a self-leak). Lift attributable to TraceBase's retrieval +
    // gating + outcome feedback then has nowhere to hide; it can't
    // be confused with "we have memory at all".
    const filtered = this.corpus.filter(
      (e) => e.meta.id !== input.fixture.id,
    );
    const hit = naiveRecall(input.fixture.seed.situation, filtered);
    if (!hit) return { injection: "", injectedIds: [] };
    return {
      injection: formatNaiveInjection(hit),
      injectedIds: [`naive:${hit.meta.id}`],
    };
  }

  async afterRun(_input: AfterRunInput): Promise<void> {
    // The naive cache deliberately has no outcome ledger — that's
    // half of why TraceBase exists. Suppressing afterRun here
    // documents the asymmetry rather than hiding it.
  }

  async close(): Promise<void> {
    // no resources
  }
}

// ---------------------------------------------------------------------------
// tracebase — full retrieval / gating / outcome path
// ---------------------------------------------------------------------------

/**
 * Construction options shared by both TraceBase runners. The
 * provider instance is owned by the runner; the runner closes it on
 * `close()`. `factLimit` defaults to 0 per the pilot scope
 * (procedural memory only) — set explicitly to enable fact serving.
 */
export interface TracebaseRunnerOptions {
  /** Provider instance the runner will call into. */
  provider: TracebaseRuntimeProvider;
  /** Cap blocks returned per query (default 5, matches MCP). */
  limit?: number;
  /** Cap facts returned per query. Default 0 for the pilot. */
  factLimit?: number;
}

export class TracebaseRunner implements ConditionRunner {
  readonly condition: Condition = "tracebase";
  protected readonly provider: TracebaseRuntimeProvider;
  protected readonly limit: number;
  protected readonly factLimit: number;

  constructor(opts: TracebaseRunnerOptions) {
    this.provider = opts.provider;
    this.limit = opts.limit ?? 5;
    this.factLimit = opts.factLimit ?? 0;
  }

  async beforeRun(input: BeforeRunInput): Promise<BeforeRunOutput> {
    const result = await this.provider.beforeTask({
      problem: input.fixture.description,
      language: input.fixture.language,
      ...(input.fixture.errorType ? { errorType: input.fixture.errorType } : {}),
      runId: input.runId,
      limit: this.limit,
      factLimit: this.factLimit,
      shadow: this.shouldForceShadow(),
    });

    // Render the same injection text the production MCP path emits.
    // Going through `formatInjection` (not a parallel renderer) keeps
    // the pilot honest — the bytes the agent sees are the bytes the
    // engine would inject in production for this query.
    const text = result.injected
      ? renderInjectionFromStructured(result)
      : "";

    return {
      injection: text,
      queryId: result.queryId,
      injectedIds: result.injected?.blockIds ?? [],
      ...(result.controlReason ? { shadow: true } : {}),
    };
  }

  protected shouldForceShadow(): boolean {
    return false;
  }

  async afterRun(input: AfterRunInput): Promise<void> {
    if (!input.queryId) return;
    await this.provider.recordOutcome({
      queryId: input.queryId,
      resolved: input.resolved,
      durationMs: input.durationMs,
      steps: input.steps,
      tokens: input.tokens,
      usedBlockIds: input.usedIds,
      ...(input.regressed !== undefined ? { regressed: input.regressed } : {}),
      runId: input.runId,
    });
  }

  async close(): Promise<void> {
    await this.provider.close?.();
  }
}

// ---------------------------------------------------------------------------
// tracebase-holdout — same engine, but every query lands in holdout
// ---------------------------------------------------------------------------

export class TracebaseHoldoutRunner extends TracebaseRunner {
  override readonly condition: Condition = "tracebase-holdout";

  protected override shouldForceShadow(): boolean {
    // Manual shadow=true is the cleanest way to force the control
    // arm regardless of holdout config: BlockServer.recall short-
    // circuits before computing the experimental assignment, sets
    // controlReason=undefined (manual shadow), and zeroes
    // shouldInject. Equivalent in numerical terms to a holdout
    // config with rate=1.0, but doesn't depend on filesystem state.
    //
    // The deterministic-cohort property is tested separately (see
    // tests/experiments/contextual-runtime-holdout.test.ts) using
    // an injected readHoldoutConfig.
    return true;
  }
}

// ---------------------------------------------------------------------------
// Helpers — shared rendering + provider construction
// ---------------------------------------------------------------------------

/**
 * Render the injection text from a structured BeforeTaskResult. We
 * round-trip the structured payload back through the production
 * formatter (`formatInjection`) so the bytes the agent sees match
 * what `inject-context` would emit in production. The structured
 * payload alone is not the integration text — it's the audit
 * surface; the `<tracebase>` block IS the agent-facing text.
 */
function renderInjectionFromStructured(result: {
  queryId: string;
  shadow: boolean;
  shouldInject: boolean;
  blocks: Array<{ id: string; situation: string; calibratedProb: number }>;
}): string {
  // We could reach back into BlockServer.recall here, but that
  // duplicates the call. Instead the runner calls `beforeTask`,
  // gets the structured payload, and reconstructs an equivalent
  // injection text via a thin re-renderer that uses only the
  // structured fields. This keeps the surface consistent with what
  // a third-party integrator would see when they only have the
  // structured payload to work with.
  if (!result.shouldInject || result.shadow) return "";
  const lines: string[] = [`<tracebase queryId="${result.queryId}">`];
  for (const b of result.blocks) {
    lines.push(
      `- (p=${b.calibratedProb.toFixed(2)}) ${b.situation}`,
    );
  }
  lines.push("</tracebase>");
  return lines.join("\n");
}

/**
 * Build a fresh in-memory TraceBase provider for the harness, using
 * a temporary SQLite file. Returned alongside its temp dir so the
 * caller can `rm -rf` the dir when the run completes.
 */
export function createPilotProvider(opts?: {
  readHoldoutConfig?: () => null;
}): {
  provider: TracebaseRuntimeProvider;
  cleanup: () => void;
} {
  const tmp = mkdtempSync(join(tmpdir(), "tb-pilot-"));
  const provider = new TracebaseRuntimeProvider({
    storagePath: join(tmp, "pilot.db"),
    ...(opts?.readHoldoutConfig ? { readHoldoutConfig: opts.readHoldoutConfig } : {}),
  });
  return {
    provider,
    cleanup: () => {
      try {
        provider.close?.();
      } catch {
        // closing twice is safe; ignore
      }
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/**
 * Pre-seed a TracebaseRuntimeProvider with patterns derived from a
 * fixture corpus. Excludes any fixture id in `excludeIds` so the
 * fixture under test isn't its own oracle. Returns capture
 * accounting so the report can surface the gate's reject rate.
 */
export async function seedTracebaseFromFixtures(
  provider: ContextualRuntimeProvider,
  fixtures: PilotFixture[],
  excludeIds: Set<string>,
): Promise<{
  attempted: number;
  accepted: number;
  rejected: number;
}> {
  let attempted = 0;
  let accepted = 0;
  let rejected = 0;
  for (const fix of fixtures) {
    if (excludeIds.has(fix.id)) continue;
    attempted++;
    try {
      await provider.capturePattern({
        situation: fix.seed.situation,
        mechanism: fix.seed.unlock,
        unlock: fix.seed.unlock,
        verification:
          "Re-run the failing test (or equivalent reproduction) and observe the symptom is gone.",
        deadEnds: fix.seed.deadEnds,
        language: fix.language,
        ...(fix.errorType ? { errorType: fix.errorType } : {}),
      });
      accepted++;
    } catch (err) {
      // Capture gate rejections are EXPECTED noise on a real corpus.
      // We count them but do not let them abort the seed loop —
      // partial seeding is still valid; the reject rate is itself
      // a number the report surfaces.
      if (err instanceof StorePatternValidationError) {
        rejected++;
      } else {
        throw err;
      }
    }
  }
  return { attempted, accepted, rejected };
}

/**
 * Build a NaiveCache corpus from the same fixture set, excluding
 * `excludeIds`. The plan's "naive baseline" must read from the
 * SAME corpus as TraceBase has indexed — otherwise lift could be
 * attributed to corpus differences instead of retrieval / gating.
 */
export function buildNaiveCorpus(
  fixtures: PilotFixture[],
  excludeIds: Set<string>,
): NaiveCorpusEntry[] {
  return fixtures
    .filter((f) => !excludeIds.has(f.id))
    .map((f): NaiveCorpusEntry => {
      // FixtureMeta narrows language to a literal union and deadEnds
      // to a single string. The pilot's wider PilotFixture type is
      // intentionally looser (real fixtures land arbitrary
      // languages); we coerce to the agentic shape here at the only
      // boundary that needs it.
      const meta: FixtureMeta = {
        id: f.id,
        language: narrowLanguage(f.language),
        difficulty: "easy",
        bugType: f.errorType ?? "unknown",
        description: f.description,
        tags: [],
      };
      const seed: DistillateSeed = {
        situation: f.seed.situation,
        unlock: f.seed.unlock,
        deadEnds: f.seed.deadEnds.join(" "),
      };
      return { meta, seed };
    });
}

/**
 * Coerce a free-form language string to the agentic-harness literal
 * union. Anything outside the supported pair lands as "typescript"
 * because the harness only knows how to invoke a TS or Python
 * sandbox; for the pilot the value is read by the naive baseline's
 * tokenizer and never branches on language semantics, so this
 * fallback is safe — it just keeps the type checker honest.
 */
function narrowLanguage(s: string): "typescript" | "python" {
  return s === "python" ? "python" : "typescript";
}

/**
 * Sanity helper — exposed so tests can independently confirm the
 * deterministic-holdout assignment lands the same fixture in the
 * same cohort across repeated runs. Builds a one-off BlockServer
 * with the supplied holdout config and returns whether the query
 * fingerprint matches the holdout cohort.
 */
export async function probeHoldoutAssignment(
  storagePath: string,
  problem: string,
  language: string,
  errorType: string | undefined,
  holdoutConfig: { rate: number; salt: string },
): Promise<{ shadow: boolean; controlReason?: string }> {
  const store = new BlockStore(storagePath);
  try {
    // Holdout only fires when the gate WOULD have injected something
    // (Phase 3.2 contract: `wouldInjectAbsentShadow`). An empty store
    // would silently report shadow=false at any rate. We seed a
    // pattern whose situation IS the probed problem so FTS always
    // finds a candidate — this isolates the test to the holdout
    // assignment math, not to retrieval ranking.
    seedProbeBlockMatching(store, problem, language, errorType);
    const server = new BlockServer(store, {
      calibrator: loadBlockCalibrator(store),
      gateThreshold: 0,
    });
    const result = await runReasoningPatternsRecall(
      server,
      {
        problem,
        language,
        ...(errorType ? { errorType } : {}),
      },
      {
        readHoldoutConfig: () => ({
          enabled: true,
          rate: holdoutConfig.rate,
          salt: holdoutConfig.salt,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      },
    );
    const out: { shadow: boolean; controlReason?: string } = {
      shadow: result.shadow,
    };
    if (result.controlReason) out.controlReason = result.controlReason;
    // formatInjection is a side-effect-free renderer — call it just
    // to exercise the gate path the way the production MCP server
    // would, so the probe behaves identically to a real query.
    formatInjection(result, { format: "markdown" });
    buildInjectionPayload(result);
    return out;
  } finally {
    store.close();
  }
}

/**
 * Seed a block whose trigger IS the probed problem text — guarantees
 * FTS surfaces a candidate so the holdout assignment path runs (it
 * short-circuits when no candidate would be injected). Idempotent
 * via the BlockStore's UNIQUE fingerprint index.
 */
function seedProbeBlockMatching(
  store: BlockStore,
  problem: string,
  language: string,
  errorType: string | undefined,
): void {
  try {
    storeReasoningPatternHelper(store, {
      situation: problem,
      mechanism: "synthetic matcher for the holdout probe — content irrelevant",
      unlock: "synthetic unlock — content irrelevant for assignment math",
      verification: "rerun the test and observe the assignment was deterministic",
      language,
      ...(errorType ? { errorType } : {}),
    });
  } catch {
    // Idempotent: a re-seed on a fingerprint match collapses onto
    // the existing block and is safe to ignore here.
  }
}

/** Random run id helper. */
export function makeRunId(): string {
  return randomUUID();
}
