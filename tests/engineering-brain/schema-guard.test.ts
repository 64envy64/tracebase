/**
 * Phase-1 schema guard. The Engineering Brain depends on six new
 * tables + the memory_status catalog. If a future refactor renames
 * one or accidentally drops the FK that anchors memory_events to
 * agent_runs, this textual guard fails before anyone hits the bug
 * in production.
 *
 * We do not stand up Postgres in CI tests; the schema is asserted
 * by reading the SCHEMA_SQL constant from store.ts. Identity:
 * (integration_id, kind, external_id) is the natural key for
 * ingest idempotency, and that constraint must always exist.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const STORE_PATH = resolve(__dirname, "../../www/src/lib/control-plane/store.ts");
const source = readFileSync(STORE_PATH, "utf-8");

describe("Engineering Brain schema", () => {
  const REQUIRED_TABLES = [
    "tracebase_integrations",
    "tracebase_github_items",
    "tracebase_agents",
    "tracebase_agent_runs",
    "tracebase_memory_status",
    "tracebase_memory_events",
    "tracebase_rollback_events",
  ];

  for (const table of REQUIRED_TABLES) {
    it(`includes CREATE TABLE for ${table}`, () => {
      expect(source).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
    });
  }

  it("declares the github_items idempotency key", () => {
    expect(source).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS tracebase_github_items_identity_idx",
    );
    expect(source).toMatch(
      /tracebase_github_items_identity_idx\s+ON tracebase_github_items \(integration_id, kind, external_id\)/,
    );
  });

  it("anchors memory_events to agent_runs and github_items via SET NULL FKs", () => {
    expect(source).toMatch(/source_run_id UUID REFERENCES tracebase_agent_runs\(id\) ON DELETE SET NULL/);
    expect(source).toMatch(
      /source_github_item_id UUID REFERENCES tracebase_github_items\(id\) ON DELETE SET NULL/,
    );
  });

  it("cascades engineering-brain rows from workspace deletion", () => {
    for (const table of REQUIRED_TABLES) {
      const re = new RegExp(
        `${table}[\\s\\S]*?REFERENCES tracebase_workspaces\\(id\\) ON DELETE CASCADE`,
      );
      expect(source).toMatch(re);
    }
  });

  it("memory_status PRIMARY KEY is composite on (workspace_id, memory_id)", () => {
    expect(source).toMatch(
      /tracebase_memory_status[\s\S]*PRIMARY KEY \(workspace_id, memory_id\)/,
    );
  });
});
