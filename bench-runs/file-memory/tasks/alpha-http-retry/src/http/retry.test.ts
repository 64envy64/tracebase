import { describe, it, expect } from "vitest";
import { computeBackoff, withRetry } from "./retry";
import type { RetryConfig } from "./types";

const cfg: RetryConfig = { maxAttempts: 4, baseDelayMs: 100, factor: 2 };

describe("computeBackoff", () => {
  it("doubles delay with factor=2 (100, 200, 400, 800)", () => {
    expect(computeBackoff(0, cfg)).toBe(100);
    expect(computeBackoff(1, cfg)).toBe(200);
    expect(computeBackoff(2, cfg)).toBe(400);
    expect(computeBackoff(3, cfg)).toBe(800);
  });

  it("respects maxDelayMs clamp", () => {
    const capped: RetryConfig = { ...cfg, maxDelayMs: 250 };
    expect(computeBackoff(0, capped)).toBe(100);
    expect(computeBackoff(1, capped)).toBe(200);
    expect(computeBackoff(2, capped)).toBe(250); // would be 400, clamped to 250
    expect(computeBackoff(3, capped)).toBe(250);
  });

  it("supports factor=3 (100, 300, 900)", () => {
    const c3: RetryConfig = { ...cfg, factor: 3 };
    expect(computeBackoff(0, c3)).toBe(100);
    expect(computeBackoff(1, c3)).toBe(300);
    expect(computeBackoff(2, c3)).toBe(900);
  });
});

describe("withRetry — delays grow per attempt", () => {
  it("records growing delays between attempts", async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls < 3) throw new Error("flaky");
      return "ok";
    };
    const noSleep = async (_ms: number) => {};
    const r = await withRetry(fn, cfg, noSleep);
    expect(r.value).toBe("ok");
    expect(r.attempts).toBe(3);
    expect(r.delays).toEqual([100, 200]); // delay before attempt 1, before attempt 2
  });
});
