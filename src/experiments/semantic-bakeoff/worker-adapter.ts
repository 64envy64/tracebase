/**
 * Persistent local-process semantic provider adapter (R&D, provider-agnostic).
 *
 * Spawns a long-lived worker subprocess and talks the typed JSONL protocol
 * (worker-protocol.ts). Works for ANY worker that speaks the protocol — the
 * deterministic fake, a Python Qwen worker, a future ONNX worker — with no
 * model-specific code here. Implements `ApplicabilityProvider`, so it slots into
 * the existing bakeoff boundary and the production contract: deterministic-enough
 * for a fixed worker, and it NEVER throws — every failure returns `null` so the
 * caller falls open to the deterministic baseline.
 *
 * Guarantees: startup handshake (bounded), bounded+scanned DTOs (scanner runs
 * BEFORE transport — a leak is never sent to the worker), a strict per-request
 * deadline with cancellation, a concurrency cap (overflow fails open), crash
 * detection + optional restart, and health telemetry. No implicit network — the
 * worker is a local child process; a network-using worker would be its own
 * concern, declared via the bakeoff `network` posture.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { detectLeakageExtended } from "../../core/guard.js";
import type {
  ApplicabilityProvider,
  ApplicabilityQueryViews,
  ApplicabilityCandidate,
  ApplicabilityContext,
  ApplicabilityResult,
} from "../../core/applicability-reranker.js";
import {
  WORKER_PROTOCOL_VERSION,
  parseWorkerLine,
  serializeRequest,
  type WorkerRequest,
  type WireCandidate,
} from "./worker-protocol.js";

export interface WorkerAdapterOptions {
  /** Executable to spawn (e.g. "node", "python"). */
  command: string;
  /** Args (e.g. ["scripts/semantic-bakeoff/fake-worker.mjs"]). */
  args: string[];
  name?: string;
  /** Bounded handshake window. */
  handshakeTimeoutMs?: number;
  /** Max in-flight rank requests; overflow fails open. */
  concurrency?: number;
  /** Bounds applied before transport. */
  maxCandidates?: number;
  maxTokensPerField?: number;
  /** Restart a crashed worker on the next rank. Default true. */
  restartOnCrash?: boolean;
  /**
   * E.2.2 honest cancellation: after a deadline, the cooperative `cancel` is sent;
   * if the worker hasn't freed the request within this grace window (a stuck GPU
   * forward can't be interrupted cooperatively) the worker process is KILLED +
   * recycled so its GPU capacity is released. Default 1000ms.
   */
  recycleGraceMs?: number;
  /** Worker env (no secrets; e.g. a model path). */
  env?: Record<string, string>;
  /** Injectable clock (tests). */
  now?: () => number;
}

export interface WorkerHealth {
  state: "cold" | "ready" | "handshake_failed" | "crashed";
  model: string | null;
  featureVersion: number | null;
  requests: number;
  results: number;
  timeouts: number;
  errors: number;
  scannerBlocked: number;
  concurrencyRejected: number;
  crashes: number;
  restarts: number;
  /** Workers killed because a cancelled request stayed stuck past the grace window. */
  recycles: number;
  /** Bounded recency ring of served-request latencies (ms). */
  latenciesMs: number[];
}

interface Pending {
  resolve: (r: ApplicabilityResult[] | null) => void;
  timer: ReturnType<typeof setTimeout>;
  startedAt: number;
}

const LAT_RING = 256;

export class PersistentWorkerProvider implements ApplicabilityProvider {
  readonly name: string;
  private _featureVersion = 0;
  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: Interface | null = null;
  private readyPromise: Promise<boolean> | null = null;
  private readonly pending = new Map<string, Pending>();
  /** Requests whose deadline fired; the worker still holds the GPU until it frees them. */
  private readonly awaitingCancel = new Set<string>();
  private recycleTimer: ReturnType<typeof setTimeout> | undefined;
  private seq = 0;
  private readonly now: () => number;
  private readonly health: WorkerHealth = {
    state: "cold", model: null, featureVersion: null, requests: 0, results: 0, timeouts: 0,
    errors: 0, scannerBlocked: 0, concurrencyRejected: 0, crashes: 0, restarts: 0, recycles: 0, latenciesMs: [],
  };

