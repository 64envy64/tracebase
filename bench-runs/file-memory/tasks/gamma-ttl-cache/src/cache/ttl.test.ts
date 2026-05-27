import { describe, it, expect } from "vitest";
import { TtlCache } from "./ttl";

describe("TtlCache", () => {
  it("returns value before TTL expires", () => {
    let t = 0;
    const c = new TtlCache<string, string>(10, () => t);
    c.set("a", "v1", 1000);
    t = 500;
    expect(c.get("a")).toBe("v1");
  });

  it("treats expired entries as absent on get", () => {
    let t = 0;
    const c = new TtlCache<string, string>(10, () => t);
    c.set("a", "v1", 1000);
    t = 1500;
    expect(c.get("a")).toBeUndefined();
  });

  it("does NOT leak memory under write-only steady stream of expired entries", () => {
    let t = 0;
    const c = new TtlCache<string, string>(100, () => t);

    // Write 1000 entries each with TTL=10ms, advancing the clock by 20ms
    // between writes. Every entry is expired by the next write.
    // After 1000 writes, the live-key count should be at most 1
    // (the very last write). If the cache leaks (set never reaps),
    // size will pile up to capacity (100) or more.
    for (let i = 0; i < 1000; i++) {
      c.set(`k${i}`, `v${i}`, 10);
      t += 20;
    }

    expect(c.size()).toBeLessThanOrEqual(1);
  });

  it("set respects capacity even when reaping is active", () => {
    let t = 0;
    const c = new TtlCache<string, string>(5, () => t);
    // 10 long-TTL entries; only last 5 should remain
    for (let i = 0; i < 10; i++) c.set(`k${i}`, `v${i}`, 60_000);
    expect(c.size()).toBe(5);
  });
});
