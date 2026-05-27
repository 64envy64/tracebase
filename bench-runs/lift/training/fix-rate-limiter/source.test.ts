import { describe, it, expect } from 'vitest';
import { RateLimiter } from './source';

describe('RateLimiter', () => {
  it('allows requests under the limit', () => {
    const limiter = new RateLimiter(3, 1000);
    expect(limiter.tryRequest(0)).toBe(true);
    expect(limiter.tryRequest(100)).toBe(true);
    expect(limiter.tryRequest(200)).toBe(true);
  });

  it('blocks requests over the limit within the window', () => {
    const limiter = new RateLimiter(2, 1000);
    expect(limiter.tryRequest(0)).toBe(true);
    expect(limiter.tryRequest(100)).toBe(true);
    expect(limiter.tryRequest(200)).toBe(false);
  });

  it('allows new requests after the window has fully elapsed', () => {
    const limiter = new RateLimiter(2, 1000);
    expect(limiter.tryRequest(0)).toBe(true);
    expect(limiter.tryRequest(100)).toBe(true);
    expect(limiter.tryRequest(200)).toBe(false);
    // At t=1001, the request at t=0 should have expired
    expect(limiter.tryRequest(1001)).toBe(true);
  });

  it('does not allow burst at exact window boundary', () => {
    const limiter = new RateLimiter(2, 1000);
    // Fill the window
    expect(limiter.tryRequest(0)).toBe(true);
    expect(limiter.tryRequest(500)).toBe(true);
    // At t=1000, the request at t=0 is exactly 1000ms ago.
    // It should still be within the window (the window is 1000ms inclusive).
    expect(limiter.tryRequest(1000)).toBe(false);
  });

  it('tracks current count correctly', () => {
    const limiter = new RateLimiter(5, 1000);
    limiter.tryRequest(0);
    limiter.tryRequest(300);
    limiter.tryRequest(600);
    expect(limiter.currentCount(600)).toBe(3);
    // At t=1000, request at t=0 should still be in window
    expect(limiter.currentCount(1000)).toBe(3);
  });
});
