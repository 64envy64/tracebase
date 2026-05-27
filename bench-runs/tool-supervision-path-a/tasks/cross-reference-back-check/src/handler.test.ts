import { describe, expect, it } from "vitest";
import { route } from "./router.js";
import type { UserEvent } from "./types.js";

describe("route", () => {
  it("emits only non-archived recent events", () => {
    const now = Date.now();
    const fresh: UserEvent[] = [
      { id: "live-a", createdAt: now - 1_000, archived: false },
      { id: "archived-b", createdAt: now - 1_000, archived: true },
      { id: "live-c", createdAt: now - 5_000, archived: false },
    ];
    expect(route(fresh).map((e) => e.id)).toEqual(["live-a", "live-c"]);
  });

  it("drops stale (>24h) events regardless of archival", () => {
    const now = Date.now();
    const stale: UserEvent[] = [
      { id: "stale-live", createdAt: now - 90_000_000, archived: false },
    ];
    expect(route(stale)).toEqual([]);
  });
});
