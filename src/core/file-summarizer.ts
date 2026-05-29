/**
 * Heuristic file summarizer (PLAN-0.7 §rc.2).
 *
 * Pure function: given a file's repo-relative path + UTF-8 content,
 * produce a short summary string (<= 600 chars) and a JSON-encoded
 * symbols payload (<= 256 chars). No filesystem reads, no DB writes,
 * no async — the indexer drives I/O.
 *
 * Per-language extraction strategies are intentionally simple. The
 * goal isn't a parser; it's recall help — a future search query
 * "where do we register the X handler" should hit the file whose
 * symbols list contains an exported `registerXHandler` even if the
 * full body never reaches the prompt. The summary plus symbols are
 * the entire surface the cloud allowlist + the future recall path
 * sees.
 *
 * Privacy guarantees the caller relies on:
 *   - Output is bounded (600 / 256 chars). A pathological file can
 *     never balloon a row.
 *   - Output is plain text + JSON. No diffs / no abs paths / no
 *     fenced code blocks survive — the heuristic only emits header
 *     comments and identifiers it pulled out by name.
 *   - The caller (indexer) still runs `detectLeakageExtended` and
 *     `detectPromptInjectionPatterns` over the produced summary
 *     before persisting; the summarizer doesn't pre-scan because
 *     a positive match means the file is non-indexable, not that
 *     the summarizer is broken.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type FileLanguage =
  | "typescript"
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "plain";

export interface FileSummarizerInput {
  /** Repo-relative path. Used only to inform the path-role fallback line. */
  relPath: string;
  /** Full UTF-8 content of the file. Caller is responsible for size cap. */
  content: string;
  /**
   * Detected language. If absent, the summarizer falls back to a
   * plain-text heuristic. Callers should use `detectLanguage` on
   * the path extension when they don't already know the language.
   */
  language?: FileLanguage;
}

