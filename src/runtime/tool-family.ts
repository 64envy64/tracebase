/**
 * `toolFamily` — local mapping from a literal tool name to the
 * eight-family normalised vocabulary the cloud allowlist permits.
 *
 * Why this matters (PLAN-0.5.4 §6, amended): literal Claude Code
 * tool names (`Read`, `Grep`, `Bash`, …) are host-specific
 * vocabulary. Shipping them to the control plane verbatim would
 * leak the host's tool catalogue and force the cloud schema to
 * stay synchronised with every Claude Code release.
 *
 * The eight families below are a frozen vocabulary the cloud
 * understands. New tools always map into one of these slots; never
 * add a new slot in 0.5.x without updating the cloud schema and
 * the allowlist together.
 *
 * Critical privacy invariant: an unknown tool name (e.g. a future
 * `FuturisticMystery` tool) maps to `"other"` — the literal name
 * NEVER reaches the wire. Tested in
 * `tests/runtime/tool-family.test.ts`.
 */

export type ToolFamily =
  | "read"
  | "search"
  | "shell"
  | "edit"
  | "write"
  | "web"
  | "task"
  | "other";

/** Frozen vocabulary the cloud allowlist permits. Keep in sync with TOOL_FAMILY_SPEC. */
export const TOOL_FAMILIES: readonly ToolFamily[] = [
  "read",
  "search",
  "shell",
  "edit",
  "write",
  "web",
  "task",
  "other",
] as const;

export function toolFamily(toolName: string): ToolFamily {
  switch (toolName) {
    case "Read":
      return "read";
    case "Grep":
    case "Glob":
      return "search";
    case "Bash":
      return "shell";
    case "Edit":
    case "NotebookEdit":
      return "edit";
    case "Write":
      return "write";
    case "WebFetch":
    case "WebSearch":
      return "web";
    case "Task":
    case "Skill":
      return "task";
    default:
      // Unknown / future tool — never echo the literal name. The
      // count still ships under `other`, so trends are visible to
      // the dashboard without exposing the host's tool catalogue.
      return "other";
  }
}

/** Initialise a counts map with every family key set to 0. */
export function emptyToolFamilyCounts(): Record<ToolFamily, number> {
  return {
    read: 0,
    search: 0,
    shell: 0,
    edit: 0,
    write: 0,
    web: 0,
    task: 0,
    other: 0,
  };
}
