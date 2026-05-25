import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "..");
const cliPath = join(root, "dist", "cli.js");
const buildConfigPath = join(root, "tsup.config.ts");
const workerPath = join(root, "dist", "minilm-worker.js");

function hasFreshBuild(): boolean {
  if (!existsSync(cliPath)) return false;
  return statSync(cliPath).mtimeMs >= statSync(buildConfigPath).mtimeMs;
}

describe.skipIf(!hasFreshBuild())("package artifact - MiniLM worker", () => {
  it("builds and packs the worker beside the public entrypoints", () => {
    expect(existsSync(workerPath)).toBe(true);

    const npmBin = process.platform === "win32" ? "npm" : "npm";
    const out = execFileSync(npmBin, ["pack", "--dry-run", "--json"], {
      cwd: root,
      encoding: "utf-8",
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const pack = JSON.parse(out) as Array<{ files?: Array<{ path: string }> }>;
    const files = pack[0]?.files?.map((f) => f.path) ?? [];
    expect(files).toContain("dist/minilm-worker.js");
  });
});
