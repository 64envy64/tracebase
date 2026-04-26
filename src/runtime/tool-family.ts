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
    // read: file-content read tools across hosts. `Cat` and `MultiRead`
    // are non-Claude-Code aliases (LangChain / Agent SDK style).
    case "Read":
    case "Cat":
    case "MultiRead":
      return "read";
    // search: pattern-search tools. The Unix-side aliases (ripgrep, ag,
    // findstr) collapse to the same family so a host that exposes
    // `rg` doesn't ship a different vocabulary than one with `Grep`.
    case "Grep":
    case "Glob":
    case "ripgrep":
    case "ag":
    case "findstr":
      return "search";
    // shell: arbitrary command execution. `Shell`, `Exec`, `Run` cover
    // common LangChain / Agent SDK names.
    case "Bash":
    case "Shell":
    case "Exec":
    case "Run":
      return "shell";
    // edit: in-place file mutation. `MultiEdit` / `Patch` cover hosts
    // that expose patch-style edits separately from single-line edits.
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
    case "Patch":
      return "edit";
    // write: net-new file creation. `Create` is a common SDK alias.
    case "Write":
    case "Create":
      return "write";
    // web: outbound HTTP. `HttpGet` / `HttpPost` cover hosts that
    // expose method-typed network tools instead of a single `WebFetch`.
    case "WebFetch":
    case "WebSearch":
    case "HttpGet":
    case "HttpPost":
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

/**
 * Alias spelled per PLAN-0.7 §rc.1 (Ground). Same function, same
 * contract — the alternate name is what later rcs reference (loop
 * normalization in §rc.5 and the supervision warn path in §rc.4).
 * Kept as an alias rather than a rename so existing imports of
 * `toolFamily` keep compiling.
 */
export const toolFamilyOf = toolFamily;

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
