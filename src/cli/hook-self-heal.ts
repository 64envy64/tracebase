/**
 * `ensureManagedHooksCurrent` — zero-friction hook self-heal entry
 * point (PLAN-0.5.6 §1).
 *
 * Called from every runtime hook command (inject-context /
 * capture-turn / capture-context / capture-tool-use) AFTER the
 * `isInitialized(basePath)` gate. Best-effort, throttled, and
 * silent — exists so a project that ran `npx tracebase-ai init`
 * once on an old release picks up new managed hooks
 * (e.g. PostToolBatch landing in 0.5.3) without forcing the user
 * to re-run init.
 *
 * Hot-path constraints (PLAN-0.5.6 §4):
 *   - JSON read/write only — no fetch, no spawn, no SQLite.
 *   - Throttled to AT MOST once per 24h per project, OR once per
 *     `tracebase-ai` package-version change. Marker lives in
 *     `.tracebase/hook-health.json`.
 *   - Errors swallowed by default; surfaced on stderr only when
 *     `TRACEBASE_DEBUG` is truthy.
 *   - The runtime command's envelope contract is intact even if
 *     this fails — caller treats the result as a side-channel.
 *
 * Trust boundary (PLAN-0.5.6 §5):
 *   Reuses `selfHealClaudeHookConfig` in `install-targets.ts`,
 *   which uses the same `CLAUDE_HOOK_SPECS` + `legacyDefaults` +
 *   `deepEqual` logic the explicit `init` write path uses. Custom
 *   entries are left alone; foreign hooks are never touched.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  selfHealClaudeHookConfig,
  type HookEventName,
  type InstallAgent,
  type SelfHealHookResult,
} from "./install-targets.js";

/**
 * Marker file's path inside the project. Separate from
 * `config.json` so re-init / cloud link changes don't bump the
 * self-heal cadence.
 */
const HEALTH_FILE_REL = ".tracebase/hook-health.json";

/** Default throttle. 24h between full re-checks of an unchanged version. */
const DEFAULT_THROTTLE_MS = 24 * 60 * 60 * 1000;

export interface EnsureManagedHooksOptions {
  /**
   * Override the throttle window in ms. Tests pass small values
   * (or 0 to disable) so they don't have to wait 24h between
   * runs.
   */
  throttleMs?: number;
  /**
   * Override `Date.now()` for deterministic tests.
   */
  now?: () => number;
  /**
   * Override the package-version sentinel. Production reads from
   * the published `tracebase-ai` package; tests pass a literal so
   * they can simulate version-change bypasses.
   */
  packageVersion?: string;
  /**
   * If true, force a self-heal even if the throttle window
   * hasn't elapsed and the version hasn't changed. The runtime
   * never sets this — `tracebase init` does, and tests do for
   * deterministic coverage.
   */
  force?: boolean;
}

export interface EnsureManagedHooksResult {
  /** True iff a self-heal pass was attempted (throttle bypassed). */
  attempted: boolean;
  /** Reason the call was throttled. Set when `attempted=false`. */
  throttledReason?: "fresh-marker" | "version-stable";
  /** Inner self-heal result when `attempted=true`. */
  selfHeal?: SelfHealHookResult;
  /** Loaded marker after the call. */
  health?: HookHealthMarker;
}

export interface HookHealthMarker {
  /** Wall-clock ms when the most recent self-heal attempt ran. */
  lastSelfHealAt?: number;
  /** Package version that produced the most recent attempt. */
  lastSeenPackageVersion?: string;
  /** Per-event names that were skipped because they're customised. */
  lastSkippedCustom?: HookEventName[];
  /**
   * Wall-clock ms when the most recent self-heal call actually
   * wrote to `.claude/settings.json`. Used by doctor to render an
   * "INFO recently self-healed" status without re-walking the
   * file.
   */
  lastWrittenAt?: number;
  /** Per-event names included in the most recent write. */
  lastUpdated?: HookEventName[];
}

/**
 * Best-effort self-heal of `.claude/settings.json` for the project
 * at `basePath`. Returns a small result object; never throws.
 *
 * `agent` defaults to `claude-code` because that's the only host
 * with a settings.json surface today. Cursor / Codex have no
 * managed hook surface, so the function short-circuits to
 * `attempted=false` for them.
 */
