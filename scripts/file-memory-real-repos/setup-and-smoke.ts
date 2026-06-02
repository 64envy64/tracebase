#!/usr/bin/env tsx
/**
 * Box 4c Phase 2A: install + base-test smoke per VERIFIED repo.
 *
 *   - For Node repos: install via npm (yarn via `corepack` if needed).
 *   - For Python repos: create per-repo venv outside the repo dir;
 *     `pip install -e <repo>[extras]`; run pytest via venv python.
 *   - Test on each repo's current HEAD only (no PR work). Confirms
 *     install + base test command work cleanly before per-PR loop.
 *
 * Writes a setup-result.json per repo. Outputs total smoke summary.
 *
 * No agent, no API, single-machine local only. Time budget: ~10-20 min total.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..", "..");
const BASE = join(ROOT, "bench-runs", "file-memory-real-repos");
const REPOS_DIR = join(BASE, "repos");
const VENVS_DIR = join(BASE, "venvs");
const RESULTS_DIR = join(BASE, "results");

interface RepoSpec {
  name: string;
  dir: string; // under repos/
  kind: "node" | "python";
  installCmd: string[];    // run from repo dir
  testCmd: string[];       // run from repo dir; for python, replace with venv python
  pythonVenvName?: string; // path under venvs/
  pythonInstallSpec?: string; // pip install -e <this> arg, e.g. ".[d]" or "."
  pythonExtraDeps?: string[]; // extra `pip install` step after main editable install
  installTimeoutMs: number;
  testTimeoutMs: number;
  preInstallCmd?: string[]; // run before installCmd (e.g. corepack enable for prettier)
  installCwd?: "repo" | "root";
}

const REPOS: RepoSpec[] = [
  {
    name: "axios/axios",
    dir: "axios-axios",
    kind: "node",
    // vitest 4 uses rolldown which has platform-specific native bindings as
    // optional deps. `npm ci` without --include=optional skips them. Force
    // a full install that includes optional platform-binding packages.
    installCmd: ["npm", "install", "--include=optional", "--no-audit", "--no-fund", "--force"],
    testCmd: ["npm", "run", "test:vitest"],
    installTimeoutMs: 5 * 60_000,
    testTimeoutMs: 5 * 60_000,
  },
  {
    name: "josdejong/mathjs",
    dir: "josdejong-mathjs",
    kind: "node",
    installCmd: ["npm", "install", "--no-audit", "--no-fund", "--prefer-offline"],
    testCmd: ["npm", "run", "test:src"],
    installTimeoutMs: 5 * 60_000,
    testTimeoutMs: 5 * 60_000,
  },
  {
    name: "psf/black",
    dir: "psf-black",
    kind: "python",
    installCmd: [],
    testCmd: ["python", "-m", "pytest", "-q", "--no-header", "-x", "--maxfail=3"],
    pythonVenvName: "black",
    // `[d]` is daemon (aiohttp), NOT dev tools. Install pytest separately.
    pythonInstallSpec: ".[d]",
    pythonExtraDeps: ["pytest>=8", "pytest-mock", "pytest-cov", "click>=8.2"],
    installTimeoutMs: 4 * 60_000,
    testTimeoutMs: 5 * 60_000,
  },
  {
    name: "Textualize/rich",
    dir: "Textualize-rich",
    kind: "python",
    installCmd: [],
    testCmd: ["python", "-m", "pytest", "-q", "--no-header", "-x", "--maxfail=3"],
    pythonVenvName: "rich",
    // rich uses `[tool.poetry.dev-dependencies]` which pip ignores.
    // Install pytest separately.
    pythonInstallSpec: ".",
    pythonExtraDeps: ["pytest>=7", "pytest-cov", "attrs", "attr", "hypothesis", "pytest-mock"],
    installTimeoutMs: 4 * 60_000,
    testTimeoutMs: 5 * 60_000,
  },
  {
    name: "prettier/prettier",
    dir: "prettier-prettier",
    kind: "node",
    // packageManager = yarn@4.15.0; engines.node >= 22 (we have 20.17).
    // Try corepack to materialise yarn 4; install may still fail on Node 20
    // engines check. If it does, prettier will be flagged at smoke time.
    // Try installing yarn 4 globally via npm to match prettier's packageManager.
    // If this fails on Node 20 (engines >= 22 may block at install time), the
    // smoke will fail with a clear error and prettier should be flagged.
    preInstallCmd: ["npm", "install", "-g", "yarn@4.15.0"],
    installCmd: ["yarn", "install"],
    testCmd: ["yarn", "test"],
    installTimeoutMs: 10 * 60_000,
    testTimeoutMs: 5 * 60_000,
  },
  {
    name: "pytest-dev/pytest",
    dir: "pytest-dev-pytest",
    kind: "python",
    installCmd: [],
    // pytest's pyproject sets `minversion = "2.0"` and the editable dev install
    // ends up with version "0.1.dev..." which fails the check. Override.
    testCmd: ["python", "-m", "pytest", "-q", "--override-ini=minversion=0.0", "--no-header", "-x", "--maxfail=3"],
    pythonVenvName: "pytest",
    pythonInstallSpec: ".[testing]",
    pythonExtraDeps: ["attrs", "attr", "hypothesis", "pytest-mock", "pytest-xdist", "pygments"],
    installTimeoutMs: 4 * 60_000,
    testTimeoutMs: 5 * 60_000,
  },
];

interface RunResult {
  exitCode: number | null;
  stdoutTail: string;
  stderrTail: string;
  elapsedSec: number;
  timedOut: boolean;
}

function runWithTimeout(cmd: string, args: string[], cwd: string, timeoutMs: number): RunResult {
  const t0 = Date.now();
  const child = spawnSync(cmd, args, {
    cwd,
    encoding: "utf-8",
    shell: process.platform === "win32",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  const elapsedSec = Number(((Date.now() - t0) / 1000).toFixed(1));
  return {
    exitCode: child.status,
    stdoutTail: (child.stdout ?? "").split("\n").slice(-60).join("\n"),
    stderrTail: (child.stderr ?? "").split("\n").slice(-60).join("\n"),
    elapsedSec,
    timedOut: child.signal === "SIGTERM" || (child.status === null && elapsedSec >= timeoutMs / 1000 - 1),
  };
}

interface RepoSetupResult {
  repo: string;
  dir: string;
  kind: "node" | "python";
  venvPath?: string;
  install: RunResult & { commandTried: string };
  baseTest: RunResult & { commandTried: string };
  ok: boolean;
  notes: string[];
}

function setupRepo(spec: RepoSpec): RepoSetupResult {
  const repoPath = join(REPOS_DIR, spec.dir);
  const notes: string[] = [];
  let venvPath: string | undefined;

  console.log(`\n==== ${spec.name} ====`);

  let installCmd: string;
  let installArgs: string[];
  let testCmd: string;
  let testArgs: string[];

  if (spec.kind === "python") {
    venvPath = join(VENVS_DIR, spec.pythonVenvName!);
    mkdirSync(VENVS_DIR, { recursive: true });
    if (!existsSync(venvPath)) {
      console.log(`  creating venv at ${venvPath}`);
      const venvCreate = runWithTimeout("python", ["-m", "venv", venvPath], REPOS_DIR, 2 * 60_000);
      if (venvCreate.exitCode !== 0) {
        return {
          repo: spec.name,
          dir: spec.dir,
          kind: spec.kind,
          venvPath,
          install: { ...venvCreate, commandTried: `python -m venv ${venvPath}` },
          baseTest: { exitCode: null, stdoutTail: "", stderrTail: "(skipped — venv creation failed)", elapsedSec: 0, timedOut: false, commandTried: "" },
          ok: false,
          notes: [`venv creation failed: ${venvCreate.stderrTail.slice(0, 200)}`],
        };
      }
    } else {
      notes.push("venv already existed; reusing");
    }
    const venvPython = process.platform === "win32" ? join(venvPath, "Scripts", "python.exe") : join(venvPath, "bin", "python");
    const venvPip = process.platform === "win32" ? join(venvPath, "Scripts", "pip.exe") : join(venvPath, "bin", "pip");
    installCmd = venvPip;
    installArgs = ["install", "-e", `${repoPath}${spec.pythonInstallSpec === "." ? "" : spec.pythonInstallSpec!.replace(".", "")}`];
    // For "." → just install the repo. For ".[d]" → install with extras.
    if (spec.pythonInstallSpec === ".") {
      installArgs = ["install", "-e", repoPath];
    } else if (spec.pythonInstallSpec) {
      installArgs = ["install", "-e", `${repoPath}${spec.pythonInstallSpec.slice(1)}`];
    }
    testCmd = venvPython;
    testArgs = spec.testCmd.slice(1); // strip 'python' from front; we use venvPython
  } else {
    installCmd = spec.installCmd[0]!;
    installArgs = spec.installCmd.slice(1);
    testCmd = spec.testCmd[0]!;
    testArgs = spec.testCmd.slice(1);
  }

  // Pre-install (e.g. corepack enable yarn for prettier)
  if (spec.preInstallCmd && spec.preInstallCmd.length > 0) {
    console.log(`  pre-install: ${spec.preInstallCmd.join(" ")}`);
    const pre = runWithTimeout(spec.preInstallCmd[0]!, spec.preInstallCmd.slice(1), repoPath, 60_000);
    console.log(`    pre-install exit=${pre.exitCode}`);
    if (pre.exitCode !== 0) {
      notes.push(`pre-install failed: ${pre.stderrTail.split("\n").slice(-3).join(" | ").slice(0, 200)}`);
    }
  }

  // Install
  console.log(`  install: ${installCmd} ${installArgs.join(" ")}`);
  const install = runWithTimeout(installCmd, installArgs, repoPath, spec.installTimeoutMs);
  console.log(`  install exit=${install.exitCode} elapsed=${install.elapsedSec}s timedOut=${install.timedOut}`);
  if (install.exitCode !== 0) {
    console.log(`  install stderr tail:\n${install.stderrTail.split("\n").slice(-8).map(l => "    "+l).join("\n")}`);
  }

  if (install.exitCode !== 0) {
    return {
      repo: spec.name, dir: spec.dir, kind: spec.kind, venvPath,
      install: { ...install, commandTried: `${installCmd} ${installArgs.join(" ")}` },
      baseTest: { exitCode: null, stdoutTail: "", stderrTail: "(skipped — install failed)", elapsedSec: 0, timedOut: false, commandTried: "" },
      ok: false,
      notes: [...notes, "install_failed"],
    };
  }

  // Extra Python deps (e.g. pytest itself for black + rich)
  if (spec.kind === "python" && spec.pythonExtraDeps && spec.pythonExtraDeps.length > 0) {
    const venvPip = process.platform === "win32"
      ? join(venvPath!, "Scripts", "pip.exe")
      : join(venvPath!, "bin", "pip");
    console.log(`  extra deps: ${venvPip} install ${spec.pythonExtraDeps.join(" ")}`);
    const extra = runWithTimeout(venvPip, ["install", ...spec.pythonExtraDeps], repoPath, 2 * 60_000);
    console.log(`    extra-deps exit=${extra.exitCode} elapsed=${extra.elapsedSec}s`);
    if (extra.exitCode !== 0) {
      notes.push(`extra-deps install failed: ${extra.stderrTail.split("\n").slice(-3).join(" | ").slice(0, 200)}`);
    }
  }

  // Base test
  console.log(`  test:    ${testCmd} ${testArgs.join(" ")}`);
  const baseTest = runWithTimeout(testCmd, testArgs, repoPath, spec.testTimeoutMs);
  console.log(`  test exit=${baseTest.exitCode} elapsed=${baseTest.elapsedSec}s timedOut=${baseTest.timedOut}`);
  if (baseTest.exitCode !== 0) {
    console.log(`  test stderr tail:\n${baseTest.stderrTail.split("\n").slice(-8).map(l => "    "+l).join("\n")}`);
  }

  return {
    repo: spec.name, dir: spec.dir, kind: spec.kind, venvPath,
    install: { ...install, commandTried: `${installCmd} ${installArgs.join(" ")}` },
    baseTest: { ...baseTest, commandTried: `${testCmd} ${testArgs.join(" ")}` },
    ok: install.exitCode === 0 && baseTest.exitCode === 0,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log(`Box 4c Phase 2A: install + base-test smoke for ${REPOS.length} VERIFIED repos`);

const results: RepoSetupResult[] = [];
for (const spec of REPOS) {
  try {
    results.push(setupRepo(spec));
  } catch (err: any) {
    console.error(`UNEXPECTED error for ${spec.name}: ${err?.message ?? err}`);
    results.push({
      repo: spec.name, dir: spec.dir, kind: spec.kind,
      install: { exitCode: null, stdoutTail: "", stderrTail: `JS error: ${err?.message ?? err}`, elapsedSec: 0, timedOut: false, commandTried: "" },
      baseTest: { exitCode: null, stdoutTail: "", stderrTail: "(skipped)", elapsedSec: 0, timedOut: false, commandTried: "" },
      ok: false, notes: ["unexpected_js_error"],
    });
  }
}

mkdirSync(RESULTS_DIR, { recursive: true });
writeFileSync(join(RESULTS_DIR, "phase-2a-setup-smoke.json"), JSON.stringify({
  version: "tracebase 0.9.x",
  pre_registration: "bench-runs/file-memory/PRE-REGISTRATION-REAL-REPOS.md",
  phase: "4c.2A — install + base-test smoke per repo",
  ran_at: new Date().toISOString().slice(0, 16),
  results,
  total_ok: results.filter(r => r.ok).length,
  total_failed: results.filter(r => !r.ok).length,
}, null, 2) + "\n");

console.log("\n=== SUMMARY ===");
console.log(`  OK:     ${results.filter(r => r.ok).length} / ${results.length}`);
console.log(`  FAILED: ${results.filter(r => !r.ok).length}`);
for (const r of results) {
  const status = r.ok ? "OK" : "FAIL";
  console.log(`  [${status}] ${r.repo.padEnd(24)} install=${r.install.elapsedSec}s (exit ${r.install.exitCode}); test=${r.baseTest.elapsedSec}s (exit ${r.baseTest.exitCode})`);
}
console.log(`\nWrote ${join(RESULTS_DIR, "phase-2a-setup-smoke.json")}`);
