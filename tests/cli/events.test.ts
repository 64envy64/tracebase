import { describe, it, expect } from "vitest";
import { parseSince } from "../../src/cli/commands/events.js";

describe("parseSince", () => {
  const now = 1_718_400_000_000; // fixed "now" for determinism

  it("parses relative shorthand: seconds / minutes / hours / days / weeks", () => {
    expect(parseSince("30s", now)).toBe(now - 30 * 1000);
    expect(parseSince("15m", now)).toBe(now - 15 * 60_000);
    expect(parseSince("2h", now)).toBe(now - 2 * 3_600_000);
    expect(parseSince("7d", now)).toBe(now - 7 * 86_400_000);
    expect(parseSince("2w", now)).toBe(now - 2 * 604_800_000);
  });

  it("accepts upper/lower-case units and internal whitespace", () => {
    expect(parseSince("3H", now)).toBe(now - 3 * 3_600_000);
    expect(parseSince("5 d", now)).toBe(now - 5 * 86_400_000);
  });

  it("parses raw epoch ms (≥ 10 digits)", () => {
    expect(parseSince("1700000000000", now)).toBe(1700000000000);
  });

  it("parses ISO-8601 timestamps", () => {
    const iso = "2026-01-15T00:00:00.000Z";
    expect(parseSince(iso, now)).toBe(Date.parse(iso));
  });

  it("throws on unrecognized input", () => {
    expect(() => parseSince("not-a-date", now)).toThrow(/unrecognized/);
    expect(() => parseSince("", now)).toThrow();
    // Short digit run is ambiguous — we require ≥ 10 for epoch ms.
    expect(() => parseSince("123", now)).toThrow();
  });
});
