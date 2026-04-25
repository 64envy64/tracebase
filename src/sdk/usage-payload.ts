/**
 * Shared aggregate-sync payload builder (PLAN-0.5.4 §5.3 +
 * 0.5.5 §1).
 *
 * Both surfaces — `tracebase usage sync --once` and the auto-sync
 * coordinator (`src/sdk/sync-coordinator.ts`) — call this module
 * to assemble the `SyncSendInput` they post. Centralising the
 * payload assembly here means:
 *
 *   1. The privacy guarantee (everything goes through
 *      `sanitizeForCloud` before the wire) is enforced in one
 *      place — neither caller can construct a payload that
 *      bypasses the allowlist.
 *
 *   2. The CLI and the coordinator stay in lock-step: when one
 *      release adds an aggregate field to `UsageMetrics`, both
 *      surfaces pick it up automatically.
 *
 *   3. UX divergence is explicit: `checkSyncReadiness` returns a
 *      discriminated `{ ok, reason }` shape so the CLI can render
 *      a colour-coded error and exit-code-1 while the coordinator
 *      silently no-ops on the same reason. The reasons themselves
 *      are stable identifiers — neither path translates them.
 *
 * Privacy invariant (PLAN-0.5.4 §2.2): the cloud allowlist
 * forbids prompts / responses / tool bodies / argSummary /
 * argKey / sessionId / file paths / code / transcript text /
 * `tool_observations` rows / project-fact / digest / block body
 * fields. Everything that ships goes through `sanitizeForCloud`
 * BEFORE the fetch — this module's `pushSampleToCloud` is the
 * single egress point.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { BlockStore } from "../core/block-store.js";
import { computeAggregates } from "../core/analytics.js";
import { computeUsageMetrics, type UsageMetrics } from "../analytics/usage-metrics.js";
import { loadConfig, findConfigDir } from "../core/config.js";
import { loadCloudCredential, normalizeApiUrl } from "../cli/cloud.js";
import { sanitizeForCloud } from "../cli/cloud-allowlist.js";
import type { SyncSendInput, SyncSendResult } from "./sync-coordinator.js";

// ---------------------------------------------------------------------------
// Readiness check
// ---------------------------------------------------------------------------

export type SyncReadinessFailReason =
  | "not-initialized"
  | "no-cloud-link"
  | "no-installation-id"
  | "no-api-key"
  | "no-storage";

export interface SyncReadiness {
  /** Resolved API URL, normalised. */
  apiUrl: string;
  /** Bearer key for the workspace. Empty string when `allowMissingApiKey` and no key found. */
  apiKey: string;
  installationId: string;
  workspaceId: string;
  /** Path to `.tracebase/memory.db`. May not exist yet — see `no-storage`. */
  storagePath: string;
  /** Resolved tracebase-ai package version. */
  cliVersion: string;
}

export type SyncReadinessResult =
  | { ok: true; readiness: SyncReadiness }
  | { ok: false; reason: SyncReadinessFailReason };

export interface CheckReadinessOptions {
  /** CLI flag override for apiUrl. */
  apiUrlOverride?: string;
  /** CLI flag override for apiKey. */
  apiKeyOverride?: string;
  /**
   * `--dry-run` mode: skip the api-key check so the CLI can
   * preview a sample without a real workspace key. Coordinator
   * never sets this.
   */
  allowMissingApiKey?: boolean;
}

/**
 * Single up-front validation. Cheap (a few file reads); both the
 * CLI and the coordinator can call it once per cycle.
 *
 * Reason ordering matches the CLI's existing flow so both surfaces
 * report the same first failure for a given config:
 *
 *   not-initialized → no-cloud-link → no-installation-id →
 *   no-api-key → no-storage
 */
export function checkSyncReadiness(
  basePath: string,
  options: CheckReadinessOptions = {},
): SyncReadinessResult {
  const configDir = findConfigDir(basePath);
  if (!configDir) return { ok: false, reason: "not-initialized" };

  const cfg = loadConfig(basePath);
  if (!cfg.cloud?.workspaceId) return { ok: false, reason: "no-cloud-link" };

  const primaryAgent = cfg.install?.agents?.[0] ?? "claude-code";
  const installationId =
    cfg.cloud.installationIds?.[primaryAgent] ?? cfg.cloud.installationId ?? "";
  if (!installationId) return { ok: false, reason: "no-installation-id" };

  const apiUrl = normalizeApiUrl(options.apiUrlOverride ?? cfg.cloud.apiUrl);
  const apiKey =
    options.apiKeyOverride?.trim() ||
    process.env.TRACEBASE_API_KEY?.trim() ||
    loadCloudCredential(apiUrl, cfg.cloud.workspaceId) ||
    "";

  if (!apiKey && !options.allowMissingApiKey) {
    return { ok: false, reason: "no-api-key" };
  }

  if (!existsSync(cfg.storagePath)) {
    return { ok: false, reason: "no-storage" };
  }

  return {
    ok: true,
    readiness: {
      apiUrl,
      apiKey,
      installationId,
      workspaceId: cfg.cloud.workspaceId,
      storagePath: cfg.storagePath,
      cliVersion: resolveCliVersion(),
    },
  };
}

