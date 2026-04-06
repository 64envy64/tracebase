import { createHash } from "node:crypto";

// ============================================================================
// Reasoning Fingerprinting
//
// Produces a structural fingerprint of a problem for fast exact/near matching.
// Inspired by how Sentry groups errors — extract canonical features, hash them.
// ============================================================================

/** Result of fingerprinting a problem. */
export interface FingerprintResult {
  /** SHA-256 hex hash of the canonical fingerprint */
  hash: string;
  /** Raw canonical string before hashing */
  canonical: string;
  /** Individual extracted tokens (for Jaccard similarity) */
  tokens: string[];
  /** Structured features extracted from the problem */
  features: ExtractedFeatures;
}

export interface ExtractedFeatures {
  errorType?: string;
  errorCode?: string;
  language?: string;
  framework?: string;
  fileExtension?: string;
  keywords: string[];
}

// ============================================================================
// Common error type patterns
// ============================================================================

const ERROR_TYPE_PATTERNS: Array<[RegExp, string]> = [
  // JavaScript/TypeScript
  [/\b(TypeError|ReferenceError|SyntaxError|RangeError|URIError|EvalError)\b/i, "$1"],
  [/\b(ENOENT|EACCES|ECONNREFUSED|EPERM|EEXIST|EMFILE|EADDRINUSE)\b/, "$1"],
  [/\bUnhandledPromiseRejection\b/i, "UnhandledPromiseRejection"],
  // Python
  [/\b(ValueError|KeyError|IndexError|AttributeError|ImportError|ModuleNotFoundError)\b/, "$1"],
  [/\b(FileNotFoundError|PermissionError|ConnectionError|TimeoutError)\b/, "$1"],
  // Java/JVM
  [/\b(NullPointerException|ClassNotFoundException|IllegalArgumentException)\b/, "$1"],
  [/\b(OutOfMemoryError|StackOverflowError|IOException)\b/, "$1"],
  // Go
  [/\bnil pointer dereference\b/i, "NilPointerDereference"],
  [/\bdeadlock\b/i, "Deadlock"],
  // Rust
  [/\bpanic!?\b.*unwrap/i, "UnwrapPanic"],
  [/\bborrow checker\b/i, "BorrowChecker"],
  // HTTP
  [/\b(4\d{2}|5\d{2})\b.*(?:error|status|response)/i, "HTTP$1"],
  // Generic
  [/\bSegmentation fault\b/i, "SegFault"],
  [/\bOut of memory\b/i, "OOM"],
  [/\bStack overflow\b/i, "StackOverflow"],
];

const FRAMEWORK_PATTERNS: Array<[RegExp, string]> = [
  [/\b(react|nextjs|next\.js)\b/i, "react"],
  [/\b(vue|nuxt)\b/i, "vue"],
  [/\b(angular)\b/i, "angular"],
  [/\b(svelte|sveltekit)\b/i, "svelte"],
  [/\b(express|koa|fastify|hono)\b/i, "$1"],
  [/\b(django|flask|fastapi)\b/i, "$1"],
  [/\b(rails|ruby on rails)\b/i, "rails"],
  [/\b(spring|spring boot)\b/i, "spring"],
  [/\b(gin|echo|fiber)\b/i, "$1"],
  [/\b(tokio|actix|axum)\b/i, "$1"],
  [/\b(prisma|typeorm|sequelize|drizzle)\b/i, "$1"],
  [/\b(jest|vitest|pytest|junit|mocha)\b/i, "$1"],
  [/\b(webpack|vite|esbuild|rollup|tsup)\b/i, "$1"],
  [/\b(docker|kubernetes|k8s)\b/i, "$1"],
  [/\b(postgres|postgresql|mysql|mongodb|redis|sqlite)\b/i, "$1"],
];

const LANGUAGE_EXTENSIONS: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  py: "python", rb: "ruby", go: "go", rs: "rust",
  java: "java", kt: "kotlin", scala: "scala",
  cs: "csharp", cpp: "cpp", c: "c", h: "c",
  swift: "swift", m: "objectivec",
  php: "php", sql: "sql", sh: "shell", bash: "shell",
  yml: "yaml", yaml: "yaml", json: "json", toml: "toml",
};

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "can", "shall", "to", "of", "in", "for",
  "on", "with", "at", "by", "from", "as", "into", "through", "during",
  "before", "after", "above", "below", "between", "and", "but", "or",
  "not", "no", "nor", "so", "yet", "both", "either", "neither", "this",
  "that", "these", "those", "it", "its", "i", "me", "my", "we", "our",
  "you", "your", "he", "she", "they", "them", "their", "what", "which",
  "who", "when", "where", "why", "how", "all", "each", "every", "some",
  "any", "few", "more", "most", "other", "than", "too", "very", "just",
  "also", "then", "if", "else", "while", "about", "up", "out", "off",
]);

// ============================================================================
// Public API
// ============================================================================

/**
 * Compute a structural fingerprint for a problem description.
 * Deterministic — same input always produces same fingerprint.
 */
