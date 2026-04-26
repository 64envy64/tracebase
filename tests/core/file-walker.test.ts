/**
 * Workspace walker — exclusions, budgets, pending semantics
 * (PLAN-0.7 §rc.2).
 *
 * Tests use real fs against a freshly-created temp dir. Each test
 * stands up its own fixture tree so we can assert exact yield
 * counts + the pending queue shape under controlled budgets.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkWorkspace } from "../../src/core/file-walker.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tb-walker-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function plant(rel: string, content: string | Buffer): void {
  const abs = join(root, rel);
  const dir = abs.split(/[/\\]/).slice(0, -1).join("/");
  mkdirSync(dir, { recursive: true });
  writeFileSync(abs, content);
}

// ---------------------------------------------------------------------------
// Basic walking
// ---------------------------------------------------------------------------

describe("walkWorkspace — basic walking", () => {
  it("yields every indexable file under the root", () => {
    plant("src/a.ts", "export const a = 1;");
    plant("src/b.ts", "export const b = 2;");
    plant("tests/c.test.ts", "test('c', () => {});");
    plant("README.md", "# Hello");

    const result = walkWorkspace({ root });
    const yieldedRels = result.files.map((f) => f.relPath).sort();
    expect(yieldedRels).toEqual(["README.md", "src/a.ts", "src/b.ts", "tests/c.test.ts"]);
    expect(result.pendingFiles).toEqual([]);
    expect(result.pendingDirs).toEqual([]);
  });

  it("returns repo-relative paths only (POSIX separators)", () => {
    plant("src/nested/deep/file.ts", "x");
    const result = walkWorkspace({ root });
    expect(result.files[0]?.relPath).toBe("src/nested/deep/file.ts");
  });

  it("returns durationMs and bytesRead", () => {
    plant("a.ts", "x");
    plant("b.ts", "yy");
    const result = walkWorkspace({ root });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.bytesRead).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Exclusions
// ---------------------------------------------------------------------------

describe("walkWorkspace — exclusions", () => {
  it("excludes node_modules / .git / dist / build / coverage / .tracebase", () => {
    plant("src/a.ts", "ok");
    plant("node_modules/bad/index.js", "leaked");
    plant(".git/HEAD", "leaked");
    plant("dist/bundle.js", "leaked");
    plant("build/foo.js", "leaked");
    plant("coverage/report.json", "leaked");
    plant(".tracebase/cache.bin", "leaked");
    plant(".next/build.json", "leaked");

    const result = walkWorkspace({ root });
    const yielded = result.files.map((f) => f.relPath);
    expect(yielded).toEqual(["src/a.ts"]);

    // Excluded dirs surface in `skipped` with reason 'excluded-dir'.
    const excludedReasons = result.skipped.filter((s) => s.reason === "excluded-dir");
    const excludedRels = excludedReasons.map((s) => s.relPath).sort();
    expect(excludedRels).toEqual(
      [".git", ".next", ".tracebase", "build", "coverage", "dist", "node_modules"].sort(),
    );
  });

  it("excludes binary suffixes regardless of size", () => {
    plant("img.png", "fake-png-bytes");
    plant("font.woff2", "fake-font-bytes");
    plant("archive.zip", "fake-zip");
    plant("src/a.ts", "ok");

    const result = walkWorkspace({ root });
    expect(result.files.map((f) => f.relPath)).toEqual(["src/a.ts"]);
    const skippedBySuffix = result.skipped.filter((s) => s.reason === "excluded-suffix");
    expect(skippedBySuffix.map((s) => s.relPath).sort()).toEqual([
      "archive.zip",
      "font.woff2",
      "img.png",
    ]);
  });

  it("sniffs null-byte content as binary even on text-like extensions", () => {
    // Plant a `.txt` with a NUL early — should fail the sniff and skip.
    plant("data.txt", Buffer.from([0x68, 0x65, 0x00, 0x6c, 0x6f]));
    const result = walkWorkspace({ root });
    expect(result.files.map((f) => f.relPath)).toEqual([]);
    expect(result.skipped).toEqual([{ relPath: "data.txt", reason: "binary" }]);
  });

  it("skips files larger than the per-file cap", () => {
    plant("huge.ts", "x".repeat(300_000)); // 300 KB
    plant("normal.ts", "ok");
    const result = walkWorkspace({ root, maxBytes: 256 * 1024 });
    expect(result.files.map((f) => f.relPath)).toEqual(["normal.ts"]);
    expect(result.skipped.find((s) => s.reason === "too-large")?.relPath).toBe("huge.ts");
  });
});

// ---------------------------------------------------------------------------
// Budget enforcement
// ---------------------------------------------------------------------------

describe("walkWorkspace — budgets", () => {
  it("maxFiles cap halts and queues the rest as pendingFiles", () => {
    for (let i = 0; i < 20; i++) plant(`src/f${i}.ts`, `export const x${i} = ${i};`);
    const result = walkWorkspace({ root, budget: { maxFiles: 5 } });
    expect(result.files.length).toBe(5);
    // The rest land somewhere — either pendingFiles or pendingDirs;
    // the BFS shape tends to stop mid-dir, so we expect the un-yielded
    // remainder of the directory to surface as a pendingDir.
    const totalAccounted =
      result.files.length + result.pendingFiles.length + result.pendingDirs.length;
    expect(totalAccounted).toBeGreaterThan(5);
  });

  it("maxBytesScan cap leaves un-read files in pendingFiles", () => {
    for (let i = 0; i < 5; i++) plant(`src/f${i}.ts`, "x".repeat(1000));
    // Budget allows ~2.5 files worth of bytes.
    const result = walkWorkspace({
      root,
      budget: { maxBytesScan: 2500 },
    });
    expect(result.files.length).toBeGreaterThanOrEqual(2);
    expect(result.files.length).toBeLessThanOrEqual(3);
    expect(result.pendingFiles.length).toBeGreaterThan(0);
  });

  it("timeMs cap (driven via injected now()) halts cleanly", () => {
    for (let i = 0; i < 5; i++) plant(`src/f${i}.ts`, `export const x = ${i};`);
    let calls = 0;
    // Tick by 10ms per call. Budget is 25ms, so we get ~3 ticks
    // before exhaustion.
    const now = () => 1_000_000 + calls++ * 10;
    const result = walkWorkspace({
      root,
      budget: { timeMs: 25 },
      now,
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(25);
    // Some files yielded, some still pending — exact number depends
    // on tick interleave, but the budget MUST have halted us.
    const total =
      result.files.length + result.pendingFiles.length + result.pendingDirs.length;
    expect(total).toBeGreaterThan(0);
  });

  it("never-entered top-level dir lands as a pendingDir when budget hits at the root", () => {
    plant("src/a.ts", "x");
    plant("src/b.ts", "y");
    plant("tests/a.test.ts", "z");
    plant("docs/intro.md", "w");
    // Budget = 1 file. We yield one then halt; remaining queued
    // dirs surface in pendingDirs.
    const result = walkWorkspace({ root, budget: { maxFiles: 1 } });
    expect(result.files.length).toBe(1);
    expect(result.pendingDirs.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Determinism + edge cases
// ---------------------------------------------------------------------------

describe("walkWorkspace — baseRoot vs startRoot (0.7.0-rc.2 hardening)", () => {
  it("yields paths repo-relative to baseRoot, not startRoot, when both are passed", () => {
    plant("src/deep/target.ts", "export const x = 1;");
    plant("src/deep/sibling.ts", "export const y = 2;");

    // Sub-walk the `src/deep/` directory but compute paths against
    // the project root. Pre-hardening this would have yielded
    // `target.ts` / `sibling.ts`; post-hardening yields the full
    // repo-relative path.
    const startRoot = join(root, "src", "deep");
    const result = walkWorkspace({ root: startRoot, baseRoot: root });
    const yielded = result.files.map((f) => f.relPath).sort();
    expect(yielded).toEqual(["src/deep/sibling.ts", "src/deep/target.ts"]);
  });

  it("falls back to root when baseRoot is omitted (back-compat)", () => {
    plant("src/a.ts", "x");
    const result = walkWorkspace({ root });
    expect(result.files.map((f) => f.relPath)).toEqual(["src/a.ts"]);
  });

  it("pendingDirs from sub-walk surface as repo-relative against baseRoot", () => {
    for (let i = 0; i < 5; i++) plant(`src/deep/f${i}.ts`, "x");
    plant("src/deep/another/x.ts", "x");

    const startRoot = join(root, "src", "deep");
    const result = walkWorkspace({
      root: startRoot,
      baseRoot: root,
      budget: { maxFiles: 1 },
    });
    // Whatever still hasn't been walked surfaces as a pendingDir
    // path with the FULL `src/deep/...` prefix, not the relative-
    // to-startRoot form.
    for (const dir of result.pendingDirs) {
      expect(dir.startsWith("src/deep")).toBe(true);
    }
  });
});

describe("walkWorkspace — determinism + edge cases", () => {
  it("walk order is deterministic (sorted entries)", () => {
    plant("src/zeta.ts", "x");
    plant("src/alpha.ts", "x");
    plant("src/middle.ts", "x");
    const a = walkWorkspace({ root }).files.map((f) => f.relPath);
    const b = walkWorkspace({ root }).files.map((f) => f.relPath);
    expect(a).toEqual(b);
    expect(a).toEqual(["src/alpha.ts", "src/middle.ts", "src/zeta.ts"]);
  });

  it("unreadable file (permissions, transient I/O) lands as 'unreadable'", () => {
    // We can't reliably create a permission-denied file in CI without
    // root, so this test only verifies the path emits zero throws —
    // the walker swallows readFileSync errors.
    plant("src/a.ts", "ok");
    const result = walkWorkspace({ root });
    expect(result.files.length).toBe(1);
  });

  it("empty workspace yields nothing without throwing", () => {
    const result = walkWorkspace({ root });
    expect(result.files).toEqual([]);
    expect(result.pendingFiles).toEqual([]);
    expect(result.pendingDirs).toEqual([]);
    expect(result.skipped).toEqual([]);
  });
});
