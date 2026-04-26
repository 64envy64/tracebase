/**
 * File summarizer — heuristic extraction (PLAN-0.7 §rc.2).
 *
 * Per-language sanity checks. The summarizer is pure, so each test
 * is just text-in / text-out with assertions over the returned
 * `summary` and `symbols` fields.
 *
 * Coverage axes:
 *   - language detection from extension
 *   - header / docstring extraction per language
 *   - imports / exports / top-level symbol extraction per language
 *   - bounded outputs (summary <= 600, symbols <= 256)
 *   - empty / pathological inputs do not throw
 */
import { describe, it, expect } from "vitest";
import {
  detectLanguage,
  summarizeFile,
  SUMMARY_MAX_CHARS,
  SYMBOLS_MAX_CHARS,
} from "../../src/core/file-summarizer.js";

describe("detectLanguage", () => {
  it.each([
    ["src/foo.ts", "typescript"],
    ["src/foo.tsx", "typescript"],
    ["src/foo.mts", "typescript"],
    ["src/foo.js", "javascript"],
    ["src/foo.mjs", "javascript"],
    ["src/foo.py", "python"],
    ["src/foo.pyi", "python"],
    ["src/foo.go", "go"],
    ["src/foo.rs", "rust"],
    ["README.md", "plain"],
    ["LICENSE", "plain"],
    ["src/foo", "plain"],
    ["src/foo.unknownext", "plain"],
  ])("%s → %s", (relPath, lang) => {
    expect(detectLanguage(relPath)).toBe(lang);
  });
});

