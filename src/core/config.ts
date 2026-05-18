import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import type { CascadeConfig, ExperimentConfig, HoldoutConfig, TraceBaseConfig } from "../types.js";

const CONFIG_DIR = ".tracebase";
const CONFIG_FILE = "config.json";
const DEFAULT_DB = "memory.db";
const PROJECT_MARKERS = [
  ".git",
  "package.json",
  "pnpm-workspace.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lockb",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "Gemfile",
] as const;

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
export function findConfigDir(
  startPath: string = process.cwd(),
  options?: { stopAt?: string | null },
): string | null {
  let current = startPath;
  const stopAt = options?.stopAt ?? null;

  // Walk up until we reach the filesystem root (dirname(x) === x).
  // A bare ~/.tracebase directory may hold global credentials or
  // hook dumps; only a directory with config.json is a project install.
  while (true) {
    const candidate = join(current, CONFIG_DIR);
    if (existsSync(join(candidate, CONFIG_FILE))) return candidate;
    if (stopAt && current === stopAt) break;

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
  const configDir = findConfigDir(searchFrom, {
    stopAt: findProjectBoundary(searchFrom),
  });
  const projectBase = resolveProjectBase(searchFrom);

  if (!configDir) {
    // No config found anywhere up the tree — defaults rooted at the
    // caller's basePath (or cwd).
    return defaultConfig(projectBase);
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
  const configDir = findConfigDir(startPath, {
    stopAt: findProjectBoundary(startPath),
  });
  return configDir ? dirname(configDir) : null;
}

/**
 * Resolve the directory that should be treated as the project base even
 * before TraceBase is initialized.
 *
 * This prevents commands from walking past a real repository / package
 * boundary and accidentally attaching to an unrelated parent `.tracebase/`
 * higher up the filesystem (for example `~/.tracebase`).
 */
export function resolveProjectBase(startPath: string = process.cwd()): string {
  return findProjectBoundary(startPath) ?? startPath;
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

  // Pick up any existing workspaceId / workspaceSalt so re-init
  // doesn't rotate them. Salt rotation would invalidate every
  // `arg_key` recorded in `tool_observations`, breaking duplicate /
  // loop detection across the boundary; identity stability wins.
  const existing = readExistingConfig(dir);
  const preservedWorkspaceId = existing?.workspaceId;
  const preservedWorkspaceSalt = existing?.workspaceSalt;

  const config: TraceBaseConfig = {
    ...defaultConfig(basePath),
    ...existing,
    workspaceId: preservedWorkspaceId ?? overrides?.workspaceId ?? randomUUID(),
    workspaceSalt:
      preservedWorkspaceSalt ?? overrides?.workspaceSalt ?? generateWorkspaceSalt(),
    ...overrides,
  };
  // `overrides` above may include workspaceId explicitly (tests); if the
  // existing file already had one, keep that — stable identity wins.
  if (preservedWorkspaceId) config.workspaceId = preservedWorkspaceId;
  if (preservedWorkspaceSalt) config.workspaceSalt = preservedWorkspaceSalt;

  const configFile = join(dir, CONFIG_FILE);
  const serializable: Record<string, unknown> = {
    workspaceId: config.workspaceId,
    workspaceSalt: config.workspaceSalt,
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
      ...(config.cloud.installationIds && Object.keys(config.cloud.installationIds).length > 0
        ? { installationIds: config.cloud.installationIds }
        : {}),
    };
  }

  if (config.install) {
    const normalizedAgents = normalizeInstallAgents(config.install);
    if (normalizedAgents.length > 0) {
      serializable["install"] = {
        agents: normalizedAgents,
        // Mirror the primary agent into the singular `agent` field so
        // older CLIs that only know about `install.agent` still work.
        agent: normalizedAgents[0],
      };
    }
  }

  if (config.experiment) {
    const serialized = serializeExperimentConfig(config.experiment);
    if (Object.keys(serialized).length > 0) {
      serializable["experiment"] = serialized;
    }
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
  return existsSync(join(basePath, CONFIG_DIR, CONFIG_FILE));
}

function findProjectBoundary(startPath: string): string | null {
  let current = startPath;

  while (true) {
    if (hasProjectMarker(current)) return current;

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
}

function hasProjectMarker(dir: string): boolean {
  return PROJECT_MARKERS.some((marker) => existsSync(join(dir, marker)));
}

/**
 * Return the list of adapters a project has wired up, normalizing across
 * the legacy single-agent schema (`install.agent`) and the current
 * multi-agent schema (`install.agents`). Duplicates removed, order
 * preserved.
 */
export function normalizeInstallAgents(
  install: { agents?: unknown; agent?: unknown } | undefined,
): Array<"claude-code" | "cursor" | "codex"> {
  if (!install) return [];
  const collected: Array<"claude-code" | "cursor" | "codex"> = [];
  const add = (raw: unknown) => {
    if (typeof raw !== "string") return;
    const trimmed = raw.trim();
    if (trimmed === "claude-code" || trimmed === "cursor" || trimmed === "codex") {
      if (!collected.includes(trimmed)) collected.push(trimmed);
    }
  };
  if (Array.isArray(install.agents)) {
    for (const item of install.agents) add(item);
  }
  add(install.agent);
  return collected;
}

/**
 * Rewrite `.tracebase/config.json` to record that `detached` is no
 * longer installed, without touching any other config fields. Used by
 * `tracebase remove --keep-store` so `status` and `doctor` stop
 * claiming a detached adapter is "configured but broken".
 *
 * Returns the agents that remain in the config after the detach.
 * If the config doesn't exist, or the project isn't initialized, this
 * is a no-op.
 */
export function detachInstallAgents(
  basePath: string,
  detached: Array<"claude-code" | "cursor" | "codex">,
): Array<"claude-code" | "cursor" | "codex"> {
  const configFile = join(basePath, CONFIG_DIR, CONFIG_FILE);
  if (!existsSync(configFile)) return [];

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(configFile, "utf-8")) as Record<string, unknown>;
  } catch {
    // Parse error — leave the file alone so `doctor` can report it
    // accurately instead of hiding the corruption.
    return [];
  }

  const current = normalizeInstallAgents(
    raw.install as { agents?: unknown; agent?: unknown } | undefined,
  );
  const detachedSet = new Set(detached);
  const remaining = current.filter((agent) => !detachedSet.has(agent));

  if (remaining.length === current.length) return remaining;

  if (remaining.length === 0) {
    // Leave an explicit "detached" sentinel instead of deleting the
    // field — that way `status` and `doctor` can tell "the user
    // removed every adapter" apart from "this is a legacy config
    // written before multi-agent existed", and avoid reinventing a
    // phantom default agent.
    raw.install = { agents: [] };
  } else {
    raw.install = {
      agents: remaining,
      agent: remaining[0],
    };
  }

  writeFileSync(configFile, JSON.stringify(raw, null, 2) + "\n");
  return remaining;
}

// ---------------------------------------------------------------------------
// Phase 3.4 — experiment configuration helpers
// ---------------------------------------------------------------------------

/** Default holdout rate used when `enable` is called with no --rate flag. */
export const DEFAULT_HOLDOUT_RATE = 0.1;

export interface EnableHoldoutInput {
  /** Holdout rate; must be in (0, 1]. Defaults to `DEFAULT_HOLDOUT_RATE`. */
  rate?: number;
  /** Injection point for tests. Produces the salt on first enable. */
  saltFactory?: () => string;
  /** Injection point for tests. */
  now?: () => Date;
}

/**
 * Enable the holdout experiment on this project.
 *
 * Idempotent and field-preserving:
 *   - If no config file exists yet, returns null and does NOT create
 *     one — `tracebase init` must run first.
 *   - If a prior holdout config exists, its `salt` and `createdAt`
 *     are preserved; `rate`, `enabled`, and `updatedAt` are
 *     refreshed. Repeat enables with the same rate are no-ops
 *     except for `updatedAt`.
 *   - Every other config field (workspaceId, cloud, install, …) is
 *     left exactly as-is. This is a targeted rewrite, not a
 *     full-config regeneration.
 */
export function enableHoldoutExperiment(
  basePath: string,
  input: EnableHoldoutInput = {},
): HoldoutConfig | null {
  const rate = input.rate ?? DEFAULT_HOLDOUT_RATE;
  if (!Number.isFinite(rate) || rate <= 0 || rate > 1) {
    throw new Error(`holdout rate must be in (0, 1]; got ${rate}`);
  }
  const nowIso = (input.now ?? (() => new Date()))().toISOString();
  const raw = readConfigFileRaw(basePath);
  if (raw === null) return null;

  const existing = extractHoldoutConfig(raw);
  const saltFactory = input.saltFactory ?? generateHoldoutSalt;
  const next: HoldoutConfig = {
    enabled: true,
    rate,
    salt: existing?.salt ?? saltFactory(),
    createdAt: existing?.createdAt ?? nowIso,
    updatedAt: nowIso,
  };
  writeExperimentField(basePath, raw, { holdout: next });
  return next;
}

/**
 * Disable the holdout experiment on this project, preserving the
 * salt and `createdAt` for future re-enables. Idempotent:
 *   - No config → returns null.
 *   - No experiment field → returns null.
 *   - Already disabled → refreshes `updatedAt`, returns the config.
 *   - Enabled → flips to disabled.
 */
export function disableHoldoutExperiment(
  basePath: string,
  input: { now?: () => Date } = {},
): HoldoutConfig | null {
  const raw = readConfigFileRaw(basePath);
  if (raw === null) return null;
  const existing = extractHoldoutConfig(raw);
  if (!existing) return null;
  const nowIso = (input.now ?? (() => new Date()))().toISOString();
  const next: HoldoutConfig = {
    ...existing,
    enabled: false,
    updatedAt: nowIso,
  };
  writeExperimentField(basePath, raw, { holdout: next });
  return next;
}

/**
 * Read the current holdout config from disk, or `null` if the
 * project has never configured one (or the stored payload is
 * malformed). This helper is the authoritative "is holdout
 * configured here?" query for the CLI and for serving integration
 * via `buildHoldoutInput`.
 */
export function readHoldoutConfig(basePath: string): HoldoutConfig | null {
  const raw = readConfigFileRaw(basePath);
  if (raw === null) return null;
  return extractHoldoutConfig(raw);
}

/**
 * Read the current cascade config from disk, or `null` if the project
 * has never configured one (or the stored payload is malformed). May-
 * 2026 B1.2 — called fresh on every `get_reasoning_patterns` MCP call
 * so `tracebase cascade enable|set-rate|disable` takes effect without
 * restarting the server, matching the holdout config lifecycle.
 *
 * Storage lives under the existing `experiment` object in
 * `.tracebase/config.json` as a sibling of `holdout` — keeping every
 * runtime-tunable experimental knob under one roof. Malformed
 * fields collapse to `null` so a corrupted disk write can never
 * promote the cascade to a state worse than "off".
 */
export function readCascadeConfig(basePath: string): CascadeConfig | null {
  const raw = readConfigFileRaw(basePath);
  if (raw === null) return null;
  return extractCascadeConfig(raw);
}

function readConfigFileRaw(basePath: string): Record<string, unknown> | null {
  const configFile = join(basePath, CONFIG_DIR, CONFIG_FILE);
  if (!existsSync(configFile)) return null;
  try {
    return JSON.parse(readFileSync(configFile, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function writeExperimentField(
  basePath: string,
  raw: Record<string, unknown>,
  experiment: ExperimentConfig,
): void {
  const serialized = serializeExperimentConfig(experiment);
  if (Object.keys(serialized).length === 0) {
    delete raw.experiment;
  } else {
    raw.experiment = serialized;
  }
  const configFile = join(basePath, CONFIG_DIR, CONFIG_FILE);
  writeFileSync(configFile, JSON.stringify(raw, null, 2) + "\n");
}

function serializeExperimentConfig(exp: ExperimentConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (exp.holdout) {
    out.holdout = {
      enabled: exp.holdout.enabled,
      rate: exp.holdout.rate,
      salt: exp.holdout.salt,
      createdAt: exp.holdout.createdAt,
      updatedAt: exp.holdout.updatedAt,
    };
  }
  return out;
}

function extractHoldoutConfig(raw: Record<string, unknown>): HoldoutConfig | null {
  const exp = raw.experiment;
  if (!exp || typeof exp !== "object") return null;
  const holdout = (exp as Record<string, unknown>).holdout;
  if (!holdout || typeof holdout !== "object") return null;
  const h = holdout as Record<string, unknown>;
  if (
    typeof h.enabled !== "boolean" ||
    typeof h.rate !== "number" ||
    typeof h.salt !== "string" ||
    typeof h.createdAt !== "string" ||
    typeof h.updatedAt !== "string"
  ) {
    return null;
  }
  return {
    enabled: h.enabled,
    rate: h.rate,
    salt: h.salt,
    createdAt: h.createdAt,
    updatedAt: h.updatedAt,
  };
}

function generateHoldoutSalt(): string {
  // 16 random bytes = 128 bits of entropy; hex-encoded for
  // config-file readability. The salt's only job is to make
  // `shouldHoldOut` unpredictable per-workspace; no cryptographic
  // strength requirement beyond "not guessable across workspaces".
  return randomBytes(16).toString("hex");
}

/**
 * Pull a CascadeConfig out of the raw `experiment.cascade` block.
 * Each field is type-checked; any malformed value collapses the
 * whole config to `null` so we fall back to the safe sync path
 * rather than running with a half-parsed cascade state.
 */
function extractCascadeConfig(raw: Record<string, unknown>): CascadeConfig | null {
  const exp = raw.experiment;
  if (!exp || typeof exp !== "object") return null;
  const cascade = (exp as Record<string, unknown>).cascade;
  if (!cascade || typeof cascade !== "object") return null;
  const c = cascade as Record<string, unknown>;

  if (typeof c.enabled !== "boolean") return null;
  if (typeof c.createdAt !== "string") return null;
  if (typeof c.updatedAt !== "string") return null;

  const rollout = c.rollout;
  if (!rollout || typeof rollout !== "object") return null;
  const r = rollout as Record<string, unknown>;
  if (typeof r.rate !== "number" || !Number.isFinite(r.rate)) return null;
  if (typeof r.salt !== "string") return null;

  const reranker = c.reranker;
  if (!reranker || typeof reranker !== "object") return null;
  const rr = reranker as Record<string, unknown>;
  if (
    rr.kind !== "noop" &&
    rr.kind !== "cloud" &&
    rr.kind !== "minilm" &&
    rr.kind !== "bge-v2-m3"
  ) {
    return null;
  }
  if (rr.endpoint !== undefined && typeof rr.endpoint !== "string") return null;
  if (rr.apiKey !== undefined && typeof rr.apiKey !== "string") return null;
  if (rr.model !== undefined && typeof rr.model !== "string") return null;

  if (c.timeoutMs !== undefined && (typeof c.timeoutMs !== "number" || !Number.isFinite(c.timeoutMs))) return null;
  if (c.mmrLambda !== undefined && (typeof c.mmrLambda !== "number" || !Number.isFinite(c.mmrLambda))) return null;
  if (c.fetchMultiplier !== undefined && (typeof c.fetchMultiplier !== "number" || !Number.isFinite(c.fetchMultiplier))) return null;

  return {
    enabled: c.enabled,
    rollout: { rate: r.rate, salt: r.salt },
    reranker: {
      kind: rr.kind,
      ...(rr.endpoint ? { endpoint: rr.endpoint } : {}),
      ...(rr.apiKey ? { apiKey: rr.apiKey } : {}),
      ...(rr.model ? { model: rr.model } : {}),
    },
    ...(c.timeoutMs !== undefined ? { timeoutMs: c.timeoutMs as number } : {}),
    ...(c.mmrLambda !== undefined ? { mmrLambda: c.mmrLambda as number } : {}),
    ...(c.fetchMultiplier !== undefined ? { fetchMultiplier: c.fetchMultiplier as number } : {}),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// 0.5.3 — workspace salt (HMAC key for tool_observations.arg_key)
// ---------------------------------------------------------------------------

/** 32 random bytes hex-encoded — 256 bits of entropy for HMAC keys. */
function generateWorkspaceSalt(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Read the workspace salt for the project rooted at `basePath`. Lazy-
 * mints + persists if missing (legacy installs written before 0.5.3).
 *
 * Returns `null` when:
 *   - the project is not initialized (no `.tracebase/config.json`), or
 *   - the file exists but is unreadable / unparseable, or
 *   - mint succeeded but the persistence write failed (caller falls
 *     back to a deterministic in-memory key — the salt is mostly a
 *     local-clustering helper, not a security boundary, and a hook
 *     that briefly can't write must not crash).
 *
 * Stable across calls within the same install; never rotates.
 */
export function getOrMintWorkspaceSalt(basePath: string): string | null {
  const configFile = join(basePath, CONFIG_DIR, CONFIG_FILE);
  if (!existsSync(configFile)) return null;

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(configFile, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }

  const stored = raw.workspaceSalt;
  if (typeof stored === "string" && stored.length > 0) return stored;

  const minted = generateWorkspaceSalt();
  raw.workspaceSalt = minted;
  try {
    writeFileSync(configFile, JSON.stringify(raw, null, 2) + "\n");
  } catch {
    // Read-only filesystem or transient I/O — caller decides whether
    // to fail the operation or continue with the in-memory salt.
    return null;
  }
  return minted;
}
