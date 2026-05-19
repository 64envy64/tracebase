/**
 * `tracebase distill` — manual LLM upgrade lane for blocks.
 *
 * Heuristic auto-capture (the `Stop`-hook in `capture-turn`) is the
 * default path: it costs nothing per turn, fires on every interaction
 * Claude Code completes, and gets a usable pattern most of the time.
 * The LLM pipeline in `src/distillation/*` runs the same trace through
 * a higher-quality Anthropic-backed distiller, producing trigger /
 * mechanism / unlock / verification fields that aren't bound by the
 * regex grammar in `capture-turn`'s extractor.
 *
 * This CLI is the manual bridge between the two. The user looks at a
 * heuristically-captured block they think is a good candidate for
 * upgrading, runs:
 *
 *   ANTHROPIC_API_KEY=... npx tracebase-ai distill --from-block <id>
 *
 * and either:
 *   • a new candidate block lands in the store with the LLM's
 *     re-extracted fields (when the LLM rephrases the situation
 *     enough that the trigger fingerprint shifts), OR
 *   • the existing block picks up a `supporting` case ref with
 *     LLM-derived validation and distillation provenance (when the
 *     fingerprint is identical — the dedupe path in
 *     DistillationPipeline).
 *
 * Either outcome is informative; the renderer surfaces which one
 * happened and why.
 *
 * Deliberately a manual one-shot, not a daemon. Auto-running LLM on
 * every captured block would burn API credits with no obvious win in
 * the common case. Once we have a queue (Phase X.X), this CLI grows
 * a `--pending` mode that drains it.
 */
import { Command } from "commander";
import pc from "picocolors";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { findProjectRoot, loadConfig } from "../../core/config.js";
import { BlockStore } from "../../core/block-store.js";
import { DistillationPipeline, type DistillationResult, type RejectionReason } from "../../distillation/pipeline.js";
import { AnthropicDistiller } from "../../distillation/llm-distiller.js";
import {
  distillDomain,
  type DistillDomainResult,
  type DomainKey,
} from "../../distillation/domain-distiller.js";
import { fingerprint } from "../../core/fingerprint.js";
import type { AnthropicMessagesLike } from "../../distillation/llm-distiller.js";
import type { ReasoningBlock, ReasoningTrace } from "../../types.js";

interface DistillOptions {
  fromBlock?: string;
  quality?: boolean;
  apiKey?: string;
  path: string;
  json?: boolean;
}

export const distillCommand = new Command("distill")
  .description(
    "Run the LLM distillation pipeline on an existing block — upgrade a heuristic capture to LLM-quality.",
  )
  .option("--from-block <id>", "block id to source the trace from")
  .option("--quality", "use the quality model (Sonnet 4.6) instead of the default Haiku 4.5")
  .option("--api-key <key>", "Anthropic API key (or set ANTHROPIC_API_KEY)")
  .option("-p, --path <path>", "project root", process.cwd())
  .option("--json", "machine-readable JSON output")
  .action(async (opts: DistillOptions) => {
    if (!opts.fromBlock) {
      fatal("--from-block <id> is required (use `tracebase stats` to list block ids)");
    }
    const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      fatal(
        "ANTHROPIC_API_KEY is not set. Either pass --api-key or export the env var.",
      );
    }
    const projectRoot = findProjectRoot(opts.path);
    if (!projectRoot) {
      fatal("Not initialized in this directory. Run `npx tracebase-ai init` first.");
    }

    // Load the Anthropic SDK as an optional peer. The library doesn't
    // hard-require it so consumers who never distill don't pay the
    // install cost. The dynamic-import string is intentionally a
    // template literal so TypeScript doesn't try to resolve the
    // module at typecheck time (it's an optional peer and isn't in
    // node_modules during CI lint).
    type AnthropicCtor = new (opts: { apiKey: string }) => AnthropicMessagesLike;
    let Anthropic: AnthropicCtor;
    try {
      const sdkSpec = "@anthropic-ai/sdk";
      const mod = (await import(/* webpackIgnore: true */ sdkSpec)) as {
        default: AnthropicCtor;
      };
      Anthropic = mod.default;
    } catch {
      fatal(
        "@anthropic-ai/sdk is not installed. Run `npm i @anthropic-ai/sdk` in this project.",
      );
    }

    const cfg = loadConfig(opts.path);
    const db = new Database(cfg.storagePath);
    const store = new BlockStore(db);
    let result: DistillationResult;
    let source: ReasoningBlock;
    try {
      const block = store.getBlock(opts.fromBlock!);
      if (!block) {
        fatal(`Block not found: ${opts.fromBlock}`);
      }
      source = block!;

      const trace = traceFromBlock(source);
      const client = new Anthropic!({ apiKey: apiKey! });
      const distiller = new AnthropicDistiller({
        client,
        useQualityModel: !!opts.quality,
      });
      const pipeline = new DistillationPipeline({ store, distiller });
      result = await pipeline.distillTrace(trace);
    } finally {
      store.close();
      db.close();
    }

    if (opts.json) {
      process.stdout.write(
        JSON.stringify({ sourceBlockId: source!.id, result }, null, 2) + "\n",
      );
      return;
    }
    renderResult(source!, result, !!opts.quality);
  });

