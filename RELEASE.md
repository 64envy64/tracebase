# Release checklist

Steps for publishing a new `tracebase-ai` version to npm. Everything
between the **green checkboxes** must pass before a release goes out;
they're enforced by CI (`.github/workflows/ci.yml`) on the publish
job, but you should run them locally first so you don't burn a tag
on a discoverable problem.

## 1. Decide the version bump

Read [`CHANGELOG.md`](./CHANGELOG.md). What lands in this release?

- **Breaking changes** to the CLI surface, MCP tool shapes, install
  layout (`claude mcp` registry, Cursor/Codex MCP config,
  `.tracebase/config.json` keys), or
  exported library types → **minor bump** (we're still 0.x; minor is
  our breaking-change channel).
- **New features** that don't break existing callers → minor bump.
- **Bug fixes** or doc-only changes → **patch bump**.

We do **not** publish from feature branches. Land on `main` first.

## 2. Update version + changelog

```
# Edit package.json + package-lock.json
"version": "0.X.Y"

# Move CHANGELOG.md [Unreleased] → [0.X.Y] — YYYY-MM-DD
# Add a fresh empty [Unreleased] header back at the top.
```

Commit with `chore: release v0.X.Y` (the tag will match).

## 3. Local validation

- [ ] `npm ci` — clean install, mirrors what CI does
- [ ] `npm run lint` — strict TypeScript pass (`tsc --noEmit`)
- [ ] `npm run build` — `tsup` emits `dist/` (cjs + esm + cli + mcp)
- [ ] `npm test` — `vitest run` is fully green
- [ ] `node dist/cli.js --version` prints `0.X.Y`
- [ ] In a scratch directory: `node /path/to/repo/dist/cli.js init`
      succeeds, then
      `TRACEBASE_MCP_PROBE_COMMAND="[\"node\",\"/path/to/repo/dist/cli.js\",\"serve\",\"--mcp\"]" node /path/to/repo/dist/cli.js doctor`
      reports `PASS mcp-boot` (proves the selftest path actually
      boots `serve --mcp` with this build)

The end-to-end boot check is non-negotiable. It catches the
exact class of install bugs where the local checkout works but the
runtime command an agent spawns is stale or missing dependencies.

## 4. Cross-platform sanity (when the release touches CLI / install
   paths)

CI already runs on `ubuntu-latest`, `macos-latest`, and
`windows-latest` against Node 18 / 20 / 22 — so for code-only
releases you can rely on the matrix. For install-layout changes,
also smoke-test by hand:

- [ ] Windows path-with-spaces: `C:\Users\Test User\proj\` →
      `npx tracebase-ai init` succeeds and `doctor` has no FAIL rows
- [ ] macOS: same, in `/tmp/proj/`
- [ ] Linux: same

## 5. Publish

The `publish` job in CI runs on push to `main` and only publishes
when `package.json.version` is **not** already on npm. To trigger:

```
git push origin main
```

The job emits `npm publish --provenance --access public`. Provenance
ties the package to the GitHub commit SHA — don't disable it.

If you ever need to publish manually (CI broken, hot-fix):

```
npm whoami                 # confirm you're logged in
npm ci
npm run build
npm publish --provenance --access public
```

## 6. Tag + GitHub release

```
git tag v0.X.Y
git push origin v0.X.Y
```

Then on GitHub: create a release from the tag, paste the CHANGELOG
entry into the body. Mark as **latest** if this is the highest
non-prerelease version.

## 7. Verify the published artifact

- [ ] `npm view tracebase-ai version` → `0.X.Y`
- [ ] `npm view tracebase-ai bin --json` → contains **both**
      `"tracebase"` and `"tracebase-ai"` mapped to `dist/cli.js`
- [ ] In a fresh scratch directory:
      `npx -y tracebase-ai@0.X.Y init` succeeds, and
      `npx -y tracebase-ai@0.X.Y doctor` reports `PASS mcp-sdk`
      plus a non-failing `mcp-boot` check

## 8. Announce

If this is a feature release, post to the README's homepage / Discord
/ wherever-you-announce. For patch releases, the CHANGELOG entry is
enough.

---

## Known sharp edges

- `package-lock.json` must be committed alongside `package.json`.
  Forgetting it makes `npm ci` in CI install something different from
  what you tested.
- `@types/node` major version on `devDependencies` should match the
  lowest supported Node (currently 18). Bumping it to `^22` while
  keeping `engines.node: ">=18"` is fine, but typecheck on 18 in CI
  will catch any 22-only types you accidentally used.
- `better-sqlite3` is a native module. The publish step does **not**
  build native binaries — those ship via `prebuild-install` from the
  upstream package. If a release lands on a new Node major before
  `better-sqlite3` ships prebuilt binaries for it, CI will fail
  loudly on that Node version; downgrade the matrix until upstream
  catches up.
