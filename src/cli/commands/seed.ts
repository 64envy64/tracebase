import { Command } from "commander";
import pc from "picocolors";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ReasoningLayer } from "../../core/engine.js";
import { loadConfig, findConfigDir } from "../../core/config.js";
import { fromJsonl } from "../../kb/jsonl.js";
import type { ReasoningTrace } from "../../types.js";

/**
 * Seed command — Global Knowledge Base.
 *
 * Install curated trace packs from npm to bootstrap your knowledge base.
 * Traces are stored locally with provenance.origin = "seed".
 *
 * Usage:
 *   tracebase seed install @tracebase/seed-react
 *   tracebase seed list
 *   tracebase seed remove @tracebase/seed-react
 */

const SEEDS_MANIFEST = "seeds.json";

interface SeedManifest {
  installed: Array<{
    name: string;
    version: string;
    traceCount: number;
    installedAt: number;
  }>;
}

function loadSeedManifest(configDir: string): SeedManifest {
  const path = join(configDir, SEEDS_MANIFEST);
  if (!existsSync(path)) return { installed: [] };
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as SeedManifest;
  } catch {
    return { installed: [] };
  }
}

function saveSeedManifest(configDir: string, manifest: SeedManifest): void {
  writeFileSync(join(configDir, SEEDS_MANIFEST), JSON.stringify(manifest, null, 2) + "\n");
}

export const seedCommand = new Command("seed")
  .description("Manage knowledge packs (Global KB)")
  .addCommand(
    new Command("install")
      .description("Install a seed pack from npm")
      .argument("<package>", "npm package name (e.g. @tracebase/seed-react)")
      .option("--file <path>", "Install from local JSONL file instead of npm")
      .action(async (packageName: string, opts) => {
        const config = loadConfig();
        const configDir = findConfigDir() ?? join(process.cwd(), ".tracebase");
        const layer = new ReasoningLayer(config);

        try {
          let traces: ReasoningTrace[];
          let version = "local";

          if (opts.file) {
            // Local file mode
            const content = readFileSync(opts.file, "utf-8");
            traces = fromJsonl(content);
            console.log(pc.dim(`Reading from ${opts.file}...`));
          } else {
            // npm mode: download package, extract traces.jsonl
            console.log(pc.dim(`Fetching ${packageName} from npm...`));
            const tmpDir = join(tmpdir(), `tracebase-seed-${randomUUID()}`);
            mkdirSync(tmpDir, { recursive: true });

            try {
              execSync(`npm pack ${packageName} --pack-destination ${tmpDir}`, {
                stdio: "pipe",
                cwd: tmpDir,
              });

              // Find the tarball
              const files = execSync(`ls ${tmpDir}/*.tgz`, { encoding: "utf-8" }).trim().split("\n");
              if (files.length === 0) throw new Error("No tarball found");

              // Extract traces.jsonl from tarball
              execSync(`tar xzf ${files[0]} -C ${tmpDir}`, { stdio: "pipe" });

              const jsonlPath = join(tmpDir, "package", "traces.jsonl");
              if (!existsSync(jsonlPath)) {
                throw new Error(`No traces.jsonl found in ${packageName}. Is this a TraceBase seed pack?`);
              }

              const content = readFileSync(jsonlPath, "utf-8");
              traces = fromJsonl(content);

              // Try to read version from package.json
              try {
                const pkg = JSON.parse(readFileSync(join(tmpDir, "package", "package.json"), "utf-8"));
                version = pkg.version ?? "unknown";
              } catch { /* ok */ }

              // Cleanup
              execSync(`rm -rf ${tmpDir}`, { stdio: "pipe" });
            } catch (err) {
              execSync(`rm -rf ${tmpDir}`, { stdio: "pipe" }).toString();
              throw err;
            }
          }

          if (traces.length === 0) {
            console.log(pc.yellow("No valid traces found in package."));
            return;
          }

          // Set provenance to "seed"
          for (const trace of traces) {
            if (!trace.provenance) {
              trace.provenance = { origin: "seed", appliedCount: 0 };
            }
            trace.provenance.origin = "seed";
            trace.provenance.author = trace.provenance.author ?? packageName;
          }

          const count = layer.importTraces(traces);

          // Record in manifest
          const manifest = loadSeedManifest(configDir);
          const existing = manifest.installed.findIndex((s) => s.name === packageName);
          if (existing >= 0) manifest.installed.splice(existing, 1);
          manifest.installed.push({
            name: packageName,
            version,
            traceCount: count,
            installedAt: Date.now(),
          });
          saveSeedManifest(configDir, manifest);

          console.log(pc.green(`Installed ${count} traces`) + pc.dim(` from ${packageName} (${traces.length} total, ${traces.length - count} duplicates skipped)`));
        } finally {
          layer.close();
        }
      }),
  )
  .addCommand(
    new Command("list")
      .description("List installed seed packs")
      .action(() => {
        const configDir = findConfigDir();
        if (!configDir) {
          console.log(pc.yellow("TraceBase not initialized. Run: npx tracebase-ai init"));
          return;
        }

        const manifest = loadSeedManifest(configDir);
        if (manifest.installed.length === 0) {
          console.log(pc.dim("No seed packs installed."));
          console.log(pc.dim("  Install one: npx tracebase-ai seed install @tracebase/seed-react"));
          return;
        }

        console.log(pc.bold(`${manifest.installed.length} seed pack(s) installed:\n`));
        for (const s of manifest.installed) {
          const date = new Date(s.installedAt).toLocaleDateString();
          console.log(`  ${pc.cyan(s.name)} ${pc.dim(`v${s.version}`)} — ${s.traceCount} traces ${pc.dim(`(${date})`)}`);
        }
      }),
  )
  .addCommand(
    new Command("remove")
      .description("Remove a seed pack (deletes its traces)")
      .argument("<package>", "seed pack name to remove")
      .action((packageName: string) => {
        const config = loadConfig();
        const configDir = findConfigDir();
        if (!configDir) {
          console.log(pc.yellow("TraceBase not initialized."));
          return;
        }

        const layer = new ReasoningLayer(config);
        try {
          // Delete traces with this seed origin
          const all = layer.exportAll();
          let removed = 0;
          for (const trace of all) {
            if (trace.provenance?.origin === "seed" && trace.provenance?.author === packageName) {
              layer.deleteTrace(trace.id);
              removed++;
            }
          }

          // Update manifest
          const manifest = loadSeedManifest(configDir);
          manifest.installed = manifest.installed.filter((s) => s.name !== packageName);
          saveSeedManifest(configDir, manifest);

          console.log(pc.green(`Removed ${removed} traces`) + pc.dim(` from ${packageName}`));
        } finally {
          layer.close();
        }
      }),
  );
