import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  const raw = mkdtempSync(join(tmpdir(), "tb-evt-rep-"));
  workDir = realpathSync(raw);
});
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

async function seedStoreWithEvents(projectPath: string): Promise<string> {
  const Database = (await import("better-sqlite3")).default;
  const { BlockStore } = await import("../../src/core/block-store.js");
  const { createBlock } = await import("../../src/core/block.js");
  const { loadConfig } = await import("../../src/core/config.js");
  const cfg = loadConfig(projectPath);
  const db = new Database(cfg.storagePath);
  const store = new BlockStore(db);

  const b = createBlock({
    trigger: {
      situation: "sample unique-token for integration test",
      invariants: { language: "python" },
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

  // 2 complete helpful cycles and 1 counter cycle — feeds both counts
  // and rates in the report.
  const seed = (qid: string, ts: number, helpful: boolean) => {
    store.appendEvent({
      ts, queryId: qid, event: "retrieval",
      candidates: [{ blockId: b.id, score: 0.9 }], shadow: false,
    });
    store.appendEvent({
      ts: ts + 1, queryId: qid, event: "injection", blockId: b.id, score: 0.9,
    });
    store.appendEvent({
      ts: ts + 2, queryId: qid, event: "agent_used", blockId: b.id,
      matchSignal: "jaccard", matchScore: 0.5,
    });
    store.appendEvent({
      ts: ts + 3, queryId: qid, event: "outcome",
      resolved: helpful, control: false,
    });
  };
  // Use realistic 13-digit epoch ms so the --since parser treats raw
  // digits as timestamps (not a short year string).
  const BASE = 1_700_000_000_000;
  seed("q1", BASE + 1_000, true);
  seed("q2", BASE + 2_000, true);
  seed("q3", BASE + 3_000, false);

  store.close();
  return b.id;
}

describe("CLI events + report — integration via built binary", () => {
  it("events --json surfaces seeded events with correct types", async () => {
    if (!existsSync(CLI_PATH)) return; // run `npm run build` first

    cli(["init", "--path", workDir], workDir);
    await seedStoreWithEvents(workDir);

    const out = cli(["events", "--json", "--limit", "100"], workDir);
    const parsed = JSON.parse(out) as { events: Array<{ event: string }> };
    expect(parsed.events.length).toBe(12); // 3 cycles × 4 events each
    const byType: Record<string, number> = {};
    for (const ev of parsed.events) byType[ev.event] = (byType[ev.event] ?? 0) + 1;
    expect(byType.retrieval).toBe(3);
    expect(byType.injection).toBe(3);
    expect(byType.agent_used).toBe(3);
    expect(byType.outcome).toBe(3);
  });

  it("events --type injection narrows the result set", async () => {
    if (!existsSync(CLI_PATH)) return;
    cli(["init", "--path", workDir], workDir);
    await seedStoreWithEvents(workDir);

    const out = cli(["events", "--json", "--type", "injection"], workDir);
    const parsed = JSON.parse(out) as { events: Array<{ event: string }> };
    expect(parsed.events.length).toBe(3);
    for (const ev of parsed.events) expect(ev.event).toBe("injection");
  });

  it("events --since <epoch-ms> filters by afterTs", async () => {
    if (!existsSync(CLI_PATH)) return;
    cli(["init", "--path", workDir], workDir);
    await seedStoreWithEvents(workDir);

    // After ts just before q3 → only q3's 4 events survive.
    const BASE = 1_700_000_000_000;
    const cutoff = BASE + 2_500;
    const out = cli(["events", "--json", "--since", String(cutoff)], workDir);
    const parsed = JSON.parse(out) as { events: Array<{ ts: number }> };
    for (const ev of parsed.events) expect(ev.ts).toBeGreaterThan(cutoff);
    expect(parsed.events.length).toBe(4);
  });

  it("report --json reflects the seeded events' counts + rates", async () => {
    if (!existsSync(CLI_PATH)) return;
    cli(["init", "--path", workDir], workDir);
    const blockId = await seedStoreWithEvents(workDir);

    const out = cli(["report", "--json"], workDir);
    const parsed = JSON.parse(out) as {
      counts: Record<string, number>;
      rates: Record<string, number | null>;
      perBlock: Array<{ blockId: string; helpful: number; counterproductive: number; injected: number }>;
    };
    expect(parsed.counts.retrieval).toBe(3);
    expect(parsed.counts.injection).toBe(3);
    expect(parsed.counts.agentUsed).toBe(3);
    expect(parsed.counts.outcome).toBe(3);

    // 2 helpful / 3 injected = 0.667; 1 counter / 3 = 0.333.
    expect(parsed.rates.helpfulRate).toBeCloseTo(2 / 3, 2);
    expect(parsed.rates.counterproductiveRate).toBeCloseTo(1 / 3, 2);

    // Top block row is the seeded block.
    expect(parsed.perBlock.length).toBeGreaterThanOrEqual(1);
    expect(parsed.perBlock[0].blockId).toBe(blockId);
    expect(parsed.perBlock[0].helpful).toBe(2);
    expect(parsed.perBlock[0].counterproductive).toBe(1);
    expect(parsed.perBlock[0].injected).toBe(3);
  });

  it("report without a store file short-circuits cleanly", () => {
    if (!existsSync(CLI_PATH)) return;
    cli(["init", "--path", workDir], workDir);
    // No events seeded, no store file.
    const out = cli(["report", "--json"], workDir);
    const parsed = JSON.parse(out) as { empty?: boolean };
    expect(parsed.empty).toBe(true);
  });
});
