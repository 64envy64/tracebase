import { mkdtempSync, cpSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

/**
 * Sandbox — isolated workspace for each fixture run.
 *
 * Creates a temp directory, copies fixture files into it,
 * symlinks node_modules for test runner access, and provides
 * safe file operations (path traversal prevention).
 */
export class Sandbox {
  readonly dir: string;
  readonly fixtureId: string;

  constructor(fixtureDir: string, fixtureId: string) {
    this.fixtureId = fixtureId;
    this.dir = mkdtempSync(join(tmpdir(), `tb-eval-${fixtureId}-`));

    // Copy fixture files into sandbox (resolve relative paths from cwd)
    const absFixtureDir = isAbsolute(fixtureDir) ? fixtureDir : resolve(process.cwd(), fixtureDir);
    cpSync(absFixtureDir, this.dir, { recursive: true });

    // Symlink node_modules from project root for vitest access
    const projectRoot = resolve(import.meta.dirname ?? process.cwd(), "..", "..");
    const nodeModules = join(projectRoot, "node_modules");
    const sandboxModules = join(this.dir, "node_modules");
    if (existsSync(nodeModules) && !existsSync(sandboxModules)) {
      try {
        symlinkSync(nodeModules, sandboxModules, "junction");
      } catch {
        // Symlink may fail on some systems
      }
    }

    // No vitest config needed — we run vitest from project root with --root flag
  }

  /** Read a file from the sandbox. Prevents path traversal. */
  readFile(relativePath: string): string {
    const absPath = this.resolve(relativePath);
    if (!existsSync(absPath)) return `Error: File not found: ${relativePath}`;
    try {
      const stat = require("node:fs").statSync(absPath);
      if (stat.isDirectory()) {
        const entries = require("node:fs").readdirSync(absPath) as string[];
        return `Directory listing of ${relativePath}:\n${entries.join("\n")}`;
      }
      return readFileSync(absPath, "utf-8");
    } catch {
      return `Error reading: ${relativePath}`;
    }
  }

  /** Write a file in the sandbox. Prevents path traversal. */
  editFile(relativePath: string, content: string): string {
    const absPath = this.resolve(relativePath);
    writeFileSync(absPath, content, "utf-8");
    return `File written: ${relativePath}`;
  }

  /** Run tests in the sandbox. Returns test output. */
  runTests(language: "typescript" | "python"): { passed: boolean; output: string } {
    try {
      let cmd: string;
      if (language === "typescript") {
        const testFile = this.findTestFile(["source.test.ts", "test.ts", "spec.ts"]);
        // Run vitest with explicit path to project's node_modules/.bin/vitest
        const projectRoot = this.findProjectRoot();
        const vitestBin = join(projectRoot, "node_modules", ".bin", "vitest");
        cmd = `node "${vitestBin}" run "${testFile}" --root "${this.dir}" --reporter=verbose --no-color 2>&1`;
      } else {
        const testFile = this.findTestFile(["test.py", "test_source.py", "source_test.py"]);
        cmd = `python3 -m pytest ${testFile} -v --no-header --tb=short 2>&1`;
      }

      const output = execSync(cmd, {
        cwd: this.findProjectRoot(),
        encoding: "utf-8",
        timeout: 30000,
      });

      // Check exit code — vitest exits 0 on all pass, non-zero on failure
      const passed = true; // execSync throws on non-zero exit, so reaching here = pass

      return { passed, output: output.slice(-2000) };
    } catch (err) {
      const output = err instanceof Error && "stdout" in err
        ? String((err as { stdout?: string }).stdout).slice(-2000)
        : String(err).slice(0, 500);
      return { passed: false, output };
    }
  }

  /** Clean up the sandbox. */
  cleanup(): void {
    try {
      rmSync(this.dir, { recursive: true, force: true });
    } catch { /* best effort */ }
  }

  private resolve(relativePath: string): string {
    // Prevent path traversal
    const normalized = relative(this.dir, resolve(this.dir, relativePath));
    if (normalized.startsWith("..")) {
      throw new Error(`Path traversal detected: ${relativePath}`);
    }
    return join(this.dir, relativePath);
  }

  private findProjectRoot(): string {
    // Walk up from cwd to find package.json with "tracebase-ai" name
    let dir = process.cwd();
    for (let i = 0; i < 10; i++) {
      if (existsSync(join(dir, "node_modules", ".bin", "vitest"))) return dir;
      const parent = resolve(dir, "..");
      if (parent === dir) break;
      dir = parent;
    }
    return process.cwd();
  }

  private findTestFile(candidates: string[]): string {
    for (const c of candidates) {
      const full = join(this.dir, c);
      if (existsSync(full)) return c;
    }
    // Return first candidate anyway — the error message will be informative
    return candidates[0]!;
  }
}