// ---------------------------------------------------------------------------
// Domain self-distillation subcommand
// ---------------------------------------------------------------------------

interface DomainOptions {
  path: string;
  language?: string;
  framework?: string;
  errorType?: string;
  k?: string;
  budget?: string;
  min?: string;
  json?: boolean;
  skipQualityFloor?: boolean;
}

const domainSubcommand = new Command("domain")
  .description(
    "Compress the top-K patterns in a (language, framework) domain into one primer block. " +
      "Deterministic extractive mode by default; no API key needed.",
  )
  .option("-p, --path <path>", "project root", process.cwd())
  .option("--language <lang>", "language invariant (e.g. typescript, python)")
  .option("--framework <fw>", "framework invariant (e.g. react, django)")
  .option("--error-type <kind>", "error type invariant (rare; use when patterns cluster by error class)")
  .option("--k <n>", "how many top patterns to compress (default 7)")
  .option("--budget <n>", "primer token budget (default 600)")
  .option("--min <n>", "minimum source patterns required to distill (default 3)")
  .option(
    "--skip-quality-floor",
    "include patterns with no recorded outcomes (use for cold-start eval; not for production)",
  )
  .option("--json", "machine-readable JSON output")
  .action((opts: DomainOptions) => {
    const projectRoot = findProjectRoot(opts.path);
    if (!projectRoot) {
      fatal("Not initialized in this directory. Run `npx tracebase-ai init` first.");
    }
    if (!opts.language && !opts.framework && !opts.errorType) {
      fatal(
        "At least one of --language / --framework / --error-type is required. " +
          "Try `tracebase distill domain --language typescript --framework react`.",
      );
    }
    const domain: DomainKey = {
      ...(opts.language ? { language: opts.language } : {}),
      ...(opts.framework ? { framework: opts.framework } : {}),
      ...(opts.errorType ? { errorType: opts.errorType } : {}),
    };
    const k = parsePositiveInt(opts.k, 7, "--k");
    const tokenBudget = parsePositiveInt(opts.budget, 600, "--budget");
    const minPatterns = parsePositiveInt(opts.min, 3, "--min");

    const cfg = loadConfig(opts.path);
    const db = new Database(cfg.storagePath);
    const store = new BlockStore(db);
    let result: DistillDomainResult;
    try {
      result = distillDomain(store, domain, {
        k,
        tokenBudget,
        minPatterns,
        ...(opts.skipQualityFloor ? { skipQualityFloor: true } : {}),
      });
    } finally {
      store.close();
    }

    if (opts.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      return;
    }
    renderDomainResult(domain, result);
  });

distillCommand.addCommand(domainSubcommand);

function renderDomainResult(domain: DomainKey, result: DistillDomainResult): void {
  console.log();
  const label =
    [domain.language, domain.framework, domain.errorType].filter(Boolean).join(" · ") ||
    "(no domain key)";
  console.log(pc.bold("TraceBase distill domain") + pc.dim(`  · ${label}`));
  console.log();
  if (result.status === "skipped") {
    console.log(pc.yellow("  Skipped.") + " " + describeDomainSkip(result.reason, result.foundPatterns));
    console.log();
    return;
  }
  console.log(pc.green("  ✓ Stored") + " a domain primer.");
  console.log(pc.dim("    primer id:    ") + result.block.id.slice(0, 24) + "…");
  console.log(pc.dim("    sources:      ") + result.sourceIds.map((s) => s.slice(0, 8)).join(", "));
  console.log(pc.dim("    body tokens:  ") + estimatePrimerTokens(result.block).toString());
  console.log();
}

function describeDomainSkip(reason: string, found: number): string {
  switch (reason) {
    case "no-domain-key":
      return "no domain key was supplied — pass --language / --framework / --error-type.";
    case "too-few-patterns":
      return `only ${found} usable pattern(s) found in this domain — bring more outcomes through (or pass --skip-quality-floor to include unproven blocks).`;
    case "no-actionable-content":
      return `${found} patterns matched but produced an empty primer — their unlock / mechanism fields were blank or duplicates.`;
    default:
      return `reason: ${reason}`;
  }
}

function estimatePrimerTokens(block: ReasoningBlock): number {
  const text = [
    block.body.mechanism,
    block.body.unlock,
    block.body.verification,
    ...block.body.deadEnds,
  ].join(" ");
  return Math.ceil(text.length / 4);
}