// ---------------------------------------------------------------------------
// Per-window payload builder
// ---------------------------------------------------------------------------

export type BuildWindowPayloadResult =
  | { ok: true; input: SyncSendInput }
  | { ok: false; reason: "empty-window" };

/**
 * Build a `SyncSendInput` for one window. Caller owns the
 * BlockStore handle so the CLI's bucket loop can share one
 * read-only connection across many calls; the coordinator opens
 * one per cycle.
 *
 * Returns `empty-window` when the window has no eligible runs —
 * the CLI logs "skipped (empty)", the coordinator silently
 * advances. No payload is ever returned with
 * `metrics.observed.eligibleRuns === 0`; sending zero-rows would
 * spam the dashboard with empty samples for every quiet hour.
 */
export function buildWindowPayload(
  readiness: SyncReadiness,
  store: BlockStore,
  afterTs: number,
  beforeTs: number,
): BuildWindowPayloadResult {
  const agg = computeAggregates(store, { afterTs, beforeTs });
  const metrics: UsageMetrics = computeUsageMetrics(agg);
  if (metrics.observed.eligibleRuns === 0) {
    return { ok: false, reason: "empty-window" };
  }
  return {
    ok: true,
    input: {
      apiUrl: readiness.apiUrl,
      apiKey: readiness.apiKey,
      installationId: readiness.installationId,
      windowStart: new Date(afterTs).toISOString(),
      windowEnd: new Date(beforeTs).toISOString(),
      metrics,
      cliVersion: readiness.cliVersion,
    },
  };
}

/**
 * Convenience: combine readiness check + per-window build for the
 * coordinator's hot path. Returns `null` on any non-ok case
 * because the coordinator doesn't surface fail-reasons to the
 * caller (they get logged via the dirty bit's reason string at
 * markDirty time, never escalated to user-facing errors).
 */
export async function buildSendInputForWindow(
  basePath: string,
  afterTs: number,
  beforeTs: number,
  options: CheckReadinessOptions = {},
): Promise<SyncSendInput | null> {
  const readiness = checkSyncReadiness(basePath, options);
  if (!readiness.ok) return null;

  const db = new Database(readiness.readiness.storagePath, { readonly: true });
  const store = new BlockStore(db, { skipMigrate: true });
  try {
    const payload = buildWindowPayload(
      readiness.readiness,
      store,
      afterTs,
      beforeTs,
    );
    if (!payload.ok) return null;
    return payload.input;
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// HTTP sender — the single network egress point
// ---------------------------------------------------------------------------

/**
 * Production sender. Wired into the coordinator via
 * `createSyncCoordinator(layer, options, { send: pushSampleToCloud })`
 * and used directly by the `tracebase usage sync` CLI command.
 *
 * Invariants:
 *   - `sanitizeForCloud` runs on every payload before the fetch.
 *     A field that sneaks past the type system gets stripped here.
 *   - Network failures resolve with `{ ok: false, status: 0,
 *     reason }` — they never throw into caller code.
 *   - Returns the HTTP status so the coordinator's backoff /
 *     CLI's per-bucket logging can render the right thing.
 */
export const pushSampleToCloud = async (
  input: SyncSendInput,
): Promise<SyncSendResult> => {
  try {
    const safeBody = sanitizeForCloud({
      installationId: input.installationId,
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
      metrics: input.metrics,
      cliVersion: input.cliVersion,
    });
    const res = await fetch(`${input.apiUrl}/api/control-plane/usage-samples`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(safeBody),
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
};

// ---------------------------------------------------------------------------
// Internal — package version
// ---------------------------------------------------------------------------

/**
 * Resolve the published `tracebase-ai` version. Used in the
 * `cliVersion` field of every cloud sample so the dashboard can
 * filter / debug by client release.
 *
 * Walks up from this module's location to find the nearest
 * `package.json` — works whether the SDK is imported from
 * `dist/` (published) or `src/` (dev / vitest).
 */
function resolveCliVersion(): string {
  try {
    // ESM-safe `__dirname` substitute. tsup CJS build leaves the
    // CommonJS form as-is, ESM build rewrites to `import.meta.url`.
    const here =
      typeof __dirname !== "undefined"
        ? __dirname
        : dirname(fileURLToPath(import.meta.url));
    // src/sdk/usage-payload.ts → ../../ for src/
    // dist/index.js (bundled) → ../ for dist/
    const candidates = [
      join(here, "..", "..", "package.json"),
      join(here, "..", "package.json"),
      join(here, "package.json"),
    ];
    for (const c of candidates) {
      if (!existsSync(c)) continue;
      const pkg = JSON.parse(readFileSync(c, "utf-8")) as { name?: string; version?: string };
      if (pkg.name === "tracebase-ai" && typeof pkg.version === "string") {
        return pkg.version;
      }
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}
