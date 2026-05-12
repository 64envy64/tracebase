# Release 0.8.0 — MCP install layout, savings + distill CLIs, dashboard refactor

Resolves the silently-broken install that shipped on 0.3 → 0.7 (MCP entry
was written to a file Claude Code 2.x does not read), adds two end-user
CLIs (`savings`, `distill`), rebuilds the web dashboard against a single
primitive set, and tightens release hygiene so this class of regression
cannot ship again.

## Install layout (breaking)

- `init` writes `.mcp.json` (Claude Code 2.x project scope), the file
  the IDE actually loads MCP servers from. Auto-migrates any stale
  `mcpServers.tracebase` entry out of `.claude/settings.json`.
- `setup` is now a thin alias to `init`.
- `doctor` checks `.mcp.json`, surfaces stale legacy entries as WARN,
  runs a live MCP `initialize` + `tools/list` handshake by default
  (opt-out via `--no-smoke`).
- `status` renames `claudeSettingsPresent` → `mcpJsonPresent`; adds
  `legacyMcpEntryPresent` for migration debt.
- `@modelcontextprotocol/sdk` and `zod` moved from devDeps / optional
  peers into regular `dependencies` — without this, every fresh
  `npx tracebase-ai serve --mcp` died with `MODULE_NOT_FOUND` because
  npm does not auto-install optional peers.
- `tracebase-ai` bin alias explicit alongside `tracebase` (the 0.7.1
  publish only carried `tracebase`).

## New end-user surfaces

- **`tracebase savings`** — the daily-driver. Plain-English summary
  ("Helped you on 4 of 5 assisted tasks · ~16 min saved · ~2.4k
  tokens recycled") with an octopus empty state, `--json` for
  machine output, `--debug` for the underlying aggregates. No
  jargon ("calibration", "shadow arm", "fact injection") in the
  default view.
- **`tracebase distill --from-block <id>`** — manual LLM upgrade lane
  that re-runs an existing heuristic-captured block through the full
  `DistillationPipeline` against `AnthropicDistiller` (Haiku 4.5 by
  default, Sonnet 4.6 with `--quality`). Requires
  `ANTHROPIC_API_KEY` + the optional `@anthropic-ai/sdk` peer. Result
  is either a new candidate block (LLM rephrased enough to shift the
  fingerprint) or a supporting case ref on the source block
  (fingerprint matched — dedupe path). Either outcome is informative.
- **`src/core/impact.ts`** — pure helper turning `EventAggregates` into
  a friendly `Impact` view consumed by both `savings` and the
  dashboard.
- **`src/core/mcp-config.ts`** — canonical `MCP_ENTRY` shape plus
  read/write/migration for `.mcp.json`. Single source of truth for
  the install entry across `init` / `setup` / `doctor`.
- **`src/cli/smoke.ts`** — MCP-server JSON-RPC handshake probe used by
  both `init`'s default smoke test and `doctor`'s `mcp-handshake`
  check. Hand-rolled framing — no transitive MCP SDK dep on the
  smoke path beyond what `serve --mcp` already pulls in.

## Dashboard

- **Sidebar**: SVG icons next to every nav row, three grouped sections
  (Workspace · Engineering Brain · External), bottom card with
  circular Clerk avatar + display name + email.
- **Page primitives** (`www/src/components/dashboard/primitives/`):
  `PageHeader` (title + actions row), `SectionCard` (3-band:
  header / inset body / footer note), `StatusStrip` (signed-counter
  pill row), `Buttons` (`PrimaryButton`, `SecondaryButton`,
  `ActionPill`), `Icons` (17 inline-SVG, currentColor, 16×16).
- **Uniform geometry**: every interactive button across the
  dashboard now sits at `h-[30px] rounded-lg px-3 text-[12px]
  leading-none`. Hovers tuned to ≤ 2.5% surface lift — visible
  enough to confirm hit-target, never enough to flash.
- **OverviewView**: 4 linked metric tiles (Runs → /dashboard/runs,
  Success rate → /dashboard/impact, Memories used →
  /dashboard/memory, Tokens saved → /dashboard/impact) + status
  strip + Recent activity panel with octopus empty state.
  Architectural explainer removed — dashboard shows numbers and
  links, not marketing.
- **ApiKeysView**: rewritten create flow with explicit `idle` /
  `working` / `done` / `error` states. Done-state surfaces the
  ready-to-paste init command with the new key inlined and a clear
  "shown once" notice.
- **QuickstartView / InstallationsView / ImpactView**: same
  primitives, consistent copy, no rambling subtitles.
- **Octopus mascot** (`www/public/octopus.svg`) — single-color
  geometric silhouette matching `logo.svg` (200×200, rx=32,
  `#0D0D0D` on white).
- **`next.config.ts`**: `img.clerk.com` + `images.clerk.dev` added
  to `images.remotePatterns` so `next/image` accepts Clerk avatar
  URLs.

## Docs + release hygiene

- `README.md`, `docs/QUICKSTART.md`, `docs/TROUBLESHOOTING.md` all
  rewritten around `.mcp.json` + `claude mcp add` + the auto-migration
  path. `tracebase savings` surfaces as the recommended
  "What to do next" command.
- **`CHANGELOG.md`** (new) — Keep-a-Changelog format. 0.8.0 entry
  plus a reconstructed pre-0.8.x summary derived from the npm publish
  log.
- **`RELEASE.md`** (new) — pre-publish checklist that includes the
  mandatory step ("in a scratch dir: `node dist/cli.js init` must end
  with `✓ Claude Code is ready.`") that would have caught the
  silently-broken 0.3 → 0.7 install drift had it existed.
- `.gitignore`: `.claude/` (per-machine Claude Code state) and
  `www/.clerk/` (Clerk dev keyless mode bootstrap) excluded.

## Tests

- **117 test files / 1717 tests / 0 failures.**
- New: `tests/core/impact.test.ts`, `tests/cli/savings.test.ts`,
  `tests/cli/smoke.test.ts`, `tests/cli/distill.test.ts`,
  `tests/fixtures/mock-mcp-server.js`.
- Updated to match the new layout: `doctor`, `init`, `status`,
  `events-report-integration`, `header-counts`, `impact-view-copy`,
  `install-targets`-related suites.
- The `mock-mcp-server.js` fixture covers smoke's happy + 5 failure
  paths (spawn fail, missing tools, init JSON-RPC error, silent
  timeout, child crash) without taking a transitive dep on the real
  MCP SDK.

## CI

`.github/workflows/ci.yml` runs the full suite on
`ubuntu-latest × macos-latest × windows-latest` × Node 18 / 20 / 22.
The `publish` job is gated on `github.ref == 'refs/heads/main' &&
github.event_name == 'push'` AND on the version not yet existing in
npm, so this PR merging into `main` triggers the publish of 0.8.0 once
and stays a no-op on re-runs.

## Post-publish checklist (RELEASE.md §7)

After merge + `publish` job lands the artifact:

- [ ] `npm view tracebase-ai version` → `0.8.0`
- [ ] `npm view tracebase-ai bin --json` → both `tracebase` and
      `tracebase-ai` mapped to `dist/cli.js`
- [ ] In a fresh scratch directory: `npx -y tracebase-ai@0.8.0 init`
      ends with `✓ Claude Code is ready.`
- [ ] `npx -y tracebase-ai@0.8.0 doctor` summary shows `PASS` for
      `mcp-sdk` (regression check on the dependency move)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