function parsePositiveInt(raw: string | undefined, dflt: number, flag: string): number {
  if (raw === undefined) return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) {
    fatal(`${flag} must be a positive integer; got ${raw}`);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Trace synthesis — block → ReasoningTrace
// ---------------------------------------------------------------------------

/**
 * Build a `ReasoningTrace` from a stored block. The trace is purely a
 * pipeline input; we never persist it. Field mapping is the inverse of
 * how `capture-turn` extracts a block from a transcript:
 *
 *   problem.description     ← block.trigger.situation
 *   problem.fingerprint     ← computed via the shared `fingerprint()` helper
 *   solution.summary        ← block.body.unlock      (one-line "what fixed it")
 *   solution.steps          ← [analysis ← mechanism, action ← unlock, verify ← verification]
 *   solution.outcome        ← "success" (the heuristic gate would not have stored
 *                              the source block otherwise — pitfalls go through a
 *                              different path)
 *
 * The synthetic trace id is namespaced so a forensic look at events
 * can tell pipeline-replays from real first-pass captures.
 */
export function traceFromBlock(block: ReasoningBlock): ReasoningTrace {
  const description = block.trigger.situation;
  const inv = block.trigger.invariants;
  const fp = fingerprint(description, {
    ...(inv.language ? { language: inv.language } : {}),
    ...(inv.framework ? { framework: inv.framework } : {}),
    ...(inv.errorType ? { errorType: inv.errorType } : {}),
  });
  return {
    id: `distill-from-${block.id.slice(0, 8)}-${randomUUID().slice(0, 8)}`,
    createdAt: block.createdAt,
    updatedAt: block.updatedAt,
    problem: {
      description,
      ...(inv.errorType ? { errorType: inv.errorType } : {}),
      ...(inv.language ? { language: inv.language } : {}),
      ...(inv.framework ? { framework: inv.framework } : {}),
      tags: [],
      fingerprint: fp.hash,
    },
    solution: {
      summary: block.body.unlock,
      steps: [
        { type: "analysis", description: block.body.mechanism },
        { type: "action", description: block.body.unlock },
        { type: "verification", description: block.body.verification },
      ],
      outcome: "success",
      ...(block.body.mechanism ? { explanation: block.body.mechanism } : {}),
    },
    metadata: {
      agent: "tracebase-distill-cli",
      source: "block-upgrade",
    },
    quality: {
      recallCount: 0,
      helpfulCount: 0,
      score: 0.5,
    },
    provenance: {
      origin: "local",
      author: "distill",
      appliedCount: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

function renderResult(
  source: ReasoningBlock,
  result: DistillationResult,
  quality: boolean,
): void {
  const modelLabel = quality ? "Sonnet 4.6 (quality)" : "Haiku 4.5 (default)";
  console.log();
  console.log(
    pc.bold("TraceBase distill") + pc.dim(`  · source #${source.id.slice(0, 8)} · ${modelLabel}`),
  );
  console.log();

  switch (result.status) {
    case "stored": {
      console.log(pc.green("  ✓ Stored") + " a new LLM-quality candidate block.");
      console.log(
        pc.dim("    new id:        ") + result.block.id.slice(0, 24) + "…",
      );
      console.log(
        pc.dim("    new situation: ") + truncate(result.block.trigger.situation, 80),
      );
      console.log(
        pc.dim("    unlock:        ") + truncate(result.block.body.unlock, 80),
      );
      console.log(
        pc.dim("    confidence:    ") +
          (result.block.provenance.distillationConfidence?.toFixed(2) ?? "—"),
      );
      if (result.verification) {
        console.log(pc.dim("    verification:  ") + result.verification.status);
      }
      break;
    }
    case "merged": {
      console.log(
        pc.cyan("  ~ Merged") +
          " into the existing block — fingerprint matched. " +
          pc.dim("Supporting case ref attached."),
      );
      console.log(pc.dim("    existing id: ") + result.existingBlockId.slice(0, 24) + "…");
      console.log(pc.dim("    case ref:    ") + result.caseRefId);
      break;
    }
    case "rejected": {
      console.log(pc.red("  ✗ Rejected.") + " " + describeRejection(result.reason));
      break;
    }
  }
  console.log();
}

export function describeRejection(reason: RejectionReason): string {
  switch (reason.kind) {
    case "unsupported-outcome":
      return `source outcome was "${reason.outcome}" — pipeline only distills supported outcomes.`;
    case "no-unlock-step":
      return "no pivotal unlock step could be heuristically located.";
    case "no-failure-step":
      return "no pivotal failure step could be heuristically located.";
    case "llm-error":
      return `LLM error (${reason.distillerKind}): ${reason.message}`;
    case "low-confidence":
      return `model self-reported confidence ${reason.confidence.toFixed(2)} < threshold ${reason.threshold.toFixed(2)}.`;
    case "validation-failed":
      return `validation failed: ${reason.failures.join(", ")}`;
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function fatal(msg: string): never {
  console.error(pc.red("Error: ") + msg);
  process.exit(1);
}
