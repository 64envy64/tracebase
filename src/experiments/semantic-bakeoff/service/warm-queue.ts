/**
 * Bounded FIFO single-flight warm scheduler (R&D, E.2.2). The "revalidate" half of
 * the two-plane overlay — populates the cache for FUTURE lookups, NEVER affects
 * served output. Real backpressure:
 *   - at most `maxConcurrent` tasks run at once (active);
 *   - excess waits in a bounded FIFO `pending` queue (`maxQueued`);
 *   - a key already active OR pending is COALESCED (stampede protection);
 *   - overflow past active+pending is dropped + counted;
 *   - as an active task finishes, the next pending task is pumped (FIFO order);
 *   - drain() awaits active + pending to fully settle.
 */
export interface WarmQueueOptions {
  maxConcurrent: number;
  maxQueued: number;
}

export class WarmQueue {
  private readonly active = new Map<string, Promise<void>>();
  private readonly pending: { key: string; task: () => Promise<void> }[] = [];
  private readonly pendingKeys = new Set<string>();
  private dropped = 0;
  private coalesced = 0;
  private scheduled = 0;
  private cancelled = 0;
  private accepting = true;

  constructor(private readonly opts: WarmQueueOptions) {
    // Validate bounds (E.2.3): maxConcurrent < 1 would make drain() hang forever
    // (pump can never start a task, yet pending never empties); maxQueued < 0 makes
    // every task drop. Reject both up front rather than fail mysteriously at runtime.
    if (!Number.isInteger(opts.maxConcurrent) || opts.maxConcurrent < 1) {
      throw new RangeError(`WarmQueue: maxConcurrent must be an integer >= 1 (got ${opts.maxConcurrent})`);
    }
    if (!Number.isInteger(opts.maxQueued) || opts.maxQueued < 0) {
      throw new RangeError(`WarmQueue: maxQueued must be an integer >= 0 (got ${opts.maxQueued})`);
    }
  }

  schedule(key: string, task: () => Promise<void>): "started" | "queued" | "coalesced" | "dropped" | "closed" {
    if (!this.accepting) {
      this.dropped++;
      return "closed";
    }
    if (this.active.has(key) || this.pendingKeys.has(key)) {
      this.coalesced++; // coalesce across BOTH active and pending
      return "coalesced";
    }
    if (this.active.size < this.opts.maxConcurrent) {
      this.scheduled++;
      this.run(key, task);
      return "started";
    }
    if (this.pending.length < this.opts.maxQueued) {
      this.scheduled++;
      this.pending.push({ key, task });
      this.pendingKeys.add(key);
      return "queued";
    }
    this.dropped++; // bounded: never grows past maxConcurrent + maxQueued
    return "dropped";
  }

  private run(key: string, task: () => Promise<void>): void {
    const p = task()
      .catch(() => undefined) // a warm failure is invisible to serving
      .finally(() => {
        this.active.delete(key);
        this.pump();
      });
    this.active.set(key, p);
  }

  private pump(): void {
    while (this.active.size < this.opts.maxConcurrent && this.pending.length > 0) {
      const next = this.pending.shift()!;
      this.pendingKeys.delete(next.key);
      this.run(next.key, next.task);
    }
  }

  /** Await every active + pending task to settle. */
  async drain(): Promise<void> {
    while (this.active.size > 0 || this.pending.length > 0) {
      this.pump();
      await Promise.all([...this.active.values()]);
    }
  }

  /** Reject future schedules while allowing already-queued work to drain. */
  stopAccepting(): void {
    this.accepting = false;
  }

  /** Cancel pending work after a bounded graceful-drain deadline expires. */
  cancelPending(): number {
    const n = this.pending.length;
    this.pending.length = 0;
    this.pendingKeys.clear();
    this.cancelled += n;
    return n;
  }

  stats(): { active: number; pending: number; dropped: number; coalesced: number; scheduled: number; cancelled: number; accepting: boolean } {
    return {
      active: this.active.size,
      pending: this.pending.length,
      dropped: this.dropped,
      coalesced: this.coalesced,
      scheduled: this.scheduled,
      cancelled: this.cancelled,
      accepting: this.accepting,
    };
  }
}