describe("summarizeFile — TypeScript", () => {
  const tsContent = `/**
 * Schema migration framework.
 *
 * Walks pending versions and applies each migration step.
 */
import { foo } from "./helpers.js";
import bar from "./bar.js";

export const MIGRATION_FRAMEWORK_VERSION = 2;

export function applyMigration(db: Database): void {
  // …
}

export class Walker {
  step(): void {}
}

interface InternalShape {
  x: number;
}

function helperOnly(): void {}
`;

  it("extracts the doc-comment header", () => {
    const out = summarizeFile({ relPath: "src/migrations.ts", content: tsContent });
    expect(out.language).toBe("typescript");
    expect(out.summary).toContain("Schema migration framework");
    expect(out.summary).toContain("typescript");
    expect(out.summary).toContain("migrations.ts");
  });

  it("extracts imports + exports + interior symbols", () => {
    const out = summarizeFile({ relPath: "src/migrations.ts", content: tsContent });
    const sym = JSON.parse(out.symbols) as {
      imports?: string[];
      exports?: string[];
      symbols?: string[];
    };
    expect(sym.imports).toEqual(expect.arrayContaining(["./helpers.js", "./bar.js"]));
    expect(sym.exports).toEqual(
      expect.arrayContaining(["MIGRATION_FRAMEWORK_VERSION", "applyMigration"]),
    );
    expect(sym.symbols).toEqual(expect.arrayContaining(["InternalShape"]));
  });

  it("respects bounded outputs even on huge files", () => {
    const big =
      "/** doc */\nimport { a } from 'x';\n" +
      Array.from({ length: 500 })
        .map((_, i) => `export function fn${i}(): void {}`)
        .join("\n");
    const out = summarizeFile({ relPath: "src/big.ts", content: big });
    expect(out.summary.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
    expect(out.symbols.length).toBeLessThanOrEqual(SYMBOLS_MAX_CHARS);
    // The JSON is still parseable.
    expect(() => JSON.parse(out.symbols)).not.toThrow();
  });
});

describe("summarizeFile — Python", () => {
  const pyContent = `"""
Distillation pipeline orchestrator.

Owns the per-trace flow from outcome → block.
"""
from foo.bar import baz
import json

def distill(trace: Trace) -> Block:
    return _internal(trace)

class Pipeline:
    def __init__(self):
        pass

async def fetch_async(url: str) -> str:
    return ""
`;

  it("extracts the module docstring", () => {
    const out = summarizeFile({ relPath: "src/pipeline.py", content: pyContent });
    expect(out.language).toBe("python");
    expect(out.summary).toContain("Distillation pipeline orchestrator");
  });

  it("extracts imports + top-level def / class", () => {
    const out = summarizeFile({ relPath: "src/pipeline.py", content: pyContent });
    const sym = JSON.parse(out.symbols);
    expect(sym.imports).toEqual(expect.arrayContaining(["foo.bar", "json"]));
    expect(sym.symbols).toEqual(
      expect.arrayContaining(["distill", "Pipeline", "fetch_async"]),
    );
  });

  it("falls back to # comment header when no docstring", () => {
    const py = `# Top-of-file comment.\n# Multi-line description.\nimport os\n`;
    const out = summarizeFile({ relPath: "src/util.py", content: py });
    expect(out.summary).toContain("Top-of-file comment");
    expect(JSON.parse(out.symbols).imports).toContain("os");
  });
});

describe("summarizeFile — Go", () => {
  const goContent = `// Package storage owns the SQLite-backed durable store.
//
// All readers and writers route through here.
package storage

import (
    "context"
    "database/sql"
)

func Open(ctx context.Context, path string) (*Store, error) {
    return nil, nil
}

type Store struct {
    db *sql.DB
}

func (s *Store) close() {}
`;

  it("extracts the //-block doc comment", () => {
    const out = summarizeFile({ relPath: "internal/storage/store.go", content: goContent });
    expect(out.language).toBe("go");
    expect(out.summary).toContain("Package storage owns the SQLite-backed durable store");
  });

  it("extracts imports + exported (uppercase) symbols", () => {
    const out = summarizeFile({ relPath: "internal/storage/store.go", content: goContent });
    const sym = JSON.parse(out.symbols);
    expect(sym.imports).toEqual(expect.arrayContaining(["context", "database/sql"]));
    expect(sym.exports).toEqual(expect.arrayContaining(["Open", "Store"]));
    // package marker appears as a symbol.
    expect(sym.symbols).toEqual(expect.arrayContaining(["pkg:storage"]));
    // Lowercase `close` is a symbol but NOT exported.
    expect(sym.exports ?? []).not.toContain("close");
  });
});

describe("summarizeFile — Rust", () => {
  const rsContent = `//! Crate-level docs.
//!
//! Describes the crate purpose.
use std::fs;
use crate::types::Block;

pub fn open_workspace(root: &str) -> Result<Workspace, Error> {
    todo!()
}

pub struct Workspace {
    pub root: String,
}

fn private_helper() {}
`;

  it("extracts crate-level //! doc", () => {
    const out = summarizeFile({ relPath: "src/lib.rs", content: rsContent });
    expect(out.language).toBe("rust");
    expect(out.summary).toContain("Crate-level docs");
  });

  it("extracts use + pub fn / pub struct as exports", () => {
    const out = summarizeFile({ relPath: "src/lib.rs", content: rsContent });
    const sym = JSON.parse(out.symbols);
    expect(sym.imports).toEqual(
      expect.arrayContaining(["std::fs", "crate::types::Block"]),
    );
    expect(sym.exports).toEqual(expect.arrayContaining(["open_workspace", "Workspace"]));
    expect(sym.exports ?? []).not.toContain("private_helper");
  });
});

describe("summarizeFile — plain text + edge cases", () => {
  it("plain text falls back to first-five-lines blurb", () => {
    const txt = "This is the README.\n\nIt explains the project.\nAlso the install steps.\n";
    const out = summarizeFile({ relPath: "README.md", content: txt });
    expect(out.language).toBe("plain");
    expect(out.summary).toContain("This is the README");
    expect(out.summary).toContain("It explains the project");
    // Plain text has no extractable symbols.
    expect(JSON.parse(out.symbols)).toEqual({});
  });

  it("empty content does not throw", () => {
    const out = summarizeFile({ relPath: "src/empty.ts", content: "" });
    expect(out.summary.length).toBeGreaterThan(0); // role line at minimum
    expect(JSON.parse(out.symbols)).toEqual({});
  });

  it("explicit language override beats path-based detection", () => {
    const out = summarizeFile({
      relPath: "src/weird.unknown",
      content: '/** hello */\nimport { foo } from "x";',
      language: "typescript",
    });
    expect(out.language).toBe("typescript");
    expect(JSON.parse(out.symbols).imports).toContain("x");
  });

  it("path role uses parent dir for generic filenames", () => {
    const out = summarizeFile({
      relPath: "src/feature/index.ts",
      content: "/** entry point */\nexport const x = 1;",
    });
    expect(out.summary).toContain("feature/index.ts");
  });
});
