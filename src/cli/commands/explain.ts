import { Command } from "commander";
import pc from "picocolors";
import { ReasoningLayer } from "../../core/engine.js";
import { loadConfig } from "../../core/config.js";
import { loadWeightState, computeWeights } from "../../core/weights.js";

/**
 * Signal explainability command.
 * Shows full signal breakdown for a recall query — why each result was ranked
 * the way it was. No competitor offers this level of transparency.
 *
 * Usage:
 *   tracebase explain "ECONNREFUSED error"
 *   tracebase explain "CORS in Express" --limit 3
 */
export const explainCommand = new Command("explain")
  .description("Explain how recall ranks results — full signal breakdown")
  .argument("<problem>", "problem description to explain ranking for")
  .option("-n, --limit <n>", "max results to explain", "3")
  .option("-l, --language <lang>", "filter by language")
  .option("-f, --framework <fw>", "filter by framework")
  .option("--json", "output as JSON")
  .action((problem: string, opts) => {
    const config = loadConfig();
    const layer = new ReasoningLayer(config);

    try {
      const results = layer.recall({
        problem,
        limit: parseInt(opts.limit, 10),
        minScore: 0.01, // low threshold to show more results for explanation
        context: {
          language: opts.language,
          framework: opts.framework,
        },
      });

      // Load current weights for display
      const weightState = loadWeightState(layer.rawStore.rawDb);
      const weights = computeWeights(weightState);

      if (opts.json) {
        console.log(JSON.stringify({
          query: problem,
          weights,
          weightState: {
            feedbackCount: weightState.feedbackCount,
            updatedAt: weightState.updatedAt,
          },
          results: results.map((r) => ({
            traceId: r.trace.id,
            score: r.score,
            matchType: r.matchType,
            signals: r.signals,
            contributions: {
              bm25: r.signals.bm25 * weights.bm25,
              jaccard: r.signals.jaccard * weights.jaccard,
              structural: r.signals.structural * weights.structural,
              cosine: r.signals.cosine * weights.cosine,
              freshness: r.signals.freshness * weights.freshness,
            },
            problem: r.trace.problem.description.slice(0, 200),
            solution: r.trace.solution.summary.slice(0, 200),
          })),
        }, null, 2));
        return;
      }

      if (results.length === 0) {
        console.log(pc.yellow("No matching traces found."));
        return;
      }

      // Display current adaptive weights
      console.log(pc.bold("Current Adaptive Weights") + pc.dim(` (${weightState.feedbackCount} feedback events)`));
      console.log(
        `  BM25:       ${bar(weights.bm25)} ${pc.bold(weights.bm25.toFixed(3))}\n` +
        `  Jaccard:    ${bar(weights.jaccard)} ${pc.bold(weights.jaccard.toFixed(3))}\n` +
        `  Structural: ${bar(weights.structural)} ${pc.bold(weights.structural.toFixed(3))}\n` +
        `  Cosine:     ${bar(weights.cosine)} ${pc.bold(weights.cosine.toFixed(3))}\n` +
        `  Freshness:  ${bar(weights.freshness)} ${pc.bold(weights.freshness.toFixed(3))}`,
      );
      console.log();

      for (const [i, result] of results.entries()) {
        const { trace, score, matchType, signals } = result;

        const matchColor =
          matchType === "exact" ? pc.green :
          matchType === "similar" ? pc.cyan :
          pc.yellow;

        console.log(pc.bold(`--- Result ${i + 1} ---`));
        console.log(`  ${pc.bold("Score:")} ${matchColor(score.toFixed(4))} (${matchType})`);
        console.log(`  ${pc.bold("Problem:")} ${pc.dim(trace.problem.description.slice(0, 100))}`);
        console.log(`  ${pc.bold("Solution:")} ${trace.solution.summary.slice(0, 100)}`);
        console.log();

        // Signal breakdown
        console.log(pc.bold("  Signal Breakdown:"));
        const contributions = [
          { name: "BM25", signal: signals.bm25, weight: weights.bm25 },
          { name: "Jaccard", signal: signals.jaccard, weight: weights.jaccard },
          { name: "Structural", signal: signals.structural, weight: weights.structural },
          { name: "Cosine", signal: signals.cosine, weight: weights.cosine },
          { name: "Freshness", signal: signals.freshness, weight: weights.freshness },
        ];

        if (signals.fingerprint === 1.0) {
          console.log(`  ${pc.green("  Fingerprint: 1.000")} (exact match — bypasses weighted scoring)`);
        }

        for (const { name, signal, weight } of contributions) {
          const contrib = signal * weight;
          const signalStr = signal.toFixed(3).padStart(5);
          const weightStr = weight.toFixed(3);
          const contribStr = contrib.toFixed(3);
          const barStr = bar(signal);
          console.log(
            `    ${name.padEnd(12)} ${barStr} ${signalStr} × ${weightStr} = ${pc.bold(contribStr)}`,
          );
        }

        // Quality adjustment (reads from config if available)
        const [qMin, qMax] = config.similarity?.qualityMultiplierRange ?? [0.85, 1.15];
        const qMult = qMin + trace.quality.score * (qMax - qMin);
        console.log(
          `\n    ${pc.dim(`Quality multiplier: ×${qMult.toFixed(2)} (score: ${trace.quality.score.toFixed(2)}, ${trace.quality.helpfulCount}/${trace.quality.recallCount} helpful)`)}`,
        );

        // Provenance
        if (trace.provenance) {
          const prov = trace.provenance;
          const provParts = [
            `origin: ${prov.origin}`,
            prov.author ? `author: ${prov.author}` : null,
            prov.appliedCount > 0 ? `applied: ${prov.appliedCount}x` : null,
          ].filter(Boolean);
          console.log(`    ${pc.dim(`Provenance: ${provParts.join(", ")}`)}`);
        }

        console.log(`    ${pc.dim(`id: ${trace.id}`)}`);
        console.log();
      }
    } finally {
      layer.close();
    }
  });

/** Render a simple bar chart for a 0-1 value. */
function bar(value: number, width = 20): string {
  const filled = Math.round(value * width);
  const empty = width - filled;
  return pc.dim("[") + pc.cyan("█".repeat(filled)) + pc.dim("░".repeat(empty)) + pc.dim("]");
}
