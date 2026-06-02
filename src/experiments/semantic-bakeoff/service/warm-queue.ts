/**
 * Bounded, single-flight async warm scheduler (R&D). The "revalidate" half of the
 * two-plane overlay: it populates the cache for FUTURE lookups and NEVER affects
 * served output (fire-and-forget). Single-flight coalesces concurrent warms for
 * the same key (stampede coalescing); the queue is hard-bounded (overflow is
 * dropped + counted, never unbounded growth).
 */
export interface WarmQueueOptions {
  maxConcurrent: number;
  maxQueued: number;
}

export class WarmQueue {
  private readonly inflight = new Map<string, Promise<void>>();
  private active = 0;
  private dropped = 0;
  private coalesced = 0;
  private scheduled = 0;
  constructor(private readonly opts: WarmQueueOptions) {}

  /**
   * Schedule a warm for `key`. If one is already in flight for `key`, COALESCE
   * (no-op, stampede protection). If active >= capacity, DROP + count. Otherwise
   * run async; the result only updates the cache — it never reaches served output.
   */
  schedule(key: string, task: () => Promise<void>): void {
    if (this.inflight.has(key)) {
      this.coalesced++;
      return;
    }
    if (this.active >= this.opts.maxConcurrent + this.opts.maxQueued) {
      this.dropped++;
      return;
    }
    this.scheduled++;
    this.active++;
    const p = task()
      .catch(() => undefined) // a warm failure is invisible to serving
      .finally(() => {
        this.active--;
        this.inflight.delete(key);
      });
    this.inflight.set(key, p);
  }

  /** Test/shutdown aid: await all in-flight warms. */
  async drain(): Promise<void> {
    await Promise.all([...this.inflight.values()]);
  }

  stats(): { active: number; inflight: number; dropped: number; coalesced: number; scheduled: number } {
    return { active: this.active, inflight: this.inflight.size, dropped: this.dropped, coalesced: this.coalesced, scheduled: this.scheduled };
  }
}
