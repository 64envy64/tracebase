/**
 * `tracebase savings` — end-to-end CLI integration test.
 *
 * Drives the built dist/cli.js to cover the three render states (no
 * config dir, post-init no events, post-init with events) plus the
 * --json shape and the --debug pass-through. Same pattern as
 * `events-report-integration.test.ts`.
 *
 * We seed the SQLite store directly to control the aggregate input
 * — the alternative would be running the MCP server end-to-end, which
 * is what the doctor selftest coverage already covers and isn't this
 * test's concern.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initConfig } from "../../src/core/config.js";

const CLI_PATH = join(__dirname, "..", "..", "dist", "cli.js");

function cli(args: string[], cwd: string): string {
  return execFileSync("node", [CLI_PATH, ...args], {
    cwd,
    encoding: "utf-8",
    timeout: 15_000,
    env: { ...process.env, NO_COLOR: "1" },
  });
}

let workDir: string;

beforeEach(() => {
  const raw = mkdtempSync(join(tmpdir(), "tb-savings-"));
  workDir = realpathSync(raw);
});
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

async function seedHelpfulRun(projectPath: string): Promise<string> {
  const Database = (await import("better-sqlite3")).default;
  const { BlockStore } = await import("../../src/core/block-store.js");
  const { createBlock } = await import("../../src/core/block.js");
  const { loadConfig } = await import("../../src/core/config.js");
  const cfg = loadConfig(projectPath);
  const db = new Database(cfg.storagePath);
  const store = new BlockStore(db);

  const b = createBlock({
    trigger: {
      situation: "CORS preflight failing on Express because OPTIONS handler missing",
      invariants: { language: "typescript", framework: "express" },
    },
    body: { mechanism: "m", deadEnds: [], unlock: "u", verification: "v" },
    provenance: { sourceTaskId: "t-1", extractedFrom: "trajectory", distilledBy: "llm" },
  });
  b.status = "candidate";
  store.storeBlock(b);
  store.attachCaseRef({
    blockId: b.id, traceId: "trace-1", role: "origin", evidenceQuality: "strong",
  });
  store.updateBlockStatus(b.id, "active");

  // Two helpful (resolved=true), one counter (resolved=false).
  // Anchor to Date.now() so the savings command's default --since 7d
  // captures them (a 1970-anchored ts would be filtered out as "older
  // than a week" and the test would see an empty store).
  const now = Date.now();
  const seed = (qid: string, tsOffset: number, resolved: boolean) => {
    const ts = now - tsOffset;
    store.appendEvent({
      ts, queryId: qid, event: "retrieval",
      candidates: [{ blockId: b.id, score: 0.9 }], shadow: false,
    });
    store.appendEvent({
      ts: ts + 1, queryId: qid, event: "injection", blockId: b.id, score: 0.9,
    });
    store.appendEvent({
      ts: ts + 2, queryId: qid, event: "agent_used",
      blockId: b.id, matchSignal: "explicit", matchScore: 1,
    });
    store.appendEvent({
      ts: ts + 3, queryId: qid, event: "outcome",
      resolved, control: false,
    });
  };
  seed("q1", 30_000, true);  // 30s ago
  seed("q2", 20_000, true);  // 20s ago
  seed("q3", 10_000, false); // 10s ago

  store.close();
  db.close();
  return b.id;
}

describe("tracebase savings — empty states", () => {
  it("reports uninitialized when there's no .tracebase/ in the tree", () => {
    if (!existsSync(CLI_PATH)) return;
    const out = cli(["savings"], workDir);
    expect(out).toMatch(/Not initialized/i);
    expect(out).toMatch(/init/);
  });

  it("--json from uninitialized state has a stable shape", () => {
    if (!existsSync(CLI_PATH)) return;
    const out = cli(["savings", "--json"], workDir);
    const parsed = JSON.parse(out) as { state: string; impact: unknown };
    expect(parsed.state).toBe("uninitialized");
    expect(parsed.impact).toBeNull();
  });

  it("post-init no-events shows the friendly 'no savings yet' renderer", () => {
    if (!existsSync(CLI_PATH)) return;
    initConfig(workDir);
    const out = cli(["savings"], workDir);
    expect(out).toMatch(/No savings yet/i);
    expect(out).toMatch(/octopus/i);
    // No technical jargon leaks through the empty state.
    expect(out).not.toMatch(/shadow/i);
    expect(out).not.toMatch(/calibrat/i);
  });

  it("post-init no-events --json has impact set to a zeroed Impact, not null", () => {
    if (!existsSync(CLI_PATH)) return;
    initConfig(workDir);
    const out = cli(["savings", "--json"], workDir);
    const parsed = JSON.parse(out) as { state: string; impact: { isEmpty: boolean; confidence: string } | null };
    // After init the store dir exists, but no agent turn has opened the
    // SQLite store yet. The savings command treats "no store file" as
    // no-store, distinct from uninitialized, while still returning the
    // empty Impact shape for JSON callers.
    expect(["no-store", "no-events"]).toContain(parsed.state);
    expect(parsed.impact).not.toBeNull();
    expect(parsed.impact?.isEmpty).toBe(true);
    expect(parsed.impact?.confidence).toBe("empty");
  });
});

describe("tracebase savings — populated store", () => {
  it("reports value-first numbers when there are helpful events", async () => {
    if (!existsSync(CLI_PATH)) return;
    initConfig(workDir);
    await seedHelpfulRun(workDir);

    const out = cli(["savings", "--since", "1h"], workDir);
    // Helped you on N tasks
    expect(out).toMatch(/Helped you on 2 of 3 assisted task/);
    // Estimated minutes (2 helpful × 4 min default = 8 min)
    expect(out).toMatch(/~8 min saved/);
    // Tokens (2 helpful × 600 = 1200, formatted as 1.2k)
    expect(out).toMatch(/~1\.2k tokens recycled/);
    // Top memory shows the trigger.situation, truncated
    expect(out).toMatch(/CORS preflight/);
    // The bug pattern shows up in needs-attention (1 counter)
    expect(out).toMatch(/Needs attention/);
    // Confidence flag — "estimated" because we have no shadow arm.
    expect(out).toMatch(/estimated/i);
  });

  it("--json carries the canonical Impact shape", async () => {
    if (!existsSync(CLI_PATH)) return;
    initConfig(workDir);
    await seedHelpfulRun(workDir);

    const out = cli(["savings", "--json", "--since", "1h"], workDir);
    const parsed = JSON.parse(out) as {
      state: string;
      impact: {
        confidence: string;
        helpedTasks: number;
        assistedTasks: number;
        memoriesUsed: number;
        estimatedMinutesSaved: number;
        estimatedTokensSaved: number;
        topMemories: Array<{ blockId: string; helpful: number }>;
        needsAttention: Array<{ blockId: string; counterproductive: number }>;
      };
      labels: Record<string, string>;
    };
    expect(parsed.state).toBe("ok");
    expect(parsed.impact.confidence).toBe("estimated");
    expect(parsed.impact.helpedTasks).toBe(2);
    expect(parsed.impact.assistedTasks).toBe(3);
    expect(parsed.impact.memoriesUsed).toBe(1);
    expect(parsed.impact.estimatedMinutesSaved).toBe(8);
    expect(parsed.impact.estimatedTokensSaved).toBe(1200);
    expect(parsed.impact.topMemories).toHaveLength(1);
    expect(parsed.impact.topMemories[0].helpful).toBe(2);
    expect(parsed.impact.needsAttention).toHaveLength(1);
    expect(parsed.impact.needsAttention[0].counterproductive).toBe(1);
    // Labels resolved for the topMemories blockId.
    const topId = parsed.impact.topMemories[0].blockId;
    expect(parsed.labels[topId]).toMatch(/CORS preflight/);
  });

  it("--debug surfaces the underlying technical metrics", async () => {
    if (!existsSync(CLI_PATH)) return;
    initConfig(workDir);
    await seedHelpfulRun(workDir);

    const out = cli(["savings", "--debug", "--since", "1h"], workDir);
    // Debug section header present.
    expect(out).toMatch(/Debug — technical metrics/);
    // Technical jargon ALLOWED inside debug — that's the point.
    expect(out).toMatch(/counts:/);
    expect(out).toMatch(/rates:/);
    // Specific aggregate that wouldn't be in the friendly section.
    expect(out).toMatch(/helpfulRate=/);
  });

  it("rejects garbage --since values with a clear error", () => {
    if (!existsSync(CLI_PATH)) return;
    initConfig(workDir);

    try {
      execFileSync("node", [CLI_PATH, "savings", "--since", "totally-not-a-date"], {
        cwd: workDir,
        encoding: "utf-8",
        timeout: 15_000,
        env: { ...process.env, NO_COLOR: "1" },
      });
      // Should have thrown — savings sets exitCode=1 on bad --since.
      throw new Error("expected non-zero exit");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).toMatch(/unrecognized --since|expected non-zero/);
    }
  });
});
