import { Command } from "commander";
import pc from "picocolors";
import { ReasoningLayer } from "../../core/engine.js";
import { loadConfig } from "../../core/config.js";

export const storeCommand = new Command("store")
  .description("Store a reasoning trace")
  .requiredOption("-d, --description <text>", "problem description")
  .requiredOption("-s, --summary <text>", "solution summary")
  .option("-o, --outcome <outcome>", "success|failure|partial", "success")
  .option("-l, --language <lang>", "programming language")
  .option("-f, --framework <fw>", "framework (react, express, etc.)")
  .option("-e, --error-type <type>", "error type (TypeError, ENOENT, etc.)")
  .option("--file <path>", "related file path")
  .option("--explanation <text>", "detailed explanation")
  .option("--agent <name>", "agent that solved this", "human")
  .option("--model <model>", "LLM model used")
  .option("-t, --tags <tags>", "comma-separated tags")
  .option("--json", "output as JSON")
  .option("--stdin", "read JSON trace from stdin")
  .action(async (opts) => {
    const config = loadConfig();
    const layer = new ReasoningLayer(config);

    try {
      if (opts.stdin) {
        // Read from stdin
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) {
          chunks.push(chunk as Buffer);
        }
        const input = JSON.parse(Buffer.concat(chunks).toString());
        const trace = layer.storeTrace(input);
        if (opts.json) {
          console.log(JSON.stringify(trace, null, 2));
        } else {
          console.log(pc.green("✓") + ` Stored trace ${pc.dim(trace.id)}`);
        }
        return;
      }

      const tags = opts.tags ? opts.tags.split(",").map((t: string) => t.trim()) : [];

      const trace = layer.storeTrace({
        problem: {
          description: opts.description,
          errorType: opts.errorType,
          filePath: opts.file,
          language: opts.language,
          framework: opts.framework,
          tags,
        },
        solution: {
          summary: opts.summary,
          steps: [],
          outcome: opts.outcome as "success" | "failure" | "partial",
          explanation: opts.explanation,
        },
        metadata: {
          agent: opts.agent,
          model: opts.model,
          source: "cli",
        },
      });

      if (opts.json) {
        console.log(JSON.stringify(trace, null, 2));
      } else {
        console.log(pc.green("✓") + " Trace stored");
        console.log(pc.dim("  ID: ") + trace.id);
        console.log(
          pc.dim("  Fingerprint: ") + trace.problem.fingerprint.slice(0, 12) + "...",
        );
      }
    } finally {
      layer.close();
    }
  });