export function ensureManagedHooksCurrent(
  basePath: string,
  agent: InstallAgent = "claude-code",
  opts: EnsureManagedHooksOptions = {},
): EnsureManagedHooksResult {
  if (agent !== "claude-code") {
    return { attempted: false, throttledReason: "version-stable" };
  }

  const now = opts.now ?? Date.now;
  const throttleMs = opts.throttleMs ?? DEFAULT_THROTTLE_MS;
  const version = opts.packageVersion ?? resolvePackageVersion();

  const health = readHealth(basePath);

  // Throttle gate. Two ways to bypass:
  //   1. `force: true` — only `tracebase init` and tests pass it.
  //   2. Version drift — installed package bumped since the last
  //      self-heal, so a new managed event might exist (e.g.
  //      0.5.2 → 0.5.3 added PostToolBatch).
  const versionChanged = health.lastSeenPackageVersion !== version;
  const elapsed = now() - (health.lastSelfHealAt ?? 0);
  if (!opts.force && !versionChanged && elapsed < throttleMs) {
    return { attempted: false, throttledReason: "fresh-marker", health };
  }

  const result = selfHealClaudeHookConfig(basePath);

  // Persist marker even on no-op so subsequent calls within the
  // window short-circuit. Errors writing the marker are swallowed
  // — worst case the throttle re-fires next call, which still
  // does cheap JSON reads only.
  const newHealth: HookHealthMarker = {
    ...health,
    lastSelfHealAt: now(),
    lastSeenPackageVersion: version,
    lastSkippedCustom: result.skippedCustom,
  };
  if (result.fileWritten) {
    newHealth.lastWrittenAt = now();
    newHealth.lastUpdated = result.updated;
  }
  writeHealth(basePath, newHealth);

  if (result.error) debugLog(`self-heal error: ${result.error}`);

  return { attempted: true, selfHeal: result, health: newHealth };
}

/**
 * Read the current marker. Returns `{}` for any failure mode
 * (file absent, malformed JSON, IO error). The throttle then
 * treats the project as "never healed yet" and runs immediately.
 */
export function readHookHealth(basePath: string): HookHealthMarker {
  return readHealth(basePath);
}

// ---------------------------------------------------------------------------
// Internal — marker file + version + debug
// ---------------------------------------------------------------------------

function readHealth(basePath: string): HookHealthMarker {
  const filePath = join(basePath, HEALTH_FILE_REL);
  if (!existsSync(filePath)) return {};
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return {};
    const out: HookHealthMarker = {};
    if (typeof parsed.lastSelfHealAt === "number") {
      out.lastSelfHealAt = parsed.lastSelfHealAt;
    }
    if (typeof parsed.lastSeenPackageVersion === "string") {
      out.lastSeenPackageVersion = parsed.lastSeenPackageVersion;
    }
    if (Array.isArray(parsed.lastSkippedCustom)) {
      out.lastSkippedCustom = parsed.lastSkippedCustom.filter(
        (s): s is HookEventName => typeof s === "string",
      ) as HookEventName[];
    }
    if (typeof parsed.lastWrittenAt === "number") {
      out.lastWrittenAt = parsed.lastWrittenAt;
    }
    if (Array.isArray(parsed.lastUpdated)) {
      out.lastUpdated = parsed.lastUpdated.filter(
        (s): s is HookEventName => typeof s === "string",
      ) as HookEventName[];
    }
    return out;
  } catch {
    return {};
  }
}

function writeHealth(basePath: string, marker: HookHealthMarker): void {
  const filePath = join(basePath, HEALTH_FILE_REL);
  try {
    mkdirSync(join(basePath, ".tracebase"), { recursive: true });
    writeFileSync(filePath, JSON.stringify(marker, null, 2) + "\n");
  } catch {
    // best-effort — the throttle still functions on the next read
    // attempt; we just lose the marker for this cycle.
  }
}

let cachedVersion: string | null = null;

function resolvePackageVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  // Walk up from this module to find the nearest `package.json`
  // owned by `tracebase-ai`. Same heuristic
  // `src/sdk/usage-payload.ts:resolveCliVersion` uses; kept
  // separate here so a future split doesn't entangle the two
  // callers.
  try {
    const { join } = require("node:path") as typeof import("node:path");
    const { existsSync, readFileSync } = require("node:fs") as typeof import("node:fs");
    const here = typeof __dirname !== "undefined" ? __dirname : process.cwd();
    const candidates = [
      join(here, "..", "..", "package.json"),
      join(here, "..", "package.json"),
      join(here, "package.json"),
    ];
    for (const p of candidates) {
      if (!existsSync(p)) continue;
      const pkg = JSON.parse(readFileSync(p, "utf-8")) as { name?: string; version?: string };
      if (pkg.name === "tracebase-ai" && typeof pkg.version === "string") {
        cachedVersion = pkg.version;
        return pkg.version;
      }
    }
  } catch {
    // fall through
  }
  cachedVersion = "unknown";
  return "unknown";
}

function debugLog(msg: string): void {
  if (!process.env.TRACEBASE_DEBUG) return;
  try {
    process.stderr.write(`tracebase hook-self-heal: ${msg}\n`);
  } catch {
    // even stderr can fail in some sandboxes — swallow
  }
}
