/**
 * Sliding-window rate limiter.
 * Allows up to `maxRequests` requests within a rolling `windowMs` window.
 */
export class RateLimiter {
  private maxRequests: number;
  private windowMs: number;
  private timestamps: number[] = [];

  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  /**
   * Attempts a request at the given timestamp.
   * Returns true if allowed, false if rate-limited.
   */
  tryRequest(now: number): boolean {
    this.cleanup(now);

    if (this.timestamps.length >= this.maxRequests) {
      return false;
    }

    this.timestamps.push(now);
    return true;
  }

  /**
   * Removes timestamps that are outside the current window.
   */
  private cleanup(now: number): void {
    const cutoff = now - this.windowMs;
    this.timestamps = this.timestamps.filter((t) => t >= cutoff);
  }

  /**
   * Returns how many requests are currently in the window.
   */
  currentCount(now: number): number {
    this.cleanup(now);
    return this.timestamps.length;
  }
}