  constructor(private readonly opts: WorkerAdapterOptions) {
    this.name = opts.name ?? "persistent-worker";
    this.now = opts.now ?? Date.now;
  }

  get featureVersion(): number {
    return this._featureVersion;
  }

  healthSnapshot(): Readonly<WorkerHealth> {
    return { ...this.health, latenciesMs: [...this.health.latenciesMs] };
  }

  /** Spawn + handshake exactly once (memoised). Resolves false on any failure. */
  private ensureStarted(): Promise<boolean> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      try {
        const child = spawn(this.opts.command, this.opts.args, {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, ...(this.opts.env ?? {}) },
        });
        this.child = child;
        this.rl = createInterface({ input: child.stdout });
        this.rl.on("line", (line) => this.onLine(line));
        child.on("exit", () => this.onCrash());
        child.on("error", () => this.onCrash());
        // Handshake.
        const helloId = this.nextId();
        const hsTimer = setTimeout(() => {
          this.health.state = "handshake_failed";
          done(false);
        }, this.opts.handshakeTimeoutMs ?? 3000);
        this.pendingHandshake = (model, fv) => {
          clearTimeout(hsTimer);
          this._featureVersion = fv;
          this.health.state = "ready";
          this.health.model = model;
          this.health.featureVersion = fv;
          done(true);
        };
        this.write({ v: WORKER_PROTOCOL_VERSION, id: helloId, type: "hello" });
      } catch {
        this.health.state = "handshake_failed";
        done(false);
      }
    });
    return this.readyPromise;
  }

  private pendingHandshake: ((model: string, fv: number) => void) | null = null;

  private onLine(line: string): void {
    const msg = parseWorkerLine(line);
    if (!msg) return;
    if (msg.type === "ready") {
      this.pendingHandshake?.(msg.model, msg.featureVersion);
      this.pendingHandshake = null;
      return;
    }
    // A late response for a cancelled request means the worker freed itself
    // cooperatively → no recycle needed.
    this.awaitingCancel.delete(msg.id);
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.type === "result") {
      this.health.results++;
      pushRing(this.health.latenciesMs, this.now() - p.startedAt);
      p.resolve(
        msg.results.map((r) => ({
          blockId: r.blockId,
          verdict: r.verdict,
          confidence: clamp01(r.confidence),
          reasons: [],
          featureVersion: this._featureVersion,
          evidence: { mechanism: clamp01(r.confidence), remediation: 0, invariants: 0, discriminativeGap: 0, contradiction: 0, familySupport: 0 },
        })),
      );
    } else {
      // "error" / "cancelled" → fail open.
      if (msg.type === "error") this.health.errors++;
      p.resolve(null);
    }
  }

  private onCrash(): void {
    if (this.health.state === "ready") this.health.crashes++;
    this.health.state = "crashed";
    this.child = null;
    this.rl = null;
    this.readyPromise = null; // allow a restart on next rank
    this.pendingHandshake = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve(null); // every in-flight request fails open
    }
    this.pending.clear();
    this.awaitingCancel.clear();
    if (this.recycleTimer) {
      clearTimeout(this.recycleTimer);
      this.recycleTimer = undefined;
    }
  }

  /**
   * Arm a single recycle check. If, after the grace window, any cancelled request
   * is still un-freed, the worker is stuck on the GPU — KILL it (onCrash respawns
   * on the next rank), releasing GPU capacity. A cooperative worker that answers
   * the cancel clears awaitingCancel before the grace and is NOT recycled.
   */
  private armRecycle(): void {
    if (this.recycleTimer) return;
    this.recycleTimer = setTimeout(() => {
      this.recycleTimer = undefined;
      if (this.awaitingCancel.size === 0) return;
      this.health.recycles++;
      this.awaitingCancel.clear();
      try {
        this.child?.kill(); // terminate → OS frees the GPU; onCrash respawns next rank
      } catch {
        /* already gone */
      }
    }, this.opts.recycleGraceMs ?? 1000);
  }

  async rank(
    query: ApplicabilityQueryViews,
    candidates: readonly ApplicabilityCandidate[],
    ctx: ApplicabilityContext,
  ): Promise<ApplicabilityResult[] | null> {
    this.health.requests++;
    // Restart a crashed worker (once) if allowed.
    if (this.health.state === "crashed" && this.opts.restartOnCrash !== false && !this.readyPromise) {
      this.health.restarts++;
    }
    const started = await this.ensureStarted();
    if (!started || !this.child) return null; // handshake failed → fail open

    // Concurrency cap: overflow fails open (the bakeoff falls back to baseline).
    if (this.pending.size >= (this.opts.concurrency ?? 4)) {
      this.health.concurrencyRejected++;
      return null;
    }

    // Bound, then SCAN BEFORE TRANSPORT — a leak is never sent to the worker.
    const wire = this.toWire(candidates);
    const q = { literalText: cap(query.literalText, 4000), ...(query.causalText ? { causalText: cap(query.causalText, 4000) } : {}) };
    const leak = detectLeakageExtended(JSON.stringify({ q, wire }));
    if (leak) {
      this.health.scannerBlocked++;
      return null;
    }

    const id = this.nextId();
    const req: WorkerRequest = { v: WORKER_PROTOCOL_VERSION, id, type: "rank", query: q, candidates: wire };
    return new Promise<ApplicabilityResult[] | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.health.timeouts++;
        this.write({ v: WORKER_PROTOCOL_VERSION, id: this.nextId(), type: "cancel", cancelId: id }); // cooperative cancel first
        resolve(null); // strict deadline → fail open immediately (served path unblocked)
        // Honest cancellation: the worker still holds the GPU. If it doesn't free
        // this request within the grace window, RECYCLE it (kill → respawn).
        this.awaitingCancel.add(id);
        this.armRecycle();
      }, Math.max(1, ctx.deadlineMs));
      this.pending.set(id, { resolve, timer, startedAt: this.now() });
      if (!this.write(req)) {
        // write failed (worker gone) → clear + fail open
        const p = this.pending.get(id);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(id);
        }
        resolve(null);
      }
    });
  }

  private toWire(candidates: readonly ApplicabilityCandidate[]): WireCandidate[] {
    const maxC = this.opts.maxCandidates ?? 20;
    const maxT = this.opts.maxTokensPerField ?? 64;
    return candidates.slice(0, maxC).map((c) => ({
      blockId: c.blockId,
      mechanism: c.tokens.mechanism.slice(0, maxT) as string[],
      situation: c.tokens.situation.slice(0, maxT) as string[],
      unlock: c.tokens.unlock.slice(0, maxT) as string[],
    }));
  }

  private write(req: WorkerRequest): boolean {
    try {
      return this.child?.stdin.write(serializeRequest(req)) ?? false;
    } catch {
      return false;
    }
  }

  private nextId(): string {
    return `r${++this.seq}`;
  }

  async close(): Promise<void> {
    try {
      this.write({ v: WORKER_PROTOCOL_VERSION, id: this.nextId(), type: "shutdown" });
    } catch {
      /* ignore */
    }
    this.rl?.close();
    this.child?.kill();
    this.child = null;
    this.readyPromise = null;
  }
}

function clamp01(n: number): number {
  return !Number.isFinite(n) ? 0 : n < 0 ? 0 : n > 1 ? 1 : n;
}
function cap(s: string, n: number): string {
  return typeof s === "string" && s.length > n ? s.slice(0, n) : s ?? "";
}
function pushRing(ring: number[], v: number): void {
  ring.push(v);
  if (ring.length > LAT_RING) ring.splice(0, ring.length - LAT_RING);
}