export interface FileSummary {
  /** Bounded text. Always non-empty when input had any content. */
  summary: string;
  /**
   * JSON string. Schema:
   *   { imports?: string[], exports?: string[], symbols?: string[] }
   * Bounded to 256 chars; lower-priority entries are dropped to fit.
   * Non-empty arrays only — caller can JSON.parse and treat empty
   * keys as absent.
   */
  symbols: string;
  /** Echo of the input language (or `'plain'` when undetected). */
  language: FileLanguage;
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Hard char cap on `summary`. The schema column matches this. */
export const SUMMARY_MAX_CHARS = 600;
/** Hard char cap on the JSON-encoded symbols payload. */
export const SYMBOLS_MAX_CHARS = 256;
/** Header lines we'll consider for the doc-comment / first-block extraction. */
const HEADER_SCAN_LINES = 40;
/** Lines we'll scan to extract top-level symbols. Bounded for big files. */
const SYMBOL_SCAN_LINES = 400;

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

/**
 * Pure: map a path to its language slot via extension. Unknown
 * extensions return `'plain'`. We never sniff content for language
 * detection — that's a re-read, and the indexer is budget-bound.
 */
export function detectLanguage(relPath: string): FileLanguage {
  const ext = relPath.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (!ext) return "plain";
  switch (ext) {
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
      return "typescript";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "javascript";
    case "py":
    case "pyi":
      return "python";
    case "go":
      return "go";
    case "rs":
      return "rust";
    default:
      return "plain";
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function summarizeFile(input: FileSummarizerInput): FileSummary {
  const language = input.language ?? detectLanguage(input.relPath);
  const lines = input.content.split(/\r?\n/);

  // Strategy: produce two strings.
  //   `summary` is a one-paragraph blurb leading with the file role
  //   (path tail) and including the first doc-comment / docstring /
  //   header block when one exists.
  //   `symbols` carries the structured identifiers the language
  //   extractor pulls out.
  const header = extractHeader(lines, language);
  const symbolsObj = extractSymbols(lines, language);
  const symbolsJson = encodeSymbols(symbolsObj);

  const role = pathRole(input.relPath);
  const blurb = composeSummary({
    role,
    header,
    language,
    symbolsObj,
  });

  return {
    summary: clamp(blurb, SUMMARY_MAX_CHARS),
    symbols: symbolsJson,
    language,
  };
}

// ---------------------------------------------------------------------------
// Header extraction
// ---------------------------------------------------------------------------

interface ExtractedHeader {
  text: string;
  /** True iff the heuristic matched a real doc-comment, false on fallback. */
  matched: boolean;
}

function extractHeader(lines: string[], language: FileLanguage): ExtractedHeader {
  const window = lines.slice(0, HEADER_SCAN_LINES);
  if (window.length === 0) return { text: "", matched: false };

  switch (language) {
    case "typescript":
    case "javascript":
    case "go":
    case "rust": {
      // Block-comment style: /** ... */ or /* ... */ or contiguous
      // // lines. Rust additionally allows //! / //!.
      const block = matchSlashStarBlock(window);
      if (block) return { text: stripCommentMarkers(block), matched: true };
      const slashSlash = matchContiguousSlashSlash(window);
      if (slashSlash) return { text: stripCommentMarkers(slashSlash), matched: true };
      // Rust crate-level //! preserved by matchContiguousSlashSlash.
      return { text: firstNonEmptyLine(window), matched: false };
    }
    case "python": {
      const docstring = matchPythonDocstring(window);
      if (docstring) return { text: docstring, matched: true };
      const hashes = matchContiguousHashLines(window);
      if (hashes) return { text: stripCommentMarkers(hashes), matched: true };
      return { text: firstNonEmptyLine(window), matched: false };
    }
    case "plain": {
      // Take the first ~5 non-empty lines, joined.
      const firstFive = window
        .filter((l) => l.trim().length > 0)
        .slice(0, 5)
        .map((l) => l.trim())
        .join(" ");
      return { text: firstFive, matched: firstFive.length > 0 };
    }
  }
}

/** Match a leading /** ... *​/ or /* ... *​/ block at the very start. */
function matchSlashStarBlock(lines: string[]): string | null {
  // Skip leading blank lines.
  let i = 0;
  while (i < lines.length && lines[i]!.trim().length === 0) i++;
  if (i >= lines.length) return null;
  const opener = lines[i]!.trim();
  if (!opener.startsWith("/*")) return null;
  // Single-line /* ... */?
  if (opener.includes("*/")) {
    return opener;
  }
  const collected: string[] = [opener];
  for (let j = i + 1; j < lines.length; j++) {
    collected.push(lines[j]!);
    if (lines[j]!.includes("*/")) return collected.join("\n");
  }
  return null;
}

/** Match a contiguous run of `//` (or `//!`) comment lines at the top. */
function matchContiguousSlashSlash(lines: string[]): string | null {
  let i = 0;
  while (i < lines.length && lines[i]!.trim().length === 0) i++;
  const collected: string[] = [];
  while (i < lines.length) {
    const t = lines[i]!.trimStart();
    if (!t.startsWith("//")) break;
    collected.push(lines[i]!);
    i++;
  }
  return collected.length > 0 ? collected.join("\n") : null;
}

/** Match a contiguous run of `#` comment lines at the top (Python, etc.). */
function matchContiguousHashLines(lines: string[]): string | null {
  let i = 0;
  while (i < lines.length && lines[i]!.trim().length === 0) i++;
  // Skip a shebang.
  if (i < lines.length && lines[i]!.startsWith("#!")) i++;
  const collected: string[] = [];
  while (i < lines.length) {
    const t = lines[i]!.trimStart();
    if (!t.startsWith("#")) break;
    collected.push(lines[i]!);
    i++;
  }
  return collected.length > 0 ? collected.join("\n") : null;
}

/** Match a Python docstring at the module top. """ ... """ or ''' ... ''' */
function matchPythonDocstring(lines: string[]): string | null {
  let i = 0;
  while (i < lines.length && lines[i]!.trim().length === 0) i++;
  // Skip future-import / shebang style preambles before the docstring.
  while (
    i < lines.length &&
    (lines[i]!.startsWith("#!") || /^from __future__|^# coding/.test(lines[i]!))
  ) {
    i++;
  }
  if (i >= lines.length) return null;
  const trimmed = lines[i]!.trim();
  const triple = trimmed.startsWith('"""') ? '"""' : trimmed.startsWith("'''") ? "'''" : null;
  if (!triple) return null;
  // Single-line docstring: """one liner""".
  const rest = trimmed.slice(3);
  if (rest.endsWith(triple) && rest.length > 3) {
    return rest.slice(0, rest.length - 3);
  }
  // Multi-line: collect until the closing triple.
  const collected: string[] = [trimmed];
  for (let j = i + 1; j < lines.length; j++) {
    collected.push(lines[j]!);
    if (lines[j]!.includes(triple)) {
      const joined = collected.join("\n");
      // Strip the surrounding triples for cleanliness.
      const re = new RegExp(`^${escapeRegex(triple)}|${escapeRegex(triple)}$`, "g");
      return joined.replace(re, "").trim();
    }
  }
  return null;
}

function stripCommentMarkers(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) =>
      l
        // /** ... */ block markers
        .replace(/^\s*\/\*+\s?/, "")
        .replace(/\s*\*+\/\s*$/, "")
        // contiguous //, //!, //!! markers
        .replace(/^\s*\/\/!?\s?/, "")
        // # markers (Python, etc.)
        .replace(/^\s*#!?\s?/, "")
        // intermediate * (block-comment continuation lines)
        .replace(/^\s*\*\s?/, ""),
    )
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstNonEmptyLine(lines: string[]): string {
  for (const l of lines) {
    const t = l.trim();
    if (t.length > 0) return t;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Symbol extraction
// ---------------------------------------------------------------------------

interface SymbolBundle {
  imports?: string[];
  exports?: string[];
  symbols?: string[];
}

function extractSymbols(lines: string[], language: FileLanguage): SymbolBundle {
  const window = lines.slice(0, SYMBOL_SCAN_LINES);
  switch (language) {
    case "typescript":
    case "javascript":
      return extractTsJsSymbols(window);
    case "python":
      return extractPythonSymbols(window);
    case "go":
      return extractGoSymbols(window);
    case "rust":
      return extractRustSymbols(window);
    case "plain":
      return {};
  }
}

function extractTsJsSymbols(lines: string[]): SymbolBundle {
  const imports: string[] = [];
  const exports: string[] = [];
  const symbols: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    // ESM imports: `import foo from "x";` / `import { a, b } from "x";`
    const importMatch = line.match(/^import\s+(?:[^"';]+?\s+from\s+)?["']([^"']+)["']/);
    if (importMatch) {
      imports.push(importMatch[1]!);
      continue;
    }
    // CJS requires (less common; covered for compatibility)
    const requireMatch = line.match(/\brequire\(\s*["']([^"']+)["']/);
    if (requireMatch) imports.push(requireMatch[1]!);
    // export const / let / function / class / interface / type
    const exportConst = line.match(
      /^export\s+(?:async\s+)?(?:default\s+)?(?:const|let|function\*?|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
    );
    if (exportConst) exports.push(exportConst[1]!);
    // re-export shapes: export { a, b }
    const reExport = line.match(/^export\s*\{\s*([^}]+)\}/);
    if (reExport) {
      for (const id of reExport[1]!.split(",")) {
        const cleaned = id.trim().split(/\s+as\s+/).pop()!.trim();
        if (cleaned && /^[A-Za-z_$][\w$]*$/.test(cleaned)) exports.push(cleaned);
      }
    }
    // Top-level fns / classes (non-exported still count as symbols).
    const declMatch = line.match(
      /^(?:async\s+)?(?:function\*?|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
    );
    if (declMatch) symbols.push(declMatch[1]!);
  }
  return compact({ imports, exports, symbols });
}

function extractPythonSymbols(lines: string[]): SymbolBundle {
  const imports: string[] = [];
  const symbols: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    const fromImport = line.match(/^from\s+([\w.]+)\s+import\s+/);
    if (fromImport) imports.push(fromImport[1]!);
    const directImport = line.match(/^import\s+([\w.]+)/);
    if (directImport) imports.push(directImport[1]!);
    // Top-level def / class (no leading whitespace).
    if (raw.startsWith("def ") || raw.startsWith("async def ")) {
      const m = raw.match(/^(?:async\s+)?def\s+([A-Za-z_]\w*)/);
      if (m) symbols.push(m[1]!);
    }
    if (raw.startsWith("class ")) {
      const m = raw.match(/^class\s+([A-Za-z_]\w*)/);
      if (m) symbols.push(m[1]!);
    }
  }
  return compact({ imports, symbols });
}

function extractGoSymbols(lines: string[]): SymbolBundle {
  const imports: string[] = [];
  const exports: string[] = [];
  const symbols: string[] = [];
  let inImportBlock = false;
  let pkg: string | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!pkg) {
      const m = line.match(/^package\s+([A-Za-z_]\w*)/);
      if (m) {
        pkg = m[1]!;
        symbols.push(`pkg:${pkg}`);
      }
    }
    if (line.startsWith("import (")) {
      inImportBlock = true;
      continue;
    }
    if (inImportBlock) {
      if (line === ")") {
        inImportBlock = false;
        continue;
      }
      const m = line.match(/"([^"]+)"/);
      if (m) imports.push(m[1]!);
      continue;
    }
    const singleImport = line.match(/^import\s+(?:[A-Za-z_]\w*\s+)?"([^"]+)"/);
    if (singleImport) imports.push(singleImport[1]!);
    // Top-level decls. Go uppercase first letter = exported.
    const fn = line.match(/^func\s+(?:\([^)]*\)\s+)?([A-Za-z_]\w*)/);
    if (fn) {
      const name = fn[1]!;
      symbols.push(name);
      if (/^[A-Z]/.test(name)) exports.push(name);
    }
    const typ = line.match(/^type\s+([A-Za-z_]\w*)/);
    if (typ) {
      const name = typ[1]!;
      symbols.push(name);
      if (/^[A-Z]/.test(name)) exports.push(name);
    }
  }
  return compact({ imports, exports, symbols });
}

function extractRustSymbols(lines: string[]): SymbolBundle {
  const imports: string[] = [];
  const exports: string[] = [];
  const symbols: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    const useMatch = line.match(/^use\s+([\w:]+)/);
    if (useMatch) imports.push(useMatch[1]!);
    const fnMatch = line.match(/^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/);
    if (fnMatch) {
      const name = fnMatch[1]!;
      symbols.push(name);
      if (line.startsWith("pub ")) exports.push(name);
    }
    const structMatch = line.match(
      /^(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|type)\s+([A-Za-z_]\w*)/,
    );
    if (structMatch) {
      const name = structMatch[1]!;
      symbols.push(name);
      if (line.startsWith("pub ")) exports.push(name);
    }
  }
  return compact({ imports, exports, symbols });
}

function compact(b: SymbolBundle): SymbolBundle {
  const out: SymbolBundle = {};
  if (b.imports && b.imports.length > 0) out.imports = uniq(b.imports);
  if (b.exports && b.exports.length > 0) out.exports = uniq(b.exports);
  if (b.symbols && b.symbols.length > 0) out.symbols = uniq(b.symbols);
  return out;
}

function uniq(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of arr) {
    if (!seen.has(a)) {
      seen.add(a);
      out.push(a);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Encoding + clamping
// ---------------------------------------------------------------------------

/**
 * JSON-encode the symbols bundle, dropping lower-priority entries
 * until the output fits SYMBOLS_MAX_CHARS. Priority order:
 *   exports > imports > symbols
 * (exported identifiers are the most retrieval-relevant; imports
 * give the file's dependency surface; raw symbols are the long-tail
 * top-level identifier list).
 */
function encodeSymbols(b: SymbolBundle): string {
  const trimmed: SymbolBundle = { ...b };
  let json = JSON.stringify(trimmed);
  if (json.length <= SYMBOLS_MAX_CHARS) return json;

  // Trim each list from the back until we fit. We could be smarter
  // (drop the longest list first), but the priority order is the
  // tie-breaker the design comment names.
  for (const key of ["symbols", "imports", "exports"] as const) {
    const list = trimmed[key];
    if (!list) continue;
    while (list.length > 0 && JSON.stringify(trimmed).length > SYMBOLS_MAX_CHARS) {
      list.pop();
    }
    if (list.length === 0) delete trimmed[key];
    json = JSON.stringify(trimmed);
    if (json.length <= SYMBOLS_MAX_CHARS) return json;
  }
  // Worst case: empty object.
  return "{}";
}

function composeSummary(opts: {
  role: string;
  header: ExtractedHeader;
  language: FileLanguage;
  symbolsObj: SymbolBundle;
}): string {
  const parts: string[] = [];
  parts.push(`${opts.role} (${opts.language}).`);
  if (opts.header.matched && opts.header.text.length > 0) {
    parts.push(opts.header.text);
  } else if (opts.header.text.length > 0 && !isNoiseFirstLine(opts.header.text)) {
    // Only surface a fallback first line when it carries signal. A bare
    // `import …` / `package …` / `use …` line is path noise that dilutes
    // the file's real vocabulary under bm25 — skip it.
    parts.push(`First line: ${opts.header.text}`);
  }
  // `defines:` carries the file's own identifier vocabulary — exported
  // AND local top-level function/class/symbol names. This is the highest-
  // value recall surface for code-navigation queries: a query naming the
  // concept ("derivative") should match the file that defines
  // `createDerivative` / `plainDerivative`, not a doc that merely shares a
  // stemmed word. Exports lead (most relevant), then local symbols. Up to
  // 12 names; the 600-char clamp is the final backstop.
  const defines = uniq([
    ...(opts.symbolsObj.exports ?? []),
    ...(opts.symbolsObj.symbols ?? []),
  ]).slice(0, 12);
  if (defines.length > 0) parts.push(`defines: ${defines.join(", ")}`);
  // Imports stay in the structured `symbols` JSON (dependency-surface
  // queries can still hit them) but are kept OUT of the summary text:
  // module specifiers like `../../utils/is.js` are recall noise.
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * True when a fallback "first line" is a bare import/module/declaration
 * statement that carries no behavioural signal — surfacing it only dilutes
 * the summary's term frequency for the file's real vocabulary.
 */
function isNoiseFirstLine(s: string): boolean {
  return /^\s*(import\b|from\b|require\s*\(|use\b|package\b|#include|using\b|export\s+(?:\{|\*))/.test(s);
}

function pathRole(relPath: string): string {
  // Last segment, but also include the parent dir for context if the
  // file is named generically (`index.ts` / `mod.rs`).
  const segs = relPath.split("/");
  const last = segs[segs.length - 1] ?? relPath;
  if (segs.length >= 2 && /^(index|mod|main|init|__init__|lib)\.[a-z]+$/.test(last)) {
    return `${segs[segs.length - 2]}/${last}`;
  }
  return last;
}

function clamp(s: string, max: number): string {
  if (s.length <= max) return s;
  // Truncate on a word boundary if possible to avoid mid-word cuts
  // in the rendered injection.
  const slice = s.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace > max - 80) return slice.slice(0, lastSpace) + "…";
  return slice + "…";
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
