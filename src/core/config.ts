import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import type { TraceBaseConfig } from "../types.js";

const CONFIG_DIR = ".tracebase";
const CONFIG_FILE = "config.json";
const DEFAULT_DB = "memory.db";

/** Default configuration. */
export function defaultConfig(basePath: string): TraceBaseConfig {
  const dir = join(basePath, CONFIG_DIR);
  return {
    storagePath: join(dir, DEFAULT_DB),
    maxTraces: 100_000,
    pruneThreshold: 0.05,
    verbose: false,
  };
}

/** Resolve the config directory, searching up from cwd to filesystem root. */
export function findConfigDir(startPath: string = process.cwd()): string | null {
  let current = startPath;

  // Walk up until we reach the filesystem root (dirname(x) === x)
  while (true) {
    const candidate = join(current, CONFIG_DIR);
    if (existsSync(candidate)) return candidate;

    const parent = dirname(current);
    if (parent === current) break; // reached root
    current = parent;
  }

  return null;
}

/**
 * Load configuration, merging file config with defaults.
 *
 * Resolution rule (important — both arms walk up the filesystem):
 *   • If `basePath` is given, search up from it for `.tracebase/`.
 *     Running from a nested cwd must still find the project-root
 *     install, not pretend an empty install lives in the subdirectory.
 *   • If `basePath` is omitted, search up from `process.cwd()`.
 *   • If no `.tracebase/` is found anywhere, return defaults rooted at
 *     the passed `basePath` (or cwd) — this is the "not yet initialized"
 *     state and the caller decides what to do about it.
 *
 * Parse errors on `config.json` fall through to defaults, preserving
 * the forgiving runtime contract. Deep integrity checks (doctor) must
 * NOT rely on this function for corruption detection — they should
 * read the config file directly and surface the parse error.
 */
export function loadConfig(basePath?: string): TraceBaseConfig {
  const searchFrom = basePath ?? process.cwd();
  const configDir = findConfigDir(searchFrom);

  if (!configDir) {
    // No config found anywhere up the tree — defaults rooted at the
    // caller's basePath (or cwd).
    return defaultConfig(searchFrom);
  }

  const configFile = join(configDir, CONFIG_FILE);
  const defaults = defaultConfig(dirname(configDir));

  if (!existsSync(configFile)) return defaults;

  try {
    const raw = readFileSync(configFile, "utf-8");
    const parsed = JSON.parse(raw) as Partial<TraceBaseConfig>;
    return { ...defaults, ...parsed };
  } catch {
    return defaults;
  }
}

/**
 * Return the resolved project root for a given start path — i.e. the
 * directory that contains the `.tracebase/` config dir (walked up
 * from `startPath`). Returns null when no install exists up the tree.
 *
 * Used by commands that need to read files OUTSIDE `.tracebase/` but
 * still rooted at the project (`.claude/settings.json`, `CLAUDE.md`)
 * so they work correctly from nested subdirectories.
 */
export function findProjectRoot(startPath: string = process.cwd()): string | null {
  const configDir = findConfigDir(startPath);
  return configDir ? dirname(configDir) : null;
}

/**
 * Initialize a new TraceBase config directory. Idempotent:
 *   - Running on a fresh directory creates .tracebase/ and writes a
 *     config with a freshly-generated workspaceId.
 *   - Running on an already-initialized directory preserves the
 *     existing workspaceId (it's a stable identifier, re-init must
 *     not rotate it) and merges any new `overrides`.
 */
export function initConfig(
  basePath: string,
  overrides?: Partial<TraceBaseConfig>,
): TraceBaseConfig {
  const dir = join(basePath, CONFIG_DIR);
  mkdirSync(dir, { recursive: true });

  // Pick up any existing workspaceId so re-init doesn't rotate it.
  const existing = readExistingConfig(dir);
  const preservedWorkspaceId = existing?.workspaceId;

  const config: TraceBaseConfig = {
    ...defaultConfig(basePath),
    ...existing,
    workspaceId: preservedWorkspaceId ?? overrides?.workspaceId ?? randomUUID(),
    ...overrides,
  };
  // `overrides` above may include workspaceId explicitly (tests); if the
  // existing file already had one, keep that — stable identity wins.
  if (preservedWorkspaceId) config.workspaceId = preservedWorkspaceId;

  const configFile = join(dir, CONFIG_FILE);
  const serializable: Record<string, unknown> = {
    workspaceId: config.workspaceId,
    storagePath: config.storagePath,
    maxTraces: config.maxTraces,
    pruneThreshold: config.pruneThreshold,
    verbose: config.verbose,
  };

  if (config.embeddings) {
    serializable["embeddings"] = {
      provider: config.embeddings.provider,
      model: config.embeddings.model,
      dimensions: config.embeddings.dimensions,
    };
  }

  if (config.cloud) {
    serializable["cloud"] = {
      apiUrl: config.cloud.apiUrl,
      workspaceId: config.cloud.workspaceId,
      ...(config.cloud.workspaceSlug ? { workspaceSlug: config.cloud.workspaceSlug } : {}),
      ...(config.cloud.installationId ? { installationId: config.cloud.installationId } : {}),
    };
  }

  writeFileSync(configFile, JSON.stringify(serializable, null, 2) + "\n");
  return config;
}

/** Read an existing on-disk config (or null if none). Internal use. */
function readExistingConfig(configDir: string): Partial<TraceBaseConfig> | null {
  const file = join(configDir, CONFIG_FILE);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as Partial<TraceBaseConfig>;
  } catch {
    return null;
  }
}

/** Check if TraceBase is initialized in the given directory. */
export function isInitialized(basePath: string = process.cwd()): boolean {
  return existsSync(join(basePath, CONFIG_DIR));
}