export function fingerprint(
  description: string,
  context?: {
    filePath?: string;
    language?: string;
    framework?: string;
    errorType?: string;
  },
): FingerprintResult {
  // Tokenize once, pass to both extractFeatures and buildCanonical
  const tokens = tokenize(description);
  const features = extractFeatures(description, context, tokens);
  const canonical = buildCanonical(tokens, features);
  const hash = sha256(canonical);

  return { hash, canonical, tokens, features };
}

/**
 * Compute Jaccard similarity between two token sets.
 * Returns 0.0–1.0.
 */
export function jaccardSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;

  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Compute structural similarity between two feature sets.
 * Returns 0.0–1.0, weighted by feature importance.
 */
export function structuralSimilarity(
  a: ExtractedFeatures,
  b: ExtractedFeatures,
): number {
  let score = 0;
  let maxScore = 0;

  // Error type match is most important
  if (a.errorType || b.errorType) {
    maxScore += 4;
    if (a.errorType && b.errorType && a.errorType === b.errorType) score += 4;
  }

  // Same language
  if (a.language || b.language) {
    maxScore += 2;
    if (a.language && b.language && a.language === b.language) score += 2;
  }

  // Same framework
  if (a.framework || b.framework) {
    maxScore += 2;
    if (a.framework && b.framework && a.framework === b.framework) score += 2;
  }

  // Same file extension
  if (a.fileExtension || b.fileExtension) {
    maxScore += 1;
    if (a.fileExtension && b.fileExtension && a.fileExtension === b.fileExtension) score += 1;
  }

  // Keyword overlap (less weight per keyword, but cumulative)
  if (a.keywords.length > 0 && b.keywords.length > 0) {
    const kwOverlap = jaccardSimilarity(a.keywords, b.keywords);
    maxScore += 3;
    score += kwOverlap * 3;
  }

  return maxScore === 0 ? 0 : score / maxScore;
}

// ============================================================================
// Internal
// ============================================================================

function extractFeatures(
  text: string,
  context?: {
    filePath?: string;
    language?: string;
    framework?: string;
    errorType?: string;
  },
  precomputedTokens?: string[],
): ExtractedFeatures {
  const features: ExtractedFeatures = { keywords: [] };

  // Error type: from context or pattern matching
  if (context?.errorType) {
    features.errorType = context.errorType.toLowerCase();
  } else {
    for (const [pattern, replacement] of ERROR_TYPE_PATTERNS) {
      const match = text.match(pattern);
      if (match) {
        features.errorType = match[0].replace(pattern, replacement).toLowerCase();
        break;
      }
    }
  }

  // Error code extraction
  const codeMatch = text.match(/\b(?:error|code|E)\s*[:#]?\s*(\d{3,5})\b/i);
  if (codeMatch?.[1]) {
    features.errorCode = codeMatch[1];
  }

  // Language: from context, file extension, or content
  if (context?.language) {
    features.language = context.language.toLowerCase();
  } else if (context?.filePath) {
    const ext = context.filePath.split(".").pop()?.toLowerCase();
    if (ext && LANGUAGE_EXTENSIONS[ext]) {
      features.language = LANGUAGE_EXTENSIONS[ext];
    }
  }

  // Framework: from context or pattern matching
  if (context?.framework) {
    features.framework = context.framework.toLowerCase();
  } else {
    for (const [pattern, replacement] of FRAMEWORK_PATTERNS) {
      const match = text.match(pattern);
      if (match) {
        features.framework = match[0].replace(pattern, replacement).toLowerCase();
        break;
      }
    }
  }

  // File extension
  if (context?.filePath) {
    features.fileExtension = context.filePath.split(".").pop()?.toLowerCase();
  }

  // Keywords: important technical terms after stop-word removal
  const tokens = precomputedTokens ?? tokenize(text);
  features.keywords = tokens.filter(
    (t) => t.length > 2 && !STOP_WORDS.has(t),
  );

  return features;
}

/**
 * Tokenize text for similarity computation.
 * Handles camelCase, snake_case, kebab-case, file paths.
 */
function tokenize(text: string): string[] {
  // Split camelCase: "TypeError" → "type", "error"
  let expanded = text.replace(/([a-z])([A-Z])/g, "$1 $2");
  // Split snake_case and kebab-case
  expanded = expanded.replace(/[_-]+/g, " ");
  // Split on path separators
  expanded = expanded.replace(/[/\\]+/g, " ");
  // Remove non-alphanumeric (keep spaces)
  expanded = expanded.replace(/[^a-zA-Z0-9\s]/g, " ");
  // Lowercase and split
  const words = expanded.toLowerCase().split(/\s+/).filter(Boolean);
  // Deduplicate while preserving order
  return [...new Set(words)];
}

/** Build a canonical string from tokens and features, suitable for hashing. */
function buildCanonical(
  tokens: string[],
  features: ExtractedFeatures,
): string {
  const parts: string[] = [];

  if (features.errorType) parts.push(`err:${features.errorType}`);
  if (features.errorCode) parts.push(`code:${features.errorCode}`);
  if (features.language) parts.push(`lang:${features.language}`);
  if (features.framework) parts.push(`fw:${features.framework}`);

  // Add significant tokens (sorted for determinism)
  const significantTokens = tokens
    .filter((t) => !STOP_WORDS.has(t) && t.length > 2)
    .sort();

  parts.push(...significantTokens);

  return parts.join("|");
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
