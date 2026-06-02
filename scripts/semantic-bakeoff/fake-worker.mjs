#!/usr/bin/env node
/**
 * Deterministic FAKE semantic worker (R&D test double).
 *
 * Speaks the JSONL worker protocol (src/experiments/semantic-bakeoff/worker-
 * protocol.ts) so PersistentWorkerProvider can be exercised at $0 — no model, no
 * weights, no Python. Verdicts are a stable hash of the blockId, so a fixed input
 * yields a fixed output. Env knobs simulate the failure modes the adapter must
 * absorb:
 *   FAKE_NO_READY=1     → never answer the handshake (→ adapter handshake timeout)
 *   FAKE_DELAY_MS=<n>   → delay each result by n ms (→ adapter deadline → fail open)
 *   FAKE_CRASH_ON_RANK=1→ exit on the first rank (→ adapter crash detection)
 */
import { createInterface } from "node:readline";

const V = 1;
const DELAY = Number(process.env.FAKE_DELAY_MS || 0);
const NO_READY = process.env.FAKE_NO_READY === "1";
const CRASH = process.env.FAKE_CRASH_ON_RANK === "1";

function stableUnit(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0xffffffff;
}
function send(o) {
  process.stdout.write(JSON.stringify(o) + "\n");
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (!m || m.v !== V) return;
  if (m.type === "hello") {
    if (!NO_READY) send({ v: V, id: m.id, type: "ready", model: "fake-worker", featureVersion: 1 });
    return;
  }
  if (m.type === "rank") {
    if (CRASH) process.exit(1);
    const results = (m.candidates || []).map((c) => {
      const u = stableUnit(c.blockId);
      return { blockId: c.blockId, verdict: u > 0.66 ? "applicable" : u > 0.33 ? "uncertain" : "inapplicable", confidence: u };
    });
    const emit = () => send({ v: V, id: m.id, type: "result", results });
    if (DELAY > 0) setTimeout(emit, DELAY);
    else emit();
    return;
  }
  if (m.type === "shutdown") process.exit(0);
  // "cancel" → no-op (the host already resolved null on timeout).
});
