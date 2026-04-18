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

/** Load configuration, merging file config with defaults. */
export function loadConfig(basePath?: string): TraceBaseConfig {
  const configDir = basePath
    ? join(basePath, CONFIG_DIR)
    : findConfigDir();

  if (!configDir) {
    // No config found — use defaults in cwd
    return defaultConfig(process.cwd());
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
