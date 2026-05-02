#!/usr/bin/env tsx
/**
 * Internal GitHub ingest CLI fallback.
 *
 * The dashboard's "Ingest" button is the supported onboarding path.
 * This script exists for headless environments and CI smoke tests.
 *
 * Reads PAT from TRACEBASE_GITHUB_TOKEN (preferred) or GITHUB_TOKEN
 * — never accepts the token as an argument so it doesn't end up in
 * shell history. Workspace identity is taken from
 * TRACEBASE_WORKSPACE_ID (or the only workspace in the file store
 * fallback if exactly one exists).
 *
 * Usage:
 *   tsx scripts/github-ingest.ts --repo owner/name
 *   tsx scripts/github-ingest.ts --repo owner/name --workspace-id <uuid>
 *
 * No production support; not exposed via the bin/ entry. Listed in
 * `package.json` only as `smoke:gh-ingest` for convenience.
 */
import {
  getEngineeringBrainStore,
  type EngineeringBrainStore,
} from "../www/src/lib/control-plane/engineering-brain";
import {
  createGithubClient,
  resolveGithubTokenFromEnv,
} from "../www/src/lib/control-plane/github-client";
import { ingestRepo } from "../www/src/lib/control-plane/github-ingest";

interface CliArgs {
  repo: string;
  workspaceId?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const out: Partial<CliArgs> = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--repo") {
      out.repo = argv[++i];
    } else if (arg === "--workspace-id") {
      out.workspaceId = argv[++i];
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
  }
  if (!out.repo) {
    printUsage();
    process.exit(2);
  }
  return out as CliArgs;
}

function printUsage(): void {
  process.stderr.write(
    [
      "Usage: tsx scripts/github-ingest.ts --repo <owner>/<name> [--workspace-id <uuid>]",
      "",
      "Env:",
      "  TRACEBASE_GITHUB_TOKEN    PAT (preferred)",
      "  GITHUB_TOKEN              PAT (fallback)",
      "  TRACEBASE_WORKSPACE_ID    Workspace UUID (if multiple)",
      "",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const token = resolveGithubTokenFromEnv();
  if (!token) {
    process.stderr.write(
      "no github token found in TRACEBASE_GITHUB_TOKEN / GITHUB_TOKEN\n",
    );
    process.exit(1);
  }

  const store = await getEngineeringBrainStore();
  const workspaceId = await resolveWorkspaceId(store, args.workspaceId);
  if (!workspaceId) {
    process.stderr.write(
      "could not resolve a workspace id; pass --workspace-id <uuid>\n",
    );
    process.exit(1);
  }

  const integration = await store.upsertIntegration({
    workspaceId,
    provider: "github",
    accountLogin: args.repo.split("/")[0],
    repoFullName: args.repo,
    status: "connected",
  });
  const client = createGithubClient({ token });
  const result = await ingestRepo({
    workspaceId,
    integration,
    client,
    store,
  });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function resolveWorkspaceId(
  _store: EngineeringBrainStore,
  hint: string | undefined,
): Promise<string | null> {
  if (hint) return hint;
  const env = process.env.TRACEBASE_WORKSPACE_ID;
  if (env) return env;
  return null;
}

main().catch((err: unknown) => {
  // Don't print the token under any circumstance; the redact pattern
  // in github-ingest.ts is the second line of defense, but the first
  // is keeping tokens out of any log line we emit here.
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
