import { describe, it, expect } from "vitest";
import { Server } from "../src/server.js";

describe("auth middleware under realistic traffic", () => {
  it("keeps an active session alive across bursts of new sessions", () => {
    const s = new Server(3); // session cache holds 3
    s.sessions.create("hot", "user-hot", ["editor"]);
    s.sessions.create("a", "user-a", ["viewer"]);
    s.sessions.create("b", "user-b", ["viewer"]);

    // 'hot' is the active session; the user touches it on every request.
    // Between each pair of new sessions, we hit 'hot' twice.
    s.middleware.check("hot", "read");
    s.sessions.create("c", "user-c", ["viewer"]);
    s.middleware.check("hot", "read");
    s.sessions.create("d", "user-d", ["viewer"]);
    s.middleware.check("hot", "read");
    s.sessions.create("e", "user-e", ["viewer"]);
    s.middleware.check("hot", "read");

    expect(s.sessions.has("hot")).toBe(true);
  });

  it("middleware returns ok=true while the hot session remains resident", () => {
    const s = new Server(2);
    s.sessions.create("hot", "user-hot", ["editor"]);
    s.sessions.create("x", "user-x", ["viewer"]);

    s.middleware.check("hot", "read"); // touch hot
    s.sessions.create("y", "user-y", ["viewer"]); // should evict x, not hot

    const r = s.middleware.check("hot", "write");
    expect(r.ok).toBe(true);
    expect(r.userId).toBe("user-hot");
  });

  it("permission table itself is correct (sanity / red-herring check)", () => {
    const s = new Server(2);
    s.sessions.create("u", "u-1", ["viewer"]);
    expect(s.middleware.check("u", "read").ok).toBe(true);
    expect(s.middleware.check("u", "write").ok).toBe(false);
  });
});
