/**
 * Demo-mode toggle — the single place that decides whether a dashboard
 * page should render the DataInfra Co fixture instead of real data.
 *
 *   1. Env: NEXT_PUBLIC_TRACEBASE_DEMO=1
 *      Persistent — set in `.env.local` to make every dashboard URL
 *      render demo data without a query param. Useful for screen
 *      recordings.
 *
 *   2. Query: ?demo=1 on any /dashboard URL
 *      Per-tab — flip the dashboard into demo mode for a single
 *      session without restarting the server. Useful for an ad-hoc
 *      "show me what it looks like with data" inside a meeting.
 *
 *   3. Env explicit off: NEXT_PUBLIC_TRACEBASE_DEMO=0
 *      Forces real-data mode even if `?demo=1` is in the URL. Useful
 *      for staging environments that want to be unambiguous.
 *
 * When demo mode is off, pages must fall back to their real data
 * source. The toggle does not fabricate data on its own — it only
 * tells callers which source to use.
 *
 * To remove demo mode entirely: delete this directory and grep for
 * `isDemoMode` to find the call sites — each is a 1-line revert to
 * "always use real data".
 */

const DEMO_QUERY_KEY = "demo";

function readEnvFlag(): "on" | "off" | "unset" {
  const raw = process.env.NEXT_PUBLIC_TRACEBASE_DEMO;
  if (raw === "1" || raw === "true") return "on";
  if (raw === "0" || raw === "false") return "off";
  return "unset";
}

/**
 * Resolve the demo flag for a server component. Pages call this with
 * their resolved `searchParams` (after `await`).
 *
 * Precedence:
 *   env=off   → always false
 *   env=on    → always true
 *   env=unset → check ?demo=1
 */
export function isDemoMode(input?: {
  searchParams?: Record<string, string | string[] | undefined> | null;
}): boolean {
  const envFlag = readEnvFlag();
  if (envFlag === "off") return false;
  if (envFlag === "on") return true;

  const sp = input?.searchParams;
  if (!sp) return false;
  const raw = sp[DEMO_QUERY_KEY];
  if (typeof raw === "string") return raw === "1" || raw === "true";
  if (Array.isArray(raw) && raw.length > 0) {
    const first = raw[0];
    return first === "1" || first === "true";
  }
  return false;
}

/**
 * Quick check for components/utilities that don't have a search-params
 * handle — only honors the env flag. Treats `unset` as off.
 */
export function isDemoModeFromEnv(): boolean {
  return readEnvFlag() === "on";
}

